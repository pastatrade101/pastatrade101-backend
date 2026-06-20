import { supabase } from '../../config/supabase';
import { readLatestSocialRisk } from '../social/social-latest.service';

// ─────────────────────────────────────────────────────────────────────────────
// Overview aggregator — turns the platform's stored daily reads into a plain-
// language "what is the market telling me today?" command-center payload.
// Reads STORED latest values (fast) rather than recomputing heavy models, so it
// is safe to hit on every dashboard load.
// ─────────────────────────────────────────────────────────────────────────────

const STABLES = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'USDD', 'FDUSD', 'USDE', 'PYUSD', 'USDS', 'GUSD', 'USDP', 'EURT']);
const MIN_VOL = 10_000_000; // clean-universe 24h volume floor

export type Universe = 'clean' | 'all';

interface Signal {
  key: string;
  name: string;
  label: string;
  value: string | null;
  meaning: string;
  tone: 'good' | 'neutral' | 'warn' | 'danger' | 'na';
  link: string;
}

const pct1 = (n: number | null | undefined) => (n == null ? '—' : `${Number(n).toFixed(1)}%`);
const ago = (iso: string | null | undefined): string => {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
};
const isStale = (iso: string | null | undefined, hours = 24) => !iso || Date.now() - Date.parse(iso) > hours * 3600_000;

// ── Signal builders ──
const btcRiskSignal = (r: number | null): Signal => {
  if (r == null) return { key: 'btc_risk', name: 'BTC Risk', label: 'Unavailable', value: null, meaning: 'Run a risk sync to populate BTC risk.', tone: 'na', link: '/app/risk' };
  const v = `${Math.round(r * 100)}/100`;
  if (r < 0.35) return { key: 'btc_risk', name: 'BTC Risk', label: 'Good DCA zone', value: v, meaning: 'BTC is not overheated on the current risk model.', tone: 'good', link: '/app/risk' };
  if (r < 0.55) return { key: 'btc_risk', name: 'BTC Risk', label: 'Neutral', value: v, meaning: 'BTC risk is moderate — neither cheap nor stretched.', tone: 'neutral', link: '/app/risk' };
  if (r < 0.75) return { key: 'btc_risk', name: 'BTC Risk', label: 'Caution', value: v, meaning: 'BTC risk is rising — be more selective.', tone: 'warn', link: '/app/risk' };
  return { key: 'btc_risk', name: 'BTC Risk', label: 'Distribution risk', value: v, meaning: 'BTC risk is high on this model.', tone: 'danger', link: '/app/risk' };
};

const breadthSignal = (pct: number | null): Signal => {
  if (pct == null) return { key: 'altcoin_breadth', name: 'Altcoin Breadth', label: 'Unavailable', value: null, meaning: 'Altcoin breadth data is unavailable.', tone: 'na', link: '/app/altcoin-btc-lab' };
  const v = `${pct}% beating BTC (24h)`;
  if (pct < 33) return { key: 'altcoin_breadth', name: 'Altcoin Breadth', label: 'BTC-led market', value: v, meaning: 'Few altcoins are outperforming Bitcoin — BTC controls direction.', tone: 'neutral', link: '/app/altcoin-btc-lab' };
  if (pct < 55) return { key: 'altcoin_breadth', name: 'Altcoin Breadth', label: 'Selective strength', value: v, meaning: 'Some altcoins outperform BTC, but the move is not broad yet.', tone: 'warn', link: '/app/altcoin-btc-lab' };
  if (pct < 70) return { key: 'altcoin_breadth', name: 'Altcoin Breadth', label: 'Broadening', value: v, meaning: 'Altcoin strength is broadening against Bitcoin.', tone: 'good', link: '/app/altcoin-btc-lab' };
  return { key: 'altcoin_breadth', name: 'Altcoin Breadth', label: 'Broad strength', value: v, meaning: 'Most altcoins are outperforming BTC — broad risk-on.', tone: 'good', link: '/app/altcoin-btc-lab' };
};

const socialSignal = (score: number | null, label: string, status: string): Signal => {
  if (score == null) return { key: 'social_risk', name: 'Social Risk', label: 'Unavailable', value: null, meaning: 'Social metrics are not available.', tone: 'na', link: '/app/social-metrics' };
  const tone = score < 0.4 ? 'good' : score < 0.6 ? 'neutral' : score < 0.8 ? 'warn' : 'danger';
  const meaning = score < 0.4 ? 'Retail attention is quiet — not euphoric.' : score < 0.6 ? 'Crowd attention is present but not extreme.' : score < 0.8 ? 'Retail interest is rising.' : 'Crowd attention looks euphoric.';
  return { key: 'social_risk', name: 'Social Risk', label, value: `${score.toFixed(2)} (${status})`, meaning, tone, link: '/app/social-metrics' };
};

