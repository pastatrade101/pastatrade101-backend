import { load } from 'cheerio';
import { icodrops } from '../../config/env';
import { fetchJson, fetchText } from './http';
import type { SaleStatus, IcoRawProject, IcoCollectResult } from '../ico-intelligence/ico.types';

// Re-exported so existing importers (icoScoring, icoIntelligence) keep working.
export type { SaleStatus, IcoRawProject, IcoCollectResult } from '../ico-intelligence/ico.types';

// ─────────────────────────────────────────────────────────────────────────────
// ICO Drops collector — ONE raw source for the Early Project Radar.
//
// Compliance + safety, in order:
//   1. Disabled unless ICODROPS_ENABLED=true (no scraping happens by default).
//   2. robots.txt is fetched + honoured at runtime before any path is requested.
//   3. Rate limited (min gap between requests) + short in-memory cache.
//   4. API-first (ICODROPS_API_URL) — HTML fallback only when no API is set.
//   5. Every failure is graceful → returns [] so the sync never breaks.
//
// Research data only, never financial advice.
// ─────────────────────────────────────────────────────────────────────────────

const UA = 'Pastatrade101-Radar/1.0 (+https://pastatrade101.com; research)';
const MIN_REQUEST_GAP_MS = 3000; // polite rate limit
const CACHE_TTL_MS = 10 * 60 * 1000;
const ICO_ENRICH_LIMIT = 60; // max detail pages to fetch per sync (politeness bound)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Rate limiter (sequential-safe token) ──
let lastRequestAt = 0;
const throttle = async () => {
  const wait = MIN_REQUEST_GAP_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
};

// ── Tiny TTL cache ──
const cache = new Map<string, { at: number; value: unknown }>();
const cached = <T>(key: string): T | null => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
  return null;
};
const putCache = (key: string, value: unknown) => cache.set(key, { at: Date.now(), value });

// ── robots.txt (runtime compliance) ──────────────────────────────────────────
// Minimal parser: collects Disallow/Allow for the `*` group (and our UA), then
// longest-match decides. Fetch semantics follow common crawler convention:
//   2xx → parse rules · 4xx (incl. 404) → allow all · 5xx/unreachable → deny (safe).
interface RobotsRules {
  allow: string[];
  disallow: string[];
  mode: 'rules' | 'allow-all' | 'deny';
}
let robotsCache: { at: number; rules: RobotsRules } | null = null;

const parseRobots = (txt: string): RobotsRules => {
  const lines = txt.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim());
  const groups: { agents: string[]; allow: string[]; disallow: string[] }[] = [];
  let current: { agents: string[]; allow: string[]; disallow: string[] } | null = null;
  let lastWasAgent = false;
  for (const line of lines) {
    const [rawKey, ...rest] = line.split(':');
    if (!rawKey || !rest.length) continue;
    const key = rawKey.toLowerCase().trim();
    const value = rest.join(':').trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (current && (key === 'allow' || key === 'disallow')) {
      lastWasAgent = false;
      if (key === 'allow') current.allow.push(value);
      else current.disallow.push(value);
    }
  }
  const applies = (g: { agents: string[] }) => g.agents.some((a) => a === '*' || UA.toLowerCase().includes(a));
  const relevant = groups.filter(applies);
  if (!relevant.length) return { allow: [], disallow: [], mode: 'allow-all' };
  return {
    allow: relevant.flatMap((g) => g.allow).filter(Boolean),
    disallow: relevant.flatMap((g) => g.disallow).filter(Boolean),
    mode: 'rules'
  };
};

const getRobots = async (): Promise<RobotsRules> => {
  if (robotsCache && Date.now() - robotsCache.at < CACHE_TTL_MS) return robotsCache.rules;
  let rules: RobotsRules;
  try {
    const res = await fetch(`${icodrops.baseUrl}/robots.txt`, { headers: { 'user-agent': UA } });
    if (res.ok) rules = parseRobots(await res.text());
    else if (res.status >= 400 && res.status < 500) rules = { allow: [], disallow: [], mode: 'allow-all' };
    else rules = { allow: [], disallow: [], mode: 'deny' };
  } catch {
    rules = { allow: [], disallow: [], mode: 'deny' };
  }
  robotsCache = { at: Date.now(), rules };
  return rules;
};

