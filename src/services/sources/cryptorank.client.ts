import { cryptorank } from '../../config/env';
import { fetchJson } from './http';
import type { SaleStatus, IcoRawProject } from '../ico-intelligence/ico.types';

// ─────────────────────────────────────────────────────────────────────────────
// CryptoRank v3 collector — tracked-by-ID (free-plan compatible).
//
// v3's bulk ICO/funding list (/funding-rounds/map) is paywalled, so we TRACK
// specific projects: resolve a slug/id via /currencies/map, then enrich from
// /currencies/{id}. Funding/backers/vesting are NOT on the free plan (404/403) —
// they come through as unavailable and surface as red flags, never fabricated.
//
// Documented, key-based API (X-Api-Key). Skipped gracefully with no key.
// Research data only, never financial advice.
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MIN_GAP_MS = 300;
let lastAt = 0;
const throttle = async () => {
  const wait = MIN_GAP_MS - (Date.now() - lastAt);
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
};

const get = async <T>(path: string): Promise<T | null> => {
  if (!cryptorank.configured) return null;
  await throttle();
  try {
    return await fetchJson<T>(`${cryptorank.baseUrl}${path}`, { headers: { 'X-Api-Key': cryptorank.apiKey }, label: 'cryptorank', retries: 1 });
  } catch {
    return null;
  }
};

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

const stripHtml = (s: string | null | undefined): string | null => {
  if (!s) return null;
  const t = String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return t || null;
};

// ── Currency map (slug/id/symbol → entry). Cached; one call powers resolution. ──
export interface CrMapEntry { id: number; slug: string; symbol: string; name: string }
let mapCache: { at: number; byId: Map<number, CrMapEntry>; bySlug: Map<string, CrMapEntry>; bySymbol: Map<string, CrMapEntry> } | null = null;
const MAP_TTL_MS = 30 * 60 * 1000;

const getMap = async () => {
  if (mapCache && Date.now() - mapCache.at < MAP_TTL_MS) return mapCache;
  const res = await get<{ data: CrMapEntry[] }>('/currencies/map');
  const rows = res?.data ?? [];
  const byId = new Map<number, CrMapEntry>();
  const bySlug = new Map<string, CrMapEntry>();
  const bySymbol = new Map<string, CrMapEntry>();
  for (const r of rows) {
    byId.set(r.id, r);
    if (r.slug) bySlug.set(r.slug.toLowerCase(), r);
    if (r.symbol) bySymbol.set(r.symbol.toUpperCase(), r);
  }
  mapCache = { at: Date.now(), byId, bySlug, bySymbol };
  return mapCache;
};

/** Resolve a user-supplied ref (numeric id, slug, or symbol) → a map entry. */
export const resolveRef = async (ref: string): Promise<CrMapEntry | null> => {
  const m = await getMap();
  const r = ref.trim();
  if (/^\d+$/.test(r)) return m.byId.get(Number(r)) ?? { id: Number(r), slug: '', symbol: '', name: '' };
  return m.bySlug.get(r.toLowerCase()) ?? m.bySymbol.get(r.toUpperCase()) ?? null;
};

// ── Detail → IcoRawProject ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const linkArr = (links: any): { type: string; url: string }[] =>
  Array.isArray(links) ? links.map((l) => ({ type: String(l?.type ?? '').toLowerCase(), url: String(l?.url ?? l?.value ?? '') })).filter((l) => l.type && l.url) : [];

const pickLink = (links: { type: string; url: string }[], ...types: string[]): string | null => {
  for (const t of types) {
    const hit = links.find((l) => l.type === t);
    if (hit) return hit.url;
  }
  return null;
};

const lifecycleToStatus = (lc: string | null | undefined): SaleStatus => {
  const v = String(lc ?? '').toLowerCase();
  if (/upcoming|announced|soon/.test(v)) return 'upcoming';
  if (/ico|ido|ieo|crowdsale|funding|sale|active/.test(v)) return 'active';
  if (/traded|listed|inactive|dead|ended/.test(v)) return 'ended';
  return 'unknown';
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const normalize = (d: any): IcoRawProject | null => {
  if (!d?.name) return null;
  const links = linkArr(d.links);
  const socialTypes = ['twitter', 'telegram', 'discord', 'reddit', 'medium', 'github', 'youtube', 'facebook', 'linkedin', 'announcement'];
  const social_links: Record<string, string> = {};
  for (const t of socialTypes) {
    const u = pickLink(links, t);
    if (u) social_links[t] = u;
  }
  const tags: string[] = Array.isArray(d.tags) ? d.tags.map((t: { name?: string }) => t?.name).filter(Boolean) : [];
  const tokenomics: Record<string, unknown> = {};
  if (num(d.totalSupply) != null) tokenomics.total_supply = num(d.totalSupply);
  if (num(d.maxSupply) != null) tokenomics.max_supply = num(d.maxSupply);
  if (num(d.circulatingSupply) != null) tokenomics.circulating_supply = num(d.circulatingSupply);
  if (num(d.fullyDilutedValuation) != null) tokenomics.fully_diluted_valuation = num(d.fullyDilutedValuation);

  return {
    project_name: String(d.name).trim(),
    token_symbol: d.symbol ?? null,
    image_url: d.imageUrl ?? null,
    category: d.category?.name ?? tags[0] ?? null,
    sale_status: lifecycleToStatus(d.lifecycle),
    sale_type: d.type ?? null,
    sale_date: d.listingDate ?? null,
    raise_amount_text: null, // funding not available on the free plan
    raise_amount: null,
    backers: [], // /funding-rounds is paywalled — no backers on the free plan
    website: pickLink(links, 'web', 'website', 'homepage'),
    whitepaper_url: pickLink(links, 'whitepaper', 'paper', 'docs', 'documentation'),
    social_links,
    description: stripHtml(d.description),
    tokenomics,
    vesting: {}, // vesting not available on the free plan
    rounds: [], // funding rounds are paywalled on the free plan
    rank: typeof d.rank === 'number' ? d.rank : null,
    source_url: d.slug ? `https://cryptorank.io/price/${d.slug}` : null
  };
};

/** Enrich a set of tracked CryptoRank ids → scored-ready raw projects. */
export const collectCryptorankProjects = async (ids: number[]): Promise<IcoRawProject[]> => {
  if (!cryptorank.configured || !ids.length) return [];
  const out: IcoRawProject[] = [];
  for (const id of ids) {
    const res = await get<{ data: unknown }>(`/currencies/${id}`);
    const p = res?.data ? normalize(res.data) : null;
    if (p) out.push(p);
  }
  return out;
};

export const cryptorankSourceStatus = () => ({
  enabled: cryptorank.configured,
  base_url: cryptorank.baseUrl,
  mode: 'tracked-by-id'
});