const exitSignal = (row: Record<string, unknown> | null): Signal => {
  if (!row) return { key: 'exit_strategy', name: 'Exit Signal', label: 'Unavailable', value: null, meaning: 'Run an exit-strategy sync to populate this.', tone: 'na', link: '/app/exit-strategy' };
  const label = (row.strategy_label as string) ?? 'Hold';
  const pctv = row.exit_risk_percent != null ? `${row.exit_risk_percent}/100` : null;
  const score = Number(row.exit_risk_score ?? 0);
  const tone = score < 0.5 ? 'good' : score < 0.75 ? 'warn' : 'danger';
  const meaning = score < 0.5 ? 'No major exit pressure yet.' : score < 0.75 ? 'Risk is rising — consider reducing aggressive buying.' : 'Scale-out pressure is increasing.';
  return { key: 'exit_strategy', name: 'Exit Signal', label, value: pctv, meaning, tone, link: '/app/exit-strategy' };
};

interface EcoRow { name: string; signal: string | null; metrics: { strength_score?: number } | null }
const ecosystemSignal = (ecos: EcoRow[]): Signal => {
  if (!ecos.length) return { key: 'ecosystem_rotation', name: 'Ecosystem Rotation', label: 'Unavailable', value: null, meaning: 'Ecosystem rankings are unavailable.', tone: 'na', link: '/app/ecosystems' };
  const improving = ecos.filter((e) => /improv|strength|expand|inflow|rising/i.test(e.signal ?? '') || (e.metrics?.strength_score ?? 0) >= 60).length;
  const total = ecos.length;
  const ratio = improving / total;
  const v = `${improving}/${total} improving`;
  if (ratio < 0.25) return { key: 'ecosystem_rotation', name: 'Ecosystem Rotation', label: 'Quiet', value: v, meaning: 'Few ecosystems are improving.', tone: 'neutral', link: '/app/ecosystems' };
  if (ratio < 0.5) return { key: 'ecosystem_rotation', name: 'Ecosystem Rotation', label: 'Selective', value: v, meaning: 'Only a few ecosystems are improving.', tone: 'warn', link: '/app/ecosystems' };
  return { key: 'ecosystem_rotation', name: 'Ecosystem Rotation', label: 'Broadening', value: v, meaning: 'Ecosystem strength is broadening.', tone: 'good', link: '/app/ecosystems' };
};

const liquiditySignal = (stablecoinCap: number | null): Signal => {
  if (stablecoinCap == null) return { key: 'stablecoin_liquidity', name: 'Stablecoin Liquidity', label: 'Unavailable', value: null, meaning: 'Stablecoin data unavailable.', tone: 'na', link: '/app/charts' };
  return { key: 'stablecoin_liquidity', name: 'Stablecoin Liquidity', label: 'Liquidity base', value: `$${(stablecoinCap / 1e9).toFixed(1)}B`, meaning: 'Large stablecoin supply — liquidity sitting on the sidelines.', tone: 'good', link: '/app/charts' };
};

const derivativesSignal = (row: { leverage_risk: number | null; label: string | null } | null): Signal => {
  if (!row || row.leverage_risk == null) return { key: 'derivatives', name: 'Leverage Risk', label: 'Unavailable', value: null, meaning: 'Run a derivatives sync to populate funding & positioning.', tone: 'na', link: '/app/derivatives' };
  const s = Number(row.leverage_risk);
  const tone = s < 0.4 ? 'good' : s < 0.6 ? 'neutral' : s < 0.75 ? 'warn' : 'danger';
  const meaning = s < 0.4 ? 'Funding & positioning are calm — leverage is not stretched.' : s < 0.6 ? 'Leverage is moderate.' : s < 0.75 ? 'Leverage is building — watch for over-extension.' : 'Crowded long leverage — a more fragile backdrop.';
  return { key: 'derivatives', name: 'Leverage Risk', label: row.label ?? '', value: `${Math.round(s * 100)}/100`, meaning, tone, link: '/app/derivatives' };
};

export interface OverviewOptions {
  universe?: Universe;
  isPaid?: boolean;
}

