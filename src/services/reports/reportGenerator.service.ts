import type { ReportSnapshot, ReportType } from './reportData.service';

// ─────────────────────────────────────────────────────────────────────────────
// reportGenerator.service — turns a ReportSnapshot into polished, human-readable
// market intelligence. Fully deterministic: it composes probability-style
// language from the snapshot, enforces the "use these phrases / avoid hype"
// rules, supports English + Swahili and professional / channel / WhatsApp tones.
// (The report_templates.prompt_template field is reserved for optional LLM polish
// later — the structured output here is the source of truth.)
// ─────────────────────────────────────────────────────────────────────────────

export type Audience = 'public' | 'free' | 'mid' | 'premium';
export type Tone = 'professional' | 'simple' | 'channel' | 'whatsapp';
export type Language = 'en' | 'sw';

export interface GenerateOptions {
  type: ReportType;
  audience: Audience;
  language: Language;
  tone: Tone;
  sections: string[];
  report_date: string;
}

export interface GeneratedSection {
  section_key: string;
  section_title: string;
  content: string;
  data: Record<string, unknown> | null;
  is_premium: boolean;
  sort_order: number;
}

export interface ScorecardItem {
  label: string;
  value: string;
  note: string;
}

export interface QualityResult {
  status: 'Passed' | 'Needs review' | 'Missing required sections';
  passed: boolean;
  checks: Record<string, boolean>;
  warnings: string[];
}

export interface GeneratedReport {
  title: string;
  market_status: { regime: string; btc_risk: string; altcoin: string; social: string };
  scorecard: ScorecardItem[];
  summary: string;
  premium_takeaway: string;
  preview: string;
  content: string;
  sections: GeneratedSection[];
  quality: QualityResult;
}

const BANNED = ['guaranteed', '100x', 'buy now', 'will explode', 'will pump', 'risk-free', 'risk free'];

// A regime counts as "broad" only when it leads with Broad — avoids matching the
// word "broad" inside negations like "No broad ecosystem rotation yet".
const isBroad = (regime: string): boolean => /^broad/i.test(regime.trim());
const lower = (s: string | null | undefined): string => (s ?? '').toLowerCase();
// Lowercase a DCA-zone label for mid-sentence use, but keep the "DCA" acronym.
const zoneText = (z: string | null | undefined): string => (z ?? '').toLowerCase().replace(/dca/g, 'DCA');

const TYPE_LABEL: Record<ReportType, { en: string; sw: string }> = {
  daily: { en: 'Daily', sw: 'ya Kila Siku' },
  weekly: { en: 'Weekly', sw: 'ya Wiki' },
  monthly: { en: 'Monthly', sw: 'ya Mwezi' },
  special: { en: 'Special Update', sw: 'Maalum' },
  premium: { en: 'Premium', sw: 'ya Premium' },
  preview: { en: 'Preview', sw: 'ya Awali' }
};

// Locked for non-premium audiences (preview hides them). Market posture, data
// coverage, executive summary and market status stay visible as the teaser.
const PREMIUM_SECTIONS = new Set([
  'what_changed',
  'btc_cycle',
  'onchain',
  'social',
  'altcoin_btc',
  'ecosystem',
  'strongest_signals',
  'weakest_areas',
  'confirmation_needed',
  'risk_warnings',
  'exit_strategy',
  'exit_simulation_example',
  'log_regression',
  'premium_takeaway'
]);

const SECTION_TITLES: Record<string, { en: string; sw: string }> = {
  market_status: { en: 'Market Status', sw: 'Hali ya Soko' },
  executive_summary: { en: 'Executive Summary', sw: 'Muhtasari' },
  what_changed: { en: 'What Changed', sw: 'Kilichobadilika' },
  market_posture: { en: 'Market Posture', sw: 'Msimamo wa Soko' },
  btc_risk: { en: 'BTC Risk', sw: 'Hatari ya BTC' },
  btc_cycle: { en: 'BTC Cycle', sw: 'Mzunguko wa BTC' },
  onchain: { en: 'On-chain Conditions', sw: 'Hali za On-chain' },
  social: { en: 'Social Attention', sw: 'Mwelekeo wa Watu' },
  altcoin_btc: { en: 'Altcoin vs BTC', sw: 'Altcoin dhidi ya BTC' },
  ecosystem: { en: 'Ecosystem Rotation', sw: 'Mzunguko wa Ekosistimu' },
  strongest_signals: { en: 'Strongest Signals', sw: 'Ishara Imara Zaidi' },
  weakest_areas: { en: 'Weakest Areas', sw: 'Maeneo Dhaifu' },
  confirmation_needed: { en: 'Confirmation Needed', sw: 'Uthibitisho Unaohitajika' },
  risk_warnings: { en: 'Risk Warnings', sw: 'Tahadhari za Hatari' },
  premium_takeaway: { en: 'Premium Takeaway', sw: 'Hitimisho la Premium' },
  data_coverage: { en: 'Data Coverage', sw: 'Vyanzo vya Data' },
  exit_strategy: { en: 'Exit Strategy', sw: 'Mkakati wa Kutoka' },
  exit_simulation_example: { en: 'Exit Simulation Example', sw: 'Mfano wa Simulesheni ya Kutoka' },
  log_regression: { en: 'Logarithmic Regression', sw: 'Regression ya Logarithmic' },
  watchlist: { en: 'Watchlist', sw: 'Orodha ya Kufuatilia' },
  sectors: { en: 'Sector Rotation', sw: 'Mzunguko wa Sekta' },
  disclaimer: { en: 'Disclaimer', sw: 'Kanusho' }
};

const MODULE_LABELS: Record<string, string> = {
  btc_risk: 'BTC risk',
  btc_cycle: 'BTC cycle',
  onchain: 'on-chain metrics',
  social: 'social metrics',
  altcoin_btc: 'Alt/BTC breadth',
  ecosystem: 'ecosystem rankings',
  sectors: 'sector rotation',
  watchlist: 'watchlist intelligence'
};