/** Is `path` (e.g. "/category/active") crawlable per robots.txt right now? */
export const robotsAllows = async (path: string): Promise<boolean> => {
  const rules = await getRobots();
  if (rules.mode === 'allow-all') return true;
  if (rules.mode === 'deny') return false;
  const match = (list: string[]) => list.filter((p) => path.startsWith(p)).reduce((best, p) => (p.length > best ? p.length : best), -1);
  const dis = match(rules.disallow);
  if (dis < 0) return true; // not disallowed
  const alw = match(rules.allow);
  return alw >= dis; // an equal/longer Allow wins
};

// ── Normalization helpers ──
const parseRaise = (text: string | null): number | null => {
  if (!text) return null;
  const m = text.replace(/,/g, '').match(/\$?\s*([\d.]+)\s*([kmb])?/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? '').toLowerCase()] ?? 1;
  return Math.round(n * mult);
};

const asStatus = (s: unknown): SaleStatus => {
  const v = String(s ?? '').toLowerCase();
  if (/active|live|ongoing|ico/.test(v)) return 'active';
  if (/upcoming|soon|announced|pre/.test(v)) return 'upcoming';
  if (/ended|end|closed|past|finished/.test(v)) return 'ended';
  return 'unknown';
};

// Defensive normalizer for an API record of unknown shape — reads the field names
// ICO-style APIs commonly use, and never throws.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const normalizeApiRecord = (r: any, fallbackStatus: SaleStatus): IcoRawProject | null => {
  const name = r?.name ?? r?.project_name ?? r?.title ?? null;
  if (!name) return null;
  const raiseText = r?.raise ?? r?.raised ?? r?.hardcap ?? r?.total_raised ?? null;
  const socials = r?.social_links ?? r?.socials ?? r?.links ?? {};
  return {
    project_name: String(name).trim(),
    token_symbol: r?.symbol ?? r?.ticker ?? r?.token_symbol ?? null,
    category: r?.category ?? r?.categories?.[0] ?? r?.niche ?? null,
    sale_status: asStatus(r?.status ?? r?.sale_status ?? fallbackStatus),
    sale_type: r?.sale_type ?? r?.launchpad ?? r?.type ?? null,
    sale_date: r?.sale_date ?? r?.date ?? r?.start_date ?? null,
    raise_amount_text: raiseText != null ? String(raiseText) : null,
    raise_amount: parseRaise(raiseText != null ? String(raiseText) : null),
    backers: Array.isArray(r?.backers) ? r.backers.map((b: unknown) => (typeof b === 'string' ? b : (b as any)?.name)).filter(Boolean) : [],
    website: r?.website ?? r?.url ?? null,
    whitepaper_url: r?.whitepaper ?? r?.whitepaper_url ?? r?.docs ?? null,
    social_links: typeof socials === 'object' && socials ? socials : {},
    description: r?.description ?? r?.about ?? null,
    tokenomics: r?.tokenomics ?? {},
    vesting: r?.vesting ?? r?.unlock ?? {},
    source_url: r?.source_url ?? r?.link ?? (r?.slug ? `${icodrops.baseUrl}/${r.slug}/` : null)
  };
};

// ── Public collector ─────────────────────────────────────────────────────────
/**
 * Collect ICO projects. API-first; HTML fallback is a documented stub (needs
 * live selectors — see below) and returns nothing until implemented against the
 * real markup. Fully graceful + compliant.
 */