export const buildOverview = async (opts: OverviewOptions = {}) => {
  const universe: Universe = opts.universe ?? 'clean';
  const isPaid = opts.isPaid ?? true;

  const [{ data: globals }, { data: riskRow }, { data: exitRows }, social, { data: logregRow }, { data: ecos }, { data: coins }, { data: report }, { data: jobs }, { data: derivRow }] = await Promise.all([
    supabase.from('global_market_snapshots').select('*').order('captured_at', { ascending: false }).limit(2),
    supabase.from('risk_summary_daily').select('snapshot_date, summary_risk').order('snapshot_date', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('exit_strategy_daily').select('date, exit_risk_score, exit_risk_percent, strategy_label, confidence').order('date', { ascending: false }).limit(2),
    readLatestSocialRisk(),
    supabase.from('asset_log_regression_bands').select('date, zone_label, risk_score, distance_from_fit_percent').eq('asset_symbol', 'BTC').order('date', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('ecosystems').select('name, signal, metrics').eq('is_active', true),
    supabase.from('coins').select('coingecko_id, symbol, name, image_url, current_price, price_change_pct_24h, market_cap_rank, total_volume').lte('market_cap_rank', 150).not('price_change_pct_24h', 'is', null).order('market_cap_rank', { ascending: true }),
    supabase.from('reports').select('title, slug, report_type, market_status, premium_takeaway, published_at').eq('status', 'published').order('published_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('sync_jobs').select('source, job_type, status, finished_at').order('finished_at', { ascending: false }).limit(40),
    supabase.from('derivatives_daily').select('leverage_risk, label').order('date', { ascending: false }).limit(1).maybeSingle()
  ]);

  const global = globals?.[0];
  if (!global) throw new Error('NO_MARKET_DATA');
  const prev = globals?.[1] ?? null;
  const exitRow = exitRows?.[0] ?? null;
  const prevExit = exitRows?.[1] ?? null;

  // ── Altcoin breadth proxy: % of liquid top alts beating BTC over 24h ──
  const allCoins = (coins ?? []) as { coingecko_id: string; symbol: string; name: string; image_url: string | null; current_price: number; price_change_pct_24h: number; market_cap_rank: number; total_volume: number | null }[];
  const btc24 = allCoins.find((c) => c.coingecko_id === 'bitcoin')?.price_change_pct_24h ?? 0;
  const altUniverse = allCoins.filter((c) => c.coingecko_id !== 'bitcoin' && !STABLES.has(c.symbol.toUpperCase()) && !/wrapped|staked|peg/i.test(c.name));
  const breadthPct = altUniverse.length ? Math.round((altUniverse.filter((c) => c.price_change_pct_24h > btc24).length / altUniverse.length) * 100) : null;

  // ── Movers (clean vs all universe) ──
  const liquid = altUniverse.filter((c) => universe === 'all' || (c.total_volume ?? 0) >= MIN_VOL);
  const moverRow = (c: (typeof altUniverse)[number]) => ({
    coingecko_id: c.coingecko_id,
    symbol: c.symbol,
    name: c.name,
    image_url: c.image_url,
    current_price: c.current_price,
    price_change_pct_24h: c.price_change_pct_24h,
    total_volume: c.total_volume,
    low_liquidity: (c.total_volume ?? 0) < MIN_VOL,
    vs_btc: c.price_change_pct_24h > btc24 + 0.5 ? 'strong' : c.price_change_pct_24h < btc24 - 0.5 ? 'weak' : 'inline'
  });
  const top_gainers = [...liquid].sort((a, b) => b.price_change_pct_24h - a.price_change_pct_24h).slice(0, 6).map(moverRow);
  const top_losers = [...liquid].sort((a, b) => a.price_change_pct_24h - b.price_change_pct_24h).slice(0, 6).map(moverRow);

  // ── Signals ──
  const btcRisk = riskRow?.summary_risk == null ? null : Number(riskRow.summary_risk);
  const signals = {
    btc_risk: btcRiskSignal(btcRisk),
    altcoin_breadth: breadthSignal(breadthPct),
    social_risk: socialSignal(social.score, social.label, social.status),
    exit_strategy: exitSignal(exitRow),
    ecosystem_rotation: ecosystemSignal((ecos ?? []) as EcoRow[]),
    stablecoin_liquidity: liquiditySignal(global.stablecoin_market_cap),
    derivatives: derivativesSignal(derivRow as { leverage_risk: number | null; label: string | null } | null)
  };

  // ── Market posture ──
  const dom = Number(global.btc_dominance ?? 0);
  let posture: string;
  let postureInterp: string;
  if (btcRisk != null && btcRisk >= 0.7) {
    posture = 'Caution / distribution risk';
    postureInterp = 'BTC risk is high on the model — aggressive new buying is less attractive and risk management matters more.';
  } else if (btcRisk != null && btcRisk < 0.45 && (breadthPct ?? 0) >= 55) {
    posture = 'Broad risk-on building';
    postureInterp = 'BTC remains accumulation-friendly and altcoin strength is broadening across the market.';
  } else if (btcRisk != null && btcRisk < 0.45) {
    posture = 'Accumulation-friendly, but selective';
    postureInterp = 'BTC conditions favour disciplined DCA, but altcoin strength is not broad enough to call full altcoin season.';
  } else if (dom >= 55 && (breadthPct ?? 100) < 45) {
    posture = 'BTC-led market';
    postureInterp = 'Bitcoin still controls market direction; altcoin participation is limited.';
  } else {
    posture = 'Neutral / transition';
    postureInterp = 'The market is in transition — neither clearly accumulation nor clearly risk-on.';
  }

  // ── Strongest signal today ──
  const ecoImproving = ((ecos ?? []) as EcoRow[]).filter((e) => (e.metrics?.strength_score ?? 0) >= 65).sort((a, b) => (b.metrics?.strength_score ?? 0) - (a.metrics?.strength_score ?? 0))[0];
  const topGainer = top_gainers[0];
  let strongest: string;
  if (ecoImproving) strongest = `${ecoImproving.name} ecosystem is improving while most ecosystems remain neutral or weak.`;
  else if (topGainer && topGainer.vs_btc === 'strong') strongest = `${topGainer.symbol} is outperforming Bitcoin (${pct1(topGainer.price_change_pct_24h)} in 24h), a confirmed-strength move.`;
  else if (btcRisk != null && btcRisk < 0.4) strongest = 'BTC risk remains in a low-risk DCA zone on the current model.';
  else if ((logregRow as { zone_label?: string } | null)?.zone_label) strongest = `BTC log-regression zone: ${(logregRow as { zone_label: string }).zone_label}.`;
  else strongest = 'No standout strength today — the market is broadly neutral.';

  // ── Biggest warning today ──
  let warning: string;
  if (btcRisk != null && btcRisk >= 0.7) warning = 'BTC risk is elevated — distribution risk is rising. Manage exposure carefully.';
  else if (social.score != null && social.score >= 0.7) warning = 'Social attention is heating up — watch for crowd euphoria.';
  else if ((breadthPct ?? 0) < 45) warning = 'Altcoin strength is still selective — do not assume full altcoin season until breadth improves.';
  else if (dom >= 55) warning = 'BTC dominance remains high — altcoin moves may be short-lived without a dominance rollover.';
  else warning = 'Exit risk remains low, so major distribution pressure is not confirmed — but stay disciplined.';

  // ── What changed today ──
  const what_changed: string[] = [];
  if (prev) {
    if (global.btc_price != null && prev.btc_price) what_changed.push(`BTC ${global.btc_price >= prev.btc_price ? 'up' : 'down'} ${pct1(Math.abs(((global.btc_price - prev.btc_price) / prev.btc_price) * 100))} since last snapshot.`);
    if (global.market_cap_change_24h != null) what_changed.push(`Total market cap ${Number(global.market_cap_change_24h) >= 0 ? 'up' : 'down'} ${pct1(Math.abs(Number(global.market_cap_change_24h)))} (24h).`);
    what_changed.push(`BTC dominance is ${pct1(dom)}.`);
    if (breadthPct != null) what_changed.push(`Altcoin breadth: ${breadthPct}% of liquid alts are beating BTC.`);
    if (exitRow && prevExit && exitRow.strategy_label !== prevExit.strategy_label) what_changed.push(`Exit signal moved from ${prevExit.strategy_label} to ${exitRow.strategy_label}.`);
    else if (exitRow) what_changed.push(`Exit signal remains ${exitRow.strategy_label}.`);
    if (social.score != null) what_changed.push(`Social risk remains ${social.label.toLowerCase()}.`);
  } else {
    what_changed.push('Daily comparison unavailable. This will begin tracking changes after the next sync.');
  }

  // ── Daily market read (plain-language paragraph) ──
  const readParts: string[] = [];
  readParts.push(signals.btc_risk.tone === 'good' ? 'BTC remains in an accumulation-friendly zone' : signals.btc_risk.tone === 'danger' ? 'BTC risk is elevated' : 'BTC risk is moderate');
  readParts.push(breadthPct == null ? 'altcoin breadth is unavailable' : breadthPct < 45 ? 'but altcoin strength is still selective' : breadthPct >= 55 ? 'and altcoin strength is broadening' : 'with mixed altcoin strength');
  const dailyRead = `${readParts.join(', ')}. BTC dominance is ${pct1(dom)}, meaning Bitcoin ${dom >= 52 ? 'still controls market direction' : 'is sharing direction with altcoins'}. ${global.market_cap_change_24h != null && Math.abs(Number(global.market_cap_change_24h)) < 1 ? 'Market cap is mostly flat today' : `Total market cap is ${Number(global.market_cap_change_24h) >= 0 ? 'expanding' : 'contracting'} today`}, and social attention is ${social.score == null ? 'unavailable' : social.score < 0.5 ? 'not euphoric' : 'rising'}. ${exitRow ? `Exit signal is ${exitRow.strategy_label}.` : ''} This suggests a ${posture.toLowerCase()} environment.`;

  // ── Market condition card (enriched) ──
  const condConfidence = btcRisk != null && social.score != null ? 'Medium' : 'Low';
  const market_condition = {
    label: global.market_condition ?? 'Neutral',
    summary: global.summary ?? '',
    confidence: condConfidence,
    reason: `BTC risk is ${signals.btc_risk.label.toLowerCase()}, social attention is ${social.score == null ? 'unavailable' : social.score < 0.5 ? 'quiet' : 'rising'}, and altcoin breadth is ${breadthPct == null ? 'unavailable' : `${breadthPct}%`}.`,
    what_would_change: 'If BTC risk rises and altcoin breadth expands broadly, the regime may shift toward selective risk-on.'
  };

  // ── Data freshness ──
  const jobList = (jobs ?? []) as { source: string; job_type: string; status: string; finished_at: string | null }[];
  const latestFor = (re: RegExp): string | null => jobList.find((j) => re.test(`${j.source} ${j.job_type}`))?.finished_at ?? null;
  const marketSynced = latestFor(/coingecko|global|market|price/i) ?? global.captured_at;
  const data_freshness = {
    market: { at: marketSynced, label: ago(marketSynced), stale: isStale(marketSynced, 6) },
    risk: { at: riskRow?.snapshot_date ?? latestFor(/risk/i), label: ago(riskRow?.snapshot_date ?? latestFor(/risk/i)), stale: isStale(riskRow?.snapshot_date ?? null, 48) },
    onchain: { at: latestFor(/onchain|supply/i), label: ago(latestFor(/onchain|supply/i)), stale: isStale(latestFor(/onchain|supply/i), 48) },
    social: { at: social.as_of, label: social.as_of ? ago(`${social.as_of}T00:00:00Z`) : 'unavailable', stale: isStale(social.as_of ? `${social.as_of}T00:00:00Z` : null, 72), status: social.status },
    reports: { at: report?.published_at ?? null, label: ago(report?.published_at), stale: false }
  };

  // ── Coverage ──
  const coverage = {
    market: true,
    btc_risk: btcRisk != null,
    altcoin_breadth: breadthPct != null,
    ecosystem: (ecos ?? []).length > 0,
    social: social.status !== 'unavailable',
    exit_strategy: !!exitRow,
    log_regression: !!logregRow,
    derivatives: !!derivRow,
    report: !!report
  };
  const missing = Object.entries(coverage)
    .filter(([, v]) => !v)
    .map(([k]) => k.replace(/_/g, ' '));
  const coverageNote = missing.length ? `Unavailable: ${missing.join(', ')}. Run the relevant syncs to enable.` : 'All overview modules are active.';

  return {
    as_of: global.captured_at,
    universe,
    is_paid: isPaid,
    market_posture: { label: posture, interpretation: postureInterp },
    daily_market_read: dailyRead,
    market_condition,
    what_changed_today: what_changed,
    signals,
    metrics: {
      btc_price: global.btc_price,
      eth_price: global.eth_price,
      total_market_cap: global.total_market_cap,
      volume_24h: global.total_volume,
      btc_dominance: global.btc_dominance,
      eth_dominance: global.eth_dominance,
      stablecoin_cap: global.stablecoin_market_cap,
      market_cap_change_24h: global.market_cap_change_24h
    },
    strongest_signal_today: strongest,
    biggest_warning_today: warning,
    top_gainers,
    top_losers,
    latest_report: report
      ? { title: report.title, slug: report.slug, report_type: report.report_type, posture: (report.market_status as { regime?: string } | null)?.regime ?? null, takeaway: report.premium_takeaway, published_at: report.published_at }
      : null,
    data_freshness,
    coverage: { flags: coverage, note: coverageNote }
  };
};