const fmtDate = (d: string): string => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const pc = (n: number | null, dp = 1) => (n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(dp)}%`);
const fmt3 = (n: number | null) => (n == null ? 'n/a' : n.toFixed(3));
const fmtN = (n: number | null) => (n == null ? 'n/a' : n.toLocaleString('en-US', { maximumFractionDigits: 3 }));

const onchainBand = (c: number | null, lang: Language): string => {
  if (c == null) return lang === 'en' ? 'unavailable' : 'haipatikani';
  if (c < 0.4) return lang === 'en' ? 'low' : 'chini';
  if (c < 0.6) return lang === 'en' ? 'low-to-moderate' : 'chini-hadi-wastani';
  if (c < 0.8) return lang === 'en' ? 'elevated' : 'imepanda';
  return lang === 'en' ? 'high' : 'kubwa';
};

// Overall market regime from risk + altcoin breadth.
const regimeOf = (s: ReportSnapshot, lang: Language): string => {
  const score = s.risk?.score ?? null;
  const breadth = s.altcoin?.breadth_pct ?? null;
  const map = {
    riskoff: { en: 'Risk-off / caution', sw: 'Tahadhari / hatari kubwa' },
    broad: { en: 'Broad risk-on', sw: 'Soko lenye nguvu pana' },
    selective: { en: 'Selective strength', sw: 'Nguvu ya kuchagua' },
    neutral: { en: 'Neutral / transition', sw: 'Wastani / mpito' }
  };
  let key: keyof typeof map = 'neutral';
  if (score != null && score >= 0.8) key = 'riskoff';
  else if (breadth != null && breadth >= 60) key = 'broad';
  else if (breadth != null && breadth < 40 && (score == null || score < 0.6)) key = 'selective';
  return map[key][lang];
};

// Positioning context (not advice). Returns a short label + a paragraph.
export const marketPosture = (s: ReportSnapshot, lang: Language): { label: string; text: string } => {
  const en = lang === 'en';
  const score = s.risk?.score ?? null;
  const breadth = s.altcoin?.breadth_pct ?? null;
  let label: string;
  let text: string;

  if (score == null) {
    label = en ? 'Neutral / transition' : 'Wastani / mpito';
    text = en
      ? 'Core risk data was limited this period, so positioning should stay measured until the model has a fuller read.'
      : 'Data ya hatari ilikuwa finyu kipindi hiki, hivyo msimamo ubaki wa wastani mpaka modeli ipate picha kamili.';
  } else if (score >= 0.8) {
    label = en ? 'Distribution risk / defensive' : 'Hatari ya distribution / kujihami';
    text = en
      ? 'BTC risk is high, which historically favours capital preservation over fresh risk-taking. Exposure should be defensive and focused on quality until risk eases.'
      : 'Hatari ya BTC ni kubwa, jambo ambalo kihistoria hupendelea kulinda mtaji badala ya kuchukua hatari mpya. Baki na msimamo wa kujihami mpaka hatari ipungue.';
  } else if (score >= 0.6) {
    label = en ? 'Caution' : 'Tahadhari';
    text = en
      ? 'BTC risk is building. The market is not overheated yet, but this favours caution and selectivity over aggressive accumulation.'
      : 'Hatari ya BTC inapanda. Soko bado halijazidi joto, lakini hii inapendelea tahadhari na kuchagua badala ya kukusanya kwa kasi.';
  } else if (breadth != null && breadth >= 60) {
    label = en ? 'Broad risk-on (confirm)' : 'Risk-on pana (thibitisha)';
    text = en
      ? 'BTC risk is low-to-moderate and breadth is broad. Conditions lean risk-on, but keep confirmation in mind and manage risk as the move extends.'
      : 'Hatari ya BTC ni ya chini-hadi-wastani na breadth ni pana. Hali inaelekea risk-on, lakini kumbuka uthibitisho na dhibiti hatari.';
  } else if (breadth != null && breadth >= 40) {
    label = en ? 'Selective risk-on' : 'Risk-on ya kuchagua';
    text = en
      ? 'BTC risk is low-to-moderate, which supports disciplined DCA. Altcoin strength is improving but not broad, so altcoin exposure should remain selective and focused on confirmed leaders.'
      : 'Hatari ya BTC ni ya chini-hadi-wastani, inayounga mkono DCA ya nidhamu. Nguvu ya altcoin inaboreka lakini siyo pana, hivyo baki na uchaguzi kwenye viongozi waliothibitishwa.';
  } else {
    label = en ? 'Accumulation-friendly, but selective' : 'Inafaa kukusanya, lakini kwa kuchagua';
    text = en
      ? 'BTC risk remains low-to-moderate, which supports disciplined DCA. However, altcoin strength is not broad yet, so altcoin exposure should remain selective and focused on confirmed leaders rather than weak BTC pairs.'
      : 'Hatari ya BTC bado ni ya chini-hadi-wastani, inayounga mkono DCA ya nidhamu. Lakini nguvu ya altcoin bado siyo pana, hivyo baki na uchaguzi kwenye viongozi waliothibitishwa badala ya pairs dhaifu za BTC.';
  }
  return { label, text };
};

const trendWord = (t: string | null, lang: Language): string =>
  lang === 'sw'
    ? t === 'rising'
      ? 'imepanda'
      : t === 'falling'
        ? 'imeshuka'
        : 'haijabadilika sana'
    : t === 'rising'
      ? 'risen'
      : t === 'falling'
        ? 'eased'
        : 'held roughly flat';

const deltaWord = (change: number | null, lang: Language): string => {
  const en = lang === 'en';
  if (change == null) return en ? 'held flat' : 'haijabadilika';
  if (change > 0) return en ? 'rose' : 'imepanda';
  if (change < 0) return en ? 'eased' : 'imeshuka';
  return en ? 'held flat' : 'haijabadilika';
};

// ── per-section content builders ──
const sectionContent = (key: string, s: ReportSnapshot, lang: Language, short: boolean): string => {
  const en = lang === 'en';
  switch (key) {
    case 'market_status': {
      const regime = regimeOf(s, lang);
      if (en)
        return [
          `Market regime: ${regime}`,
          `BTC risk: ${s.risk?.dca_zone ?? 'unavailable'}`,
          `Altcoin market: ${s.altcoin?.regime ?? 'unavailable'}`,
          `Social risk: ${s.social?.label ?? 'unavailable'}`
        ].join('\n');
      return [
        `Hali ya soko: ${regime}`,
        `Hatari ya BTC: ${s.risk?.dca_zone ?? 'haipatikani'}`,
        `Soko la altcoin: ${s.altcoin?.regime ?? 'haipatikani'}`,
        `Mwelekeo wa watu: ${s.social?.label ?? 'haipatikani'}`
      ].join('\n');
    }

    case 'executive_summary': {
      const r = s.risk;
      const a = s.altcoin;
      const parts: string[] = [];
      if (r?.score != null) {
        if (r.score >= 0.8) parts.push(en ? `BTC risk is high (${r.score.toFixed(3)}), placing it in the ${zoneText(r.dca_zone)}. This favours capital preservation over fresh risk-taking.` : `Hatari ya BTC ni kubwa (${r.score.toFixed(3)}), ikiwa kwenye ${zoneText(r.dca_zone)}. Hii inapendelea kulinda mtaji.`);
        else if (r.score >= 0.6) parts.push(en ? `BTC risk is elevated (${r.score.toFixed(3)}), in the ${zoneText(r.dca_zone)}. Risk is building, so favour caution over aggressive accumulation.` : `Hatari ya BTC imepanda (${r.score.toFixed(3)}), ipo kwenye ${zoneText(r.dca_zone)}. Pendelea tahadhari.`);
        else if (r.score >= 0.4) parts.push(en ? `BTC risk is moderate (${r.score.toFixed(3)}), in the ${zoneText(r.dca_zone)} — neither historically cheap nor stretched.` : `Hatari ya BTC ni ya wastani (${r.score.toFixed(3)}), ipo kwenye ${zoneText(r.dca_zone)}.`);
        else parts.push(en ? `BTC remains in a ${zoneText(r.dca_zone)}, with the total risk score at ${r.score.toFixed(3)}. This supports disciplined accumulation, but the market is not showing an extreme bottom signal.` : `BTC bado ipo kwenye ${zoneText(r.dca_zone)}, alama ya hatari ikiwa ${r.score.toFixed(3)}. Hii inaunga mkono kukusanya kwa nidhamu, lakini siyo extreme bottom.`);
      }
      if (a) {
        const broad = isBroad(a.regime);
        parts.push(en ? `Altcoin strength is ${broad ? 'broad' : 'improving selectively'}, with ${a.breadth_pct != null ? `${a.breadth_pct.toFixed(0)}% of tracked majors` : 'only a small group'} outperforming BTC${broad ? '' : ', but this is still not broad altcoin rotation'}.` : `Nguvu ya altcoin ${broad ? 'ni pana' : 'inaboreka kwa kuchagua'}; ${a.breadth_pct != null ? `${a.breadth_pct.toFixed(0)}% ya majors` : 'coins chache'} zinazidi BTC${broad ? '' : ', lakini bado siyo altseason kamili'}.`);
      }
      if (s.onchain?.composite != null || s.social?.label) parts.push(en ? `On-chain metrics remain ${onchainBand(s.onchain?.composite ?? null, lang)}, and social attention is ${lower(s.social?.label) || 'quiet'}.` : `On-chain ipo ${onchainBand(s.onchain?.composite ?? null, lang)}, na mwelekeo wa watu ni ${lower(s.social?.label) || 'wa chini'}.`);
      if (s.ecosystem?.strongest[0]) parts.push(en ? `Ecosystem leadership is concentrated around a few names such as ${s.ecosystem.strongest[0].name}.` : `Uongozi wa ekosistimu umejikita kwenye majina machache kama ${s.ecosystem.strongest[0].name}.`);
      if (!short && parts.length) parts.push(en ? 'The main message: BTC remains attractive for disciplined DCA, while altcoins require selectivity and confirmation.' : 'Ujumbe mkuu: BTC bado inavutia kwa DCA ya nidhamu, huku altcoins zikihitaji uchaguzi na uthibitisho.');
      if (!parts.length) return en ? 'Insufficient module data was available to generate a full summary for this period.' : 'Takwimu hazikutosha kutengeneza muhtasari kamili kwa kipindi hiki.';
      return (short ? parts.slice(0, 3) : parts).join(' ');
    }

    case 'what_changed': {
      const r = s.risk;
      const o = s.onchain;
      const so = s.social;
      const hasDeltas = (r?.change ?? null) != null || (o?.change ?? null) != null || (so?.change ?? null) != null;
      const bullets: string[] = [];
      if (!hasDeltas) {
        bullets.push(en ? 'Previous comparison unavailable. This report will begin tracking changes from the next period.' : 'Ulinganisho wa kipindi kilichopita haupatikani. Taarifa hii itaanza kufuatilia mabadiliko kuanzia kipindi kijacho.');
      } else {
        if (r?.change != null) bullets.push(en ? `BTC risk ${deltaWord(r.change, lang)} by ${pc(r.change * 100)}, keeping the market in a ${zoneText(r.dca_zone)}.` : `Hatari ya BTC ${deltaWord(r.change, lang)} kwa ${pc(r.change * 100)}, ikibaki kwenye ${zoneText(r.dca_zone)}.`);
        if (o?.change != null) bullets.push(en ? `On-chain risk ${deltaWord(o.change, lang)} by ${pc(o.change * 100)}, now ${onchainBand(o.composite, lang)}.` : `Hatari ya on-chain ${deltaWord(o.change, lang)} kwa ${pc(o.change * 100)}, sasa ${onchainBand(o.composite, lang)}.`);
        if (so?.change != null) bullets.push(en ? `Social risk ${deltaWord(so.change, lang)} by ${pc(so.change * 100)}; attention remains ${lower(so.label)}.` : `Hatari ya mitandao ${deltaWord(so.change, lang)} kwa ${pc(so.change * 100)}; mwelekeo bado ${lower(so.label)}.`);
      }
      if (s.altcoin?.breadth_pct != null) bullets.push(en ? `Altcoin breadth is ${s.altcoin.breadth_pct.toFixed(0)}%, so strength remains ${isBroad(s.altcoin.regime) ? 'broad' : 'selective'}.` : `Altcoin breadth ni ${s.altcoin.breadth_pct.toFixed(0)}%, nguvu bado ${isBroad(s.altcoin.regime) ? 'pana' : 'ya kuchagua'}.`);
      if (s.ecosystem?.strongest[0]) bullets.push(en ? `${s.ecosystem.strongest[0].name} leads the ecosystems, while broad rotation is ${isBroad(s.ecosystem.regime) ? 'confirming' : 'still not confirmed'}.` : `${s.ecosystem.strongest[0].name} inaongoza ekosistimu, huku mzunguko mpana ${isBroad(s.ecosystem.regime) ? 'ukithibitika' : 'bado haujathibitika'}.`);
      if (s.altcoin?.strongest.length) bullets.push(en ? `${s.altcoin.strongest.slice(0, 3).map((c) => c.symbol).join(', ')} are leading against BTC.` : `${s.altcoin.strongest.slice(0, 3).map((c) => c.symbol).join(', ')} zinaongoza dhidi ya BTC.`);
      return bullets.map((b) => `• ${b}`).join('\n');
    }

    case 'market_posture': {
      const p = marketPosture(s, lang);
      return `${p.label}.\n\n${p.text}`;
    }

    case 'btc_risk': {
      if (!s.risk || s.risk.score == null) return en ? 'BTC risk data unavailable for this report.' : 'Takwimu za hatari ya BTC hazipatikani kwa taarifa hii.';
      const r = s.risk;
      const score = r.score as number;
      const stance = score >= 0.8 ? (en ? 'This favours capital preservation over fresh risk-taking.' : 'Hii inapendelea kulinda mtaji.') : score >= 0.6 ? (en ? 'Risk is building, so favour caution over aggressive accumulation.' : 'Hatari inapanda, pendelea tahadhari.') : score >= 0.4 ? (en ? 'Conditions are balanced — neither historically cheap nor stretched.' : 'Hali ni ya wastani.') : en ? 'This supports disciplined accumulation, but it is not necessarily an extreme bottom signal.' : 'Hii inaunga mkono kukusanya kwa nidhamu, lakini siyo lazima iwe extreme bottom.';
      const trend = r.change == null ? '' : en ? ` Risk has ${trendWord(r.trend, lang)} ${pc(r.change * 100)} versus the previous report.` : ` Hatari ${trendWord(r.trend, lang)} kwa ${pc(r.change * 100)}.`;
      const breakdown = short ? '' : en ? ` Price risk ${fmt3(r.price_risk)}, on-chain ${fmt3(r.onchain_risk)}, social ${fmt3(r.social_risk)}.` : ` Bei ${fmt3(r.price_risk)}, on-chain ${fmt3(r.onchain_risk)}, mitandao ${fmt3(r.social_risk)}.`;
      if (en) return `Current risk score is ${score.toFixed(3)}, placing BTC in the ${zoneText(r.dca_zone)}. ${stance}${trend}${breakdown}`;
      return `Alama ya hatari kwa sasa ni ${score.toFixed(3)}, ikiweka BTC kwenye ${zoneText(r.dca_zone)}. ${stance}${trend}${breakdown}`;
    }

    case 'btc_cycle': {
      if (!s.cycle) return en ? 'BTC cycle data unavailable for this report.' : 'Takwimu za mzunguko wa BTC hazipatikani.';
      const c = s.cycle;
      const roi = c.roi_from_low_pct != null ? (en ? ` ROI from the last cycle low is ${pc(c.roi_from_low_pct)}` : ` ROI tangu chini ya mzunguko ni ${pc(c.roi_from_low_pct)}`) : '';
      const halving = c.roi_from_halving_pct != null ? (en ? `, and ${pc(c.roi_from_halving_pct)} from the last halving.` : `, na ${pc(c.roi_from_halving_pct)} tangu halving.`) : roi ? '.' : '';
      if (en) return `BTC cycle risk is ${c.risk_score}/100 (${c.risk_label}) — ${c.reason}. ${c.drawdown_from_ath < -20 ? 'BTC remains well below its all-time high, suggesting the cycle is not overheated compared with previous cycles.' : 'BTC is trading near prior highs, so cycle risk is more elevated.'}${roi}${halving}`;
      return `Hatari ya mzunguko wa BTC ni ${c.risk_score}/100 (${c.risk_label}) — ${c.reason}.${roi}${halving}`;
    }

    case 'onchain': {
      if (!s.onchain) return en ? 'On-chain data unavailable for this report.' : 'Takwimu za on-chain hazipatikani.';
      const o = s.onchain;
      const sup = o.supply ? (en ? ` Supply in profit is ${o.supply.profit_pct}% vs ${o.supply.loss_pct}% in loss (${o.supply.state}).` : ` Usambazaji kwenye faida ni ${o.supply.profit_pct}% dhidi ya ${o.supply.loss_pct}% kwenye hasara (${o.supply.state}).`) : '';
      const band = o.composite == null ? '' : o.composite < 0.6 ? (en ? 'On-chain risk remains low-to-moderate; MVRV-Z, NUPL and Reserve Risk are not showing broad euphoria.' : 'Hatari ya on-chain bado ni ya chini-hadi-wastani; MVRV-Z, NUPL na Reserve Risk hazionyeshi euphoria pana.') : en ? 'On-chain risk is rising — watch MVRV-Z, NUPL and Puell for broad overheating.' : 'Hatari ya on-chain inapanda — angalia MVRV-Z, NUPL na Puell.';
      const readings = short || (o.mvrv_zscore == null && o.nupl == null) ? '' : en ? ` Readings — MVRV-Z ${fmtN(o.mvrv_zscore)}, Puell ${fmtN(o.puell_multiple)}, NUPL ${fmtN(o.nupl)}.` : ` Vipimo — MVRV-Z ${fmtN(o.mvrv_zscore)}, Puell ${fmtN(o.puell_multiple)}, NUPL ${fmtN(o.nupl)}.`;
      return `${band}${sup}${readings}`.trim();
    }

    case 'social': {
      if (!s.social) return en ? 'Social metrics unavailable for this report.' : 'Takwimu za mitandao hazipatikani.';
      const so = s.social;
      const fg = so.fear_greed != null ? (en ? ` Fear & Greed is at ${so.fear_greed}.` : ` Fear & Greed ipo ${so.fear_greed}.`) : '';
      const note = so.google_trends == null ? (en ? ' Google Trends unavailable; social risk uses available sources.' : ' Google Trends haipatikani; hatari ya mitandao inatumia vyanzo vilivyopo.') : '';
      if (en) return `Social attention is ${lower(so.label) || 'normal'}. The crowd is not euphoric, and retail interest is not yet in hype territory.${fg}${note}`;
      return `Mwelekeo wa watu ni ${lower(so.label) || 'wa kawaida'}. Umati haujafikia hype, na retail bado haijaingia eneo la hype.${fg}${note}`;
    }

    case 'altcoin_btc': {
      if (!s.altcoin) return en ? 'Altcoin vs BTC data unavailable for this report.' : 'Takwimu za Altcoin dhidi ya BTC hazipatikani.';
      const a = s.altcoin;
      const strong = a.strongest.length ? a.strongest.slice(0, 3).map((c) => c.symbol).join(', ') : '';
      const posEn = a.positive_pct != null ? ` Only ${a.positive_pct}% are positive in absolute terms${a.positive_pct < 50 ? ', so part of this is BTC falling harder rather than alts rising' : ''}.` : '';
      const posSw = a.positive_pct != null ? ` Ni ${a.positive_pct}% tu ndizo chanya kihalisia${a.positive_pct < 50 ? ', hivyo sehemu ya hili ni BTC kushuka zaidi badala ya alts kupanda' : ''}.` : '';
      if (en) return `Altcoin strength remains ${isBroad(a.regime) ? 'broad' : 'selective'} (${a.breadth_pct != null ? `${a.breadth_pct.toFixed(0)}% beat BTC` : 'breadth unavailable'}).${posEn}${strong ? ` Leading vs BTC: ${strong}.` : ''} ${isBroad(a.regime) ? 'Rotation is confirming' : 'Full rotation is not confirmed'} — confirmation is still needed. Avoid weak BTC pairs.`;
      return `Nguvu ya altcoin bado ni ${isBroad(a.regime) ? 'pana' : 'ya kuchagua'} (${a.breadth_pct != null ? `${a.breadth_pct.toFixed(0)}% zimeshinda BTC` : 'breadth haipatikani'}).${posSw}${strong ? ` Zinazoongoza dhidi ya BTC: ${strong}.` : ''} Bado uthibitisho unahitajika; epuka pairs dhaifu za BTC.`;
    }

    case 'ecosystem': {
      if (!s.ecosystem) return en ? 'Ecosystem data unavailable for this report.' : 'Takwimu za ekosistimu hazipatikani.';
      const e = s.ecosystem;
      const lead = e.strongest[0];
      const top = e.strongest.slice(0, 3).map((x) => x.name).join(', ');
      if (en) return `${lead ? `${lead.name} is currently the strongest ecosystem (${lead.signal}${lead.tvl_change_7d != null ? `, TVL ${pc(lead.tvl_change_7d)} 7d` : ''}).` : ''} Leaders: ${top || '—'}. ${e.regime}. Most major ecosystems remain neutral or weak, so rotation is ${isBroad(e.regime) ? 'broadening' : 'not yet broad'}.`;
      return `${lead ? `${lead.name} ndiyo ekosistimu imara zaidi kwa sasa (${lead.signal}).` : ''} Viongozi: ${top || '—'}. ${e.regime}.`;
    }

    case 'strongest_signals': {
      const lines: string[] = [];
      if (s.altcoin?.strongest.length) s.altcoin.strongest.slice(0, 4).forEach((c, i) => lines.push(`${i + 1}. ${c.symbol}/BTC — ${c.label || 'Strength'} — ${c.confidence || 'Confidence: not available'}`));
      if (s.ecosystem?.strongest[0]) lines.push(`${lines.length + 1}. ${s.ecosystem.strongest[0].name} ecosystem — ${s.ecosystem.strongest[0].signal} — Confidence: not available`);
      if (!lines.length) return en ? 'No confirmed strength signals available for this report.' : 'Hakuna ishara imara zilizothibitishwa kwa taarifa hii.';
      const interp = en
        ? '\n\nThese signals show where strength is appearing, but they should still be filtered through liquidity, trend confirmation, and BTC market conditions.'
        : '\n\nIshara hizi zinaonyesha nguvu inapojitokeza, lakini bado zichujwe kupitia liquidity, uthibitisho wa trend, na hali ya soko la BTC.';
      return (en ? 'Strongest signals:\n' : 'Ishara imara zaidi:\n') + lines.join('\n') + interp;
    }

    case 'weakest_areas': {
      const bullets: string[] = [];
      const weak = s.altcoin?.weakest ?? [];
      if (weak.length) bullets.push(en ? `Weakest vs BTC: ${weak.slice(0, 3).map((c) => `${c.symbol}/BTC (${c.label || 'weak'})`).join(', ')}.` : `Dhaifu zaidi dhidi ya BTC: ${weak.slice(0, 3).map((c) => `${c.symbol}/BTC`).join(', ')}.`);
      bullets.push(en ? 'Weak BTC pairs remain a risk because altcoin rotation is not broad.' : 'Pairs dhaifu za BTC bado ni hatari kwa sababu mzunguko wa altcoin siyo pana.');
      if (s.ecosystem?.weakest.length) bullets.push(en ? `Weaker ecosystems (${s.ecosystem.weakest.slice(0, 3).map((x) => x.name).join(', ')}) with soft TVL/DEX volume should be treated cautiously.` : `Ekosistimu dhaifu (${s.ecosystem.weakest.slice(0, 3).map((x) => x.name).join(', ')}) zenye TVL/DEX hafifu zitazamwe kwa tahadhari.`);
      bullets.push(en ? 'Avoid assuming strength in assets that are still underperforming BTC.' : 'Epuka kudhani nguvu kwenye assets ambazo bado zinashindwa na BTC.');
      return bullets.map((b) => `• ${b}`).join('\n');
    }

    case 'confirmation_needed': {
      const breadth = s.altcoin?.breadth_pct;
      const bullets = en
        ? [
            `Altcoin breadth should continue improving above 60%${breadth != null ? ` (currently ${breadth.toFixed(0)}%)` : ''}.`,
            'More ecosystems need positive TVL and DEX-volume growth.',
            'Leading Alt/BTC pairs should hold strength above key moving averages.',
            'Social attention should rise gradually without entering hype territory.',
            'BTC risk should remain low-to-moderate while price structure improves.'
          ]
        : [
            `Altcoin breadth iendelee kupanda zaidi ya 60%${breadth != null ? ` (sasa ${breadth.toFixed(0)}%)` : ''}.`,
            'Ekosistimu zaidi zinahitaji ukuaji chanya wa TVL na DEX volume.',
            'Pairs zinazoongoza za Alt/BTC zishikilie nguvu juu ya moving averages muhimu.',
            'Mwelekeo wa watu upande taratibu bila kuingia kwenye hype.',
            'Hatari ya BTC ibaki chini-hadi-wastani huku muundo wa bei ukiimarika.'
          ];
      return bullets.map((b) => `• ${b}`).join('\n');
    }

    case 'risk_warnings': {
      const w: string[] = [];
      if (s.risk?.score != null && s.risk.score >= 0.6) w.push(en ? 'BTC risk is elevated — favour caution over aggressive accumulation.' : 'Hatari ya BTC imepanda — pendelea tahadhari.');
      if (s.altcoin && !isBroad(s.altcoin.regime)) w.push(en ? 'Altcoin strength is still selective. Do not assume full altcoin season yet.' : 'Nguvu ya altcoin bado ni ya kuchagua. Usidhani ni altseason kamili bado.');
      w.push(en ? 'Some strong Alt/BTC signals may be short-term recoveries, not confirmed leadership.' : 'Baadhi ya ishara imara za Alt/BTC zinaweza kuwa recovery ya muda mfupi, siyo uongozi uliothibitishwa.');
      if (s.ecosystem && !isBroad(s.ecosystem.regime)) w.push(en ? 'Ecosystem rotation is not broad; most major ecosystems remain neutral or weak.' : 'Mzunguko wa ekosistimu siyo pana; nyingi bado ziko wastani au dhaifu.');
      w.push(en ? 'A DCA-friendly zone does not guarantee immediate upside — manage position sizing.' : 'Eneo zuri la DCA halihakikishi upside wa haraka — dhibiti ukubwa wa nafasi.');
      w.push(en ? 'If BTC dominance rises while Alt/BTC breadth weakens, altcoins may underperform again.' : 'Kama dominance ya BTC ikipanda huku breadth ya Alt/BTC ikidhoofu, altcoins zinaweza kushuka tena.');
      if (s.social?.score != null && s.social.score >= 0.6) w.push(en ? 'Social attention is elevated — watch for retail hype.' : 'Mwelekeo wa watu umepanda — angalia hype ya retail.');
      return w.map((x) => `• ${x}`).join('\n');
    }

    case 'data_coverage': {
      const av = s.availability;
      const active = Object.keys(MODULE_LABELS).filter((k) => av[k] === 'available').map((k) => MODULE_LABELS[k]);
      const missing = Object.keys(MODULE_LABELS).filter((k) => av[k] === 'unavailable').map((k) => MODULE_LABELS[k]);
      const activeList = active.length ? active.join(', ') : en ? 'limited sources' : 'vyanzo finyu';
      if (!missing.length) return en ? `All core modules were active for this report (${activeList}).` : `Moduli zote muhimu zilikuwa hai kwa taarifa hii (${activeList}).`;
      return en
        ? `This report used active data from ${activeList}. Unavailable modules: ${missing.join(', ')} — disclosed rather than estimated.`
        : `Taarifa hii ilitumia data hai kutoka ${activeList}. Hazikupatikana: ${missing.join(', ')} — zimewekwa wazi badala ya kukisia.`;
    }

    case 'exit_strategy': {
      if (!s.exit) return en ? 'Exit Strategy data unavailable for this report.' : 'Takwimu za mkakati wa kutoka hazipatikani.';
      const e = s.exit;
      const sl = e.social_label.toLowerCase();
      if (en) {
        const parts = [`Exit Risk is ${e.score.toFixed(2)} (${e.percent}/100), in the ${e.label} zone — confidence ${e.confidence}.`, `Current action: ${e.current_action} ${e.current_reason}`];
        if (e.social_status === 'unavailable') parts.push('Social Risk was unavailable for this report, so Exit Risk was calculated from active categories only.');
        else if (e.score < 0.5) parts.push(`Social Risk is ${sl} (${e.social_status} source coverage), so crowd attention is not yet adding exit pressure.`);
        else parts.push(`Social Risk is ${sl}, showing stronger retail attention. If BTC risk and on-chain metrics rise together, the model may move closer to light profit-taking or scale-out zones.`);
        if (e.next_threshold) parts.push(`Next threshold: ${e.next_threshold.score.toFixed(2)} — ${e.next_threshold.label}.`);
        if (e.signal_upgrade.length) parts.push(`The signal would strengthen if: ${e.signal_upgrade.join('; ')}.`);
        return parts.join(' ');
      }
      const parts = [`Alama ya Exit Risk ni ${e.score.toFixed(2)} (${e.percent}/100), kwenye eneo la ${e.label} — uhakika ${e.confidence}.`, `Hatua ya sasa: ${e.current_action}`];
      if (e.social_status === 'unavailable') parts.push('Data ya Social Risk haikupatikana kwa taarifa hii, hivyo Exit Risk imehesabiwa kwa kategoria zilizopo tu.');
      else if (e.score < 0.5) parts.push('Social Risk ipo chini — umati bado haujafikia hype, hivyo shinikizo la kuondoka ni dogo.');
      else parts.push('Social Risk inapanda, ikionyesha umakini zaidi wa wawekezaji. BTC na on-chain zikipanda pamoja, modeli inaweza kuelekea profit-taking ndogo au scale-out.');
      if (e.next_threshold) parts.push(`Kizingiti kijacho: ${e.next_threshold.score.toFixed(2)} — ${e.next_threshold.label}.`);
      return parts.join(' ');
    }

    case 'log_regression': {
      const lr = s.logreg;
      if (!lr || (!lr.btc && !lr.eth)) return en ? 'Logarithmic regression data is unavailable for this report.' : 'Takwimu za regression hazipatikani kwa taarifa hii.';
      type Reg = NonNullable<typeof lr.btc>;
      const line = (asset: string, g: Reg): string => {
        const where = g.distance_from_fit_percent < -2 ? 'below' : g.distance_from_fit_percent > 2 ? 'above' : 'near';
        if (en) {
          const riskWord = g.risk_score < 0.4 ? 'low-risk' : g.risk_score < 0.6 ? 'neutral' : g.risk_score < 0.8 ? 'elevated-risk' : 'overheated';
          const tail = asset === 'ETH' ? ' Because ETH has a shorter history than BTC, confirm with ETH/BTC strength and broader market structure.' : '';
          return `${asset} is trading ${where} its long-term regression fair-value line — zone: ${g.zone_label} (${g.distance_from_fit_percent}% from fit), a ${riskWord} reading on this model.${tail}`;
        }
        const whereSw = where === 'below' ? 'chini ya' : where === 'above' ? 'juu ya' : 'karibu na';
        const riskSw = g.risk_score < 0.4 ? 'hatari ndogo' : g.risk_score < 0.6 ? 'wastani' : g.risk_score < 0.8 ? 'hatari iliyoinuka' : 'imechemka';
        const tailSw = asset === 'ETH' ? ' Kwa kuwa ETH ina historia fupi kuliko BTC, thibitisha na nguvu ya ETH/BTC na muundo wa soko.' : '';
        return `${asset} inafanya biashara ${whereSw} mstari wa thamani wa regression — eneo: ${g.zone_label} (${g.distance_from_fit_percent}% kutoka fit), usomaji wa ${riskSw}.${tailSw}`;
      };
      const parts: string[] = [];
      if (lr.btc) parts.push(line('BTC', lr.btc));
      if (lr.eth) parts.push(line('ETH', lr.eth));
      parts.push(en ? 'This is a historical long-term model, not a price prediction.' : 'Hii ni modeli ya kihistoria ya muda mrefu, si utabiri wa bei.');
      return parts.join(' ');
    }

    case 'exit_simulation_example': {
      // Generic, non-private illustration only ($10k example) — never user data.
      if (!s.exit?.sim_example) return en ? 'Exit simulation example unavailable for this report.' : 'Mfano wa simulesheni haupatikani.';
      const x = s.exit.sim_example;
      const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
      const noExit = x.exit_max_percent <= 0;
      if (en) {
        if (noExit) return `For a ${usd(x.portfolio)} portfolio, the current Exit Risk Score of ${s.exit.score.toFixed(2)} would not suggest major scale-out under the ${x.profile} profile. The model remains in ${x.label} mode. (Illustration only — not based on any user's portfolio.)`;
        const range = x.exit_min_percent === x.exit_max_percent ? `${x.exit_max_percent}%` : `${x.exit_min_percent}–${x.exit_max_percent}%`;
        return `For a ${usd(x.portfolio)} portfolio under the ${x.profile} profile, an Exit Risk Score of ${s.exit.score.toFixed(2)} (${x.label}) maps to a simulated scale-out range of ${range} — about ${usd(x.exit_min_amount)}–${usd(x.exit_max_amount)}, leaving roughly ${usd(x.remaining_min)}–${usd(x.remaining_max)} invested. This is a risk-based simulation, not an instruction to sell, and is not based on any user's portfolio.`;
      }
      if (noExit) return `Kwa portfolio ya ${usd(x.portfolio)}, alama ya sasa ya Exit Risk ${s.exit.score.toFixed(2)} (${x.label}) haileti shinikizo kubwa la scale-out kwenye profaili ya ${x.profile}. (Mfano tu — si portfolio ya mtumiaji yeyote.)`;
      const range = x.exit_min_percent === x.exit_max_percent ? `${x.exit_max_percent}%` : `${x.exit_min_percent}–${x.exit_max_percent}%`;
      return `Kwa portfolio ya ${usd(x.portfolio)} kwenye profaili ya ${x.profile}, alama ya Exit Risk ${s.exit.score.toFixed(2)} (${x.label}) inaonyesha simulesheni ya scale-out ya ${range} — takriban ${usd(x.exit_min_amount)}–${usd(x.exit_max_amount)}, ikibaki takriban ${usd(x.remaining_min)}–${usd(x.remaining_max)} imewekezwa. Ni simulesheni ya hatari, si maelekezo ya kuuza.`;
    }

    default:
      return '';
  }
};