export const collectIcoProjects = async (): Promise<IcoCollectResult> => {
  if (!icodrops.enabled) return { projects: [], status: 'disabled', detail: 'ICODROPS_ENABLED is not set — collector is off.' };

  // API-first.
  if (icodrops.hasApi) {
    const cacheKey = `api:${icodrops.apiUrl}`;
    const hit = cached<IcoRawProject[]>(cacheKey);
    if (hit) return { projects: hit, status: 'ok', detail: 'served from cache' };
    try {
      await throttle();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await fetchJson<any>(icodrops.apiUrl, { headers: { 'user-agent': UA }, label: 'icodrops-api', retries: 1 });
      const rows: unknown[] = Array.isArray(data) ? data : (data?.data ?? data?.items ?? data?.results ?? []);
      const projects = rows.map((r) => normalizeApiRecord(r, 'unknown')).filter((p): p is IcoRawProject => p != null);
      putCache(cacheKey, projects);
      return { projects, status: 'ok', detail: `api returned ${projects.length} projects` };
    } catch (e) {
      return { projects: [], status: 'error', detail: e instanceof Error ? e.message : 'api fetch failed' };
    }
  }

  // HTML collector — the homepage is server-rendered with the full Active/Upcoming/
  // Ended columns, so one robots-checked fetch yields the whole list.
  if (!(await robotsAllows('/'))) {
    return { projects: [], status: 'blocked-by-robots', detail: 'robots.txt disallows /' };
  }
  await throttle();
  const html = await fetchText(`${icodrops.baseUrl}/`, { headers: { 'user-agent': UA } });
  if (!html) return { projects: [], status: 'error', detail: 'homepage fetch failed' };
  const projects = parseListingHtml(html);

  // Enrich each project from its detail page — this is where backers, website,
  // socials, tokenomics and vesting live. Robots-checked + throttled; bounded so
  // one sync stays polite. Best-effort per project (failures leave listing data).
  let enriched = 0;
  for (const p of projects.slice(0, ICO_ENRICH_LIMIT)) {
    if (!p.source_url) continue;
    const path = p.source_url.replace(icodrops.baseUrl, '') || '/';
    if (!(await robotsAllows(path))) continue;
    await throttle();
    const dhtml = await fetchText(p.source_url, { headers: { 'user-agent': UA } });
    if (!dhtml) continue;
    const d = parseDetailHtml(dhtml);
    if (d.backers?.length) p.backers = d.backers;
    if (d.website) p.website = d.website;
    if (d.whitepaper_url) p.whitepaper_url = d.whitepaper_url;
    if (d.social_links && Object.keys(d.social_links).length) p.social_links = d.social_links;
    if (d.description) p.description = d.description;
    if (d.raise_amount != null) {
      p.raise_amount = d.raise_amount;
      if (d.raise_amount_text) p.raise_amount_text = d.raise_amount_text;
    }
    if (d.tokenomics && Object.keys(d.tokenomics).length) p.tokenomics = d.tokenomics;
    if (d.vesting && Object.keys(d.vesting).length) p.vesting = d.vesting;
    enriched += 1;
  }
  return { projects, status: projects.length ? 'ok' : 'no-source', detail: `html parsed ${projects.length} projects, enriched ${enriched}` };
};