// Structured data (with coin logos) for sections that list coins — the viewer
// and PDF render avatars from this; `content` stays as the text fallback.
interface CoinChip {
  label: string;
  sub: string;
  image: string | null;
}
const sectionData = (key: string, s: ReportSnapshot, lang: Language): Record<string, unknown> | null => {
  const en = lang === 'en';
  if (key === 'strongest_signals') {
    const coins: CoinChip[] = [];
    (s.altcoin?.strongest ?? []).slice(0, 4).forEach((c) => coins.push({ label: `${c.symbol}/BTC`, sub: `${c.label || 'Strength'} · ${c.confidence || (en ? 'Confidence: n/a' : 'Uhakika: n/a')}`, image: c.image }));
    const eco = s.ecosystem?.strongest[0];
    if (eco) coins.push({ label: en ? `${eco.name} ecosystem` : `Ekosistimu ya ${eco.name}`, sub: eco.signal, image: eco.image });
    if (!coins.length) return null;
    return { coins, note: en ? 'These signals show where strength is appearing, but they should still be filtered through liquidity, trend confirmation, and BTC market conditions.' : 'Ishara hizi zinaonyesha nguvu inapojitokeza, lakini bado zichujwe kupitia liquidity, uthibitisho wa trend, na hali ya soko la BTC.' };
  }
  if (key === 'weakest_areas') {
    const coins: CoinChip[] = [];
    (s.altcoin?.weakest ?? []).slice(0, 3).forEach((c) => coins.push({ label: `${c.symbol}/BTC`, sub: c.label || (en ? 'Still weak' : 'Bado dhaifu'), image: c.image }));
    (s.ecosystem?.weakest ?? []).slice(0, 3).forEach((e) => coins.push({ label: en ? `${e.name} ecosystem` : `Ekosistimu ya ${e.name}`, sub: e.signal, image: e.image }));
    if (!coins.length) return null;
    return { coins, note: en ? 'Weak BTC pairs remain a risk while altcoin rotation is not broad. Avoid assuming strength in assets still underperforming BTC.' : 'Pairs dhaifu za BTC bado ni hatari wakati mzunguko wa altcoin siyo pana. Epuka kudhani nguvu kwenye assets zinazoshindwa na BTC.' };
  }
  return null;
};