// Parse the ICO Drops homepage columns (Active / Upcoming / Ended) into projects.
// Listing-level: name, ticker, category, status, sale type, raise, source link.
// (Backer names, website, tokenomics, vesting live on each project's detail page —
// see enrichIcoDetail below.)
const RAISE_RE = /\$\s*([\d.]+)\s*([KMB])/i;
export const parseListingHtml = (html: string): IcoRawProject[] => {
  const $ = load(html);
  const out: IcoRawProject[] = [];
  $('.All-Projects__column').each((_, col) => {
    const status = ((($(col).find('.All-Projects__title').text() || '').toLowerCase().match(/active|upcoming|ended/) || ['unknown'])[0]) as SaleStatus;
    $(col).find('.Project-Card').each((__, c) => {
      const card = $(c);
      const name = card.find('.Project-Card__name').clone().children().remove().end().text().replace(/\s+/g, ' ').trim();
      if (!name) return;
      const text = card.text().replace(/\s+/g, ' ').trim();
      const rm = text.match(RAISE_RE);
      const raise_amount = rm ? Math.round(Number(rm[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[rm[2].toLowerCase()] ?? 1)) : null;
      const href = card.closest('a').attr('href') || card.find('a').attr('href') || '';
      const source_url = href ? (href.startsWith('http') ? href : `${icodrops.baseUrl}${href}`) : null;
      out.push({
        project_name: name,
        token_symbol: card.find('.Project-Card__ticker').text().trim() || null,
        category: card.find('.Project-Card__type').text().trim() || null,
        sale_status: status,
        sale_type: card.find('.Project-Card__label, .List-Labels').first().text().replace(/\s+/g, ' ').trim() || null,
        sale_date: null,
        raise_amount_text: rm ? rm[0].replace(/\s+/g, '') : null,
        raise_amount,
        backers: [], // names are on the detail page
        website: null,
        whitepaper_url: null,
        social_links: {},
        description: null,
        tokenomics: {},
        vesting: {},
        source_url
      });
    });
  });
  return out;
};

// Classify a project's external links into website / whitepaper / socials.
const classifyLinks = (urls: string[]): { website: string | null; whitepaper: string | null; social: Record<string, string> } => {
  const social: Record<string, string> = {};
  let website: string | null = null;
  let whitepaper: string | null = null;
  for (const u of urls) {
    if (/x\.com|twitter\.com/i.test(u)) social.twitter ??= u;
    else if (/t\.me|telegram\.org/i.test(u)) social.telegram ??= u;
    else if (/discord/i.test(u)) social.discord ??= u;
    else if (/medium\.com/i.test(u)) social.medium ??= u;
    else if (/github\.com/i.test(u)) social.github ??= u;
    else if (/youtube\.com|youtu\.be/i.test(u)) social.youtube ??= u;
    else if (/reddit\.com/i.test(u)) social.reddit ??= u;
    else if (/linkedin\.com/i.test(u)) social.linkedin ??= u;
    else if (/docs\.|whitepaper|gitbook|\/docs/i.test(u)) whitepaper ??= u;
    else if (!/icodrops|dropstab|dropsearn|dropscapital|legion\.cc|sale\./i.test(u)) website ??= u;
  }
  return { website, whitepaper, social };
};

// Parse a project's DETAIL page — the valuable fields: backers, website, docs,
// socials, raise, token type, and a best-effort vesting/distribution note.
export const parseDetailHtml = (html: string): Partial<IcoRawProject> => {
  const $ = load(html);
  const uniq = (a: string[]) => [...new Set(a.filter(Boolean))];
  const backers = uniq([
    ...$('.Rounds-Card-Info-Block__investor-name').map((_, e) => $(e).text().trim()).get(),
    ...$('.Overview-Section-Info-List__main-investor-name').map((_, e) => $(e).text().trim()).get()
  ]).slice(0, 25);
  const urls = uniq($('a[href^="http"]').map((_, e) => $(e).attr('href') ?? '').get());
  const { website, whitepaper, social } = classifyLinks(urls);
  const text = $('body').text().replace(/\s+/g, ' ');
  const rm = text.match(/Raised\s*\$?\s*([\d.]+)\s*([KMB])/i);
  const raise_amount = rm ? Math.round(Number(rm[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[rm[2].toLowerCase()] ?? 1)) : null;
  const tokenType = text.match(/Token Type\s*([A-Za-z0-9]{2,12})/);
  // Vesting only when a real vesting/unlock section exists (avoids capturing noise).
  const vestRaw = $('[class*="Distribution"], [class*="Vesting"], [class*="Unlock"]').first().text().replace(/\s+/g, ' ').trim();
  const hasVesting = /vest|unlock|cliff|tge|lockup|lock-up/i.test(vestRaw);
  return {
    backers,
    website,
    whitepaper_url: whitepaper,
    social_links: social,
    description: $('meta[name="description"]').attr('content')?.trim() || undefined,
    raise_amount: raise_amount ?? undefined,
    raise_amount_text: rm ? `$${rm[1]}${rm[2].toUpperCase()}` : undefined,
    tokenomics: tokenType ? { token_type: tokenType[1].trim() } : undefined,
    vesting: hasVesting ? { note: vestRaw.slice(0, 280) } : undefined
  };
};

export const icoSourceStatus = () => ({
  enabled: icodrops.enabled,
  mode: icodrops.hasApi ? 'api' : 'html',
  base_url: icodrops.baseUrl,
  has_api: icodrops.hasApi
});