const buildSummary = (s: ReportSnapshot, lang: Language, short: boolean) => sectionContent('executive_summary', s, lang, short);

const buildTakeaway = (s: ReportSnapshot, lang: Language): string => {
  const en = lang === 'en';
  const score = s.risk?.score ?? null;
  const broad = s.altcoin ? isBroad(s.altcoin.regime) : false;
  if (en) {
    if (score != null && score >= 0.8) return 'The market is showing high-risk conditions. BTC risk is elevated, so favour capital preservation and focus on confirmed leaders only until risk eases.';
    if (broad) return 'Breadth is improving toward broad strength, but confirmation still matters. Favour leaders that hold strength against BTC, and manage risk as the move extends.';
    return 'The market is improving, but not broadly risk-on yet. BTC remains in a low-risk DCA environment, on-chain metrics are calm, and social attention is quiet. Altcoin strength is selective, so focus should remain on confirmed leaders while avoiding weak BTC pairs until breadth and ecosystem rotation improve.';
  }
  if (score != null && score >= 0.8) return 'Soko liko kwenye hatari kubwa. Linda mtaji na zingatia viongozi waliothibitishwa tu mpaka hatari ipungue.';
  if (broad) return 'Breadth inaboreka kuelekea nguvu pana, lakini uthibitisho bado ni muhimu. Pendelea viongozi wanaoshikilia nguvu dhidi ya BTC na dhibiti hatari.';
  return 'Soko linaboreka, lakini bado siyo risk-on pana. BTC ipo kwenye eneo la low-risk DCA, on-chain ipo shwari, na social attention ipo quiet. Nguvu ya altcoin ni ya kuchagua, hivyo zingatia viongozi waliothibitishwa na epuka weak BTC pairs mpaka breadth na ekosistimu ziimarike.';
};

const DISCLAIMER: Record<Language, string> = {
  en: 'Not financial advice. Pastatrade provides ranking-based market intelligence and probability-style scoring. Scores describe current conditions, not guaranteed future performance. Always do your own research.',
  sw: 'Si ushauri wa kifedha. Pastatrade hutoa taswira ya soko kwa mfumo wa ranking na alama za uwezekano. Alama zinaeleza hali ya sasa, siyo uhakika wa matokeo ya baadaye. Daima fanya utafiti wako mwenyewe.'
};

const buildScorecard = (s: ReportSnapshot, lang: Language): ScorecardItem[] => {
  const items: ScorecardItem[] = [];
  if (s.risk?.score != null) items.push({ label: 'BTC Risk', value: s.risk.score.toFixed(3), note: s.risk.dca_zone ?? '' });
  if (s.altcoin?.breadth_pct != null) items.push({ label: 'Altcoin Breadth', value: `${s.altcoin.breadth_pct.toFixed(0)}%`, note: s.altcoin.regime });
  if (s.onchain?.composite != null) items.push({ label: 'On-chain Risk', value: s.onchain.composite.toFixed(3), note: onchainBand(s.onchain.composite, lang) });
  if (s.social?.score != null) items.push({ label: 'Social Risk', value: s.social.score.toFixed(3), note: s.social.label ?? '' });
  return items;
};

/** Generate a full report (deterministic) from a snapshot. */
export const generateReport = (snapshot: ReportSnapshot, opts: GenerateOptions): GeneratedReport => {
  const { language: lang, tone, sections, type, report_date } = opts;
  const short = tone === 'channel' || tone === 'whatsapp';

  const title =
    lang === 'en'
      ? `Pastatrade ${TYPE_LABEL[type].en} Market Intelligence — ${fmtDate(report_date)}`
      : `Pastatrade Taarifa ya Soko ${TYPE_LABEL[type].sw} — ${fmtDate(report_date)}`;

  const summary = buildSummary(snapshot, lang, short);
  const premium_takeaway = buildTakeaway(snapshot, lang);
  const scorecard = buildScorecard(snapshot, lang);
  const market_status = {
    regime: regimeOf(snapshot, lang),
    btc_risk: snapshot.risk?.dca_zone ?? (lang === 'en' ? 'unavailable' : 'haipatikani'),
    altcoin: snapshot.altcoin?.regime ?? (lang === 'en' ? 'unavailable' : 'haipatikani'),
    social: snapshot.social?.label ?? (lang === 'en' ? 'unavailable' : 'haipatikani')
  };

  const built: GeneratedSection[] = [];
  sections.forEach((key, i) => {
    let content: string;
    if (key === 'disclaimer') content = DISCLAIMER[lang];
    else if (key === 'executive_summary') content = summary;
    else if (key === 'premium_takeaway') content = premium_takeaway;
    else content = sectionContent(key, snapshot, lang, short);
    if (!content) return;
    built.push({
      section_key: key,
      section_title: (SECTION_TITLES[key] ?? { en: key, sw: key })[lang],
      content,
      data: sectionData(key, snapshot, lang),
      is_premium: PREMIUM_SECTIONS.has(key),
      sort_order: i
    });
  });

  const content = built.map((sec) => `## ${sec.section_title}\n${sec.content}`).join('\n\n');
  const teaserSummary = summary.split('. ').slice(0, 2).join('. ');
  const preview =
    lang === 'en'
      ? `${teaserSummary}${teaserSummary.endsWith('.') ? '' : '.'} Premium members can view the full breakdown of BTC risk, on-chain data, ecosystem rotation and Alt/BTC signals.`
      : `${teaserSummary}${teaserSummary.endsWith('.') ? '' : '.'} Wanachama wa Premium wanaweza kuona uchambuzi kamili wa hatari ya BTC, on-chain, ekosistimu na ishara za Alt/BTC.`;

  // ── quality check ──
  const lc = built
    .filter((s) => s.section_key !== 'disclaimer')
    .map((s) => s.content)
    .join(' ')
    .toLowerCase();
  const checks: Record<string, boolean> = {
    has_executive_summary: sections.includes('executive_summary'),
    has_btc_risk: snapshot.risk != null && sections.includes('btc_risk'),
    has_market_regime: sections.includes('market_status'),
    has_what_changed: sections.includes('what_changed'),
    has_market_posture: sections.includes('market_posture'),
    has_premium_takeaway: premium_takeaway.length > 0,
    has_data_coverage: sections.includes('data_coverage'),
    has_disclaimer: sections.includes('disclaimer'),
    data_available: snapshot.risk != null || snapshot.altcoin != null,
    not_hypey: !BANNED.some((b) => lc.includes(b)),
    unavailable_disclosed: Object.entries(snapshot.availability)
      .filter(([k, v]) => v === 'unavailable' && sections.includes(k))
      .every(() => lc.includes('unavailable'))
  };

  // Expectations vary by report type — daily is intentionally short.
  const needChanged = type === 'daily' || type === 'weekly' || type === 'monthly';
  const needPosture = type === 'monthly';
  const needCoverage = type === 'weekly' || type === 'monthly';

  const requiredOk = checks.has_btc_risk && checks.has_market_regime && checks.has_premium_takeaway && checks.has_disclaimer && checks.data_available;
  const softOk =
    checks.not_hypey &&
    checks.unavailable_disclosed &&
    (!needChanged || checks.has_what_changed) &&
    (!needPosture || checks.has_market_posture) &&
    (!needCoverage || checks.has_data_coverage);
  const status: QualityResult['status'] = !requiredOk ? 'Missing required sections' : softOk ? 'Passed' : 'Needs review';

  const warnings: string[] = [];
  if (!checks.has_btc_risk) warnings.push('BTC risk section is missing or has no data.');
  if (!checks.has_disclaimer) warnings.push('Disclaimer section is missing.');
  if (!checks.has_premium_takeaway) warnings.push('Premium takeaway is missing.');
  if (!checks.not_hypey) warnings.push('Content contains hype-style language that should be removed.');
  if (!checks.data_available) warnings.push('Core modules (risk / altcoin) were unavailable at generation time.');
  if (needChanged && !checks.has_what_changed) warnings.push('"What Changed" section is not included.');
  if (needPosture && !checks.has_market_posture) warnings.push('"Market Posture" section is not included.');
  if (needCoverage && !checks.has_data_coverage) warnings.push('"Data Coverage" section is not included.');
  Object.entries(snapshot.availability)
    .filter(([, v]) => v === 'unavailable')
    .forEach(([k]) => warnings.push(`Module "${MODULE_LABELS[k] ?? k}" was unavailable and is disclosed in the report.`));

  return {
    title,
    market_status,
    scorecard,
    summary,
    premium_takeaway,
    preview,
    content,
    sections: built,
    quality: { status, passed: status === 'Passed', checks, warnings }
  };
};
