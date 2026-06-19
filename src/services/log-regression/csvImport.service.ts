import { supabase } from '../../config/supabase';
import { ASSET_IDS, type AssetSymbol } from './logRegressionSettings.service';

// CSV import for daily prices. Accepts common exports (CoinGecko, CryptoDataDownload,
// CoinMarketCap, custom). Detects columns by header name, normalizes dates to
// YYYY-MM-DD, and upserts into asset_daily_prices.

export interface ImportSummary {
  rows_imported: number;
  rows_updated: number;
  first_date: string | null;
  last_date: string | null;
  errors: string[];
}

// Minimal CSV line parser (handles quoted fields with embedded commas).
const parseLine = (line: string): string[] => {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
};

const num = (v: string | undefined): number | null => {
  if (v == null) return null;
  const cleaned = v.replace(/[$,\s]/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

// Normalize a variety of date formats to YYYY-MM-DD.
const normDate = (v: string | undefined): string | null => {
  if (!v) return null;
  const s = v.trim().replace(/^"|"$/g, '');
  // Already ISO-ish (YYYY-MM-DD or full timestamp).
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // Unix seconds / ms.
  if (/^\d{10,13}$/.test(s)) {
    const ms = s.length === 13 ? Number(s) : Number(s) * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  // MM/DD/YYYY or DD/MM/YYYY (assume MM/DD for US exports).
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slash) return `${slash[3]}-${slash[1].padStart(2, '0')}-${slash[2].padStart(2, '0')}`;
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
};

const findCol = (headers: string[], candidates: string[]): number => {
  const lower = headers.map((h) => h.toLowerCase().replace(/[\s_]+/g, ''));
  for (const cand of candidates) {
    const idx = lower.indexOf(cand.toLowerCase().replace(/[\s_]+/g, ''));
    if (idx >= 0) return idx;
  }
  return -1;
};

export const importCsv = async (asset: AssetSymbol, csv: string, sourceName?: string): Promise<ImportSummary> => {
  const errors: string[] = [];
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return { rows_imported: 0, rows_updated: 0, first_date: null, last_date: null, errors: ['CSV has no data rows.'] };

  const headers = parseLine(lines[0]);
  const cDate = findCol(headers, ['date', 'snappedat', 'timestamp', 'time', 'timeopen']);
  const cPrice = findCol(headers, ['price', 'priceusd', 'pricecloseusd']);
  const cClose = findCol(headers, ['close']);
  const cOpen = findCol(headers, ['open']);
  const cHigh = findCol(headers, ['high']);
  const cLow = findCol(headers, ['low']);
  const cVol = findCol(headers, ['volume', 'totalvolume', 'volumeusd']);
  const cMcap = findCol(headers, ['marketcap', 'marketcapusd']);

  if (cDate < 0) return { rows_imported: 0, rows_updated: 0, first_date: null, last_date: null, errors: ['Could not find a date column.'] };
  if (cPrice < 0 && cClose < 0) return { rows_imported: 0, rows_updated: 0, first_date: null, last_date: null, errors: ['Could not find a price or close column.'] };

  const byDate = new Map<string, Record<string, unknown>>();
  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseLine(lines[i]);
    const date = normDate(cells[cDate]);
    if (!date) {
      if (errors.length < 10) errors.push(`Row ${i + 1}: unrecognized date "${cells[cDate] ?? ''}".`);
      continue;
    }
    const close = cClose >= 0 ? num(cells[cClose]) : null;
    const priceCol = cPrice >= 0 ? num(cells[cPrice]) : null;
    const price = priceCol ?? close;
    if (price == null || price <= 0) {
      if (errors.length < 10) errors.push(`Row ${i + 1}: missing/invalid price.`);
      continue;
    }
    // Last value for a given date wins (handles duplicates within the file).
    byDate.set(date, {
      asset_symbol: asset,
      asset_id: ASSET_IDS[asset],
      date,
      open: cOpen >= 0 ? num(cells[cOpen]) : null,
      high: cHigh >= 0 ? num(cells[cHigh]) : null,
      low: cLow >= 0 ? num(cells[cLow]) : null,
      close: close ?? price,
      price_usd: price,
      volume: cVol >= 0 ? num(cells[cVol]) : null,
      market_cap: cMcap >= 0 ? num(cells[cMcap]) : null,
      source_name: sourceName ?? 'csv',
      updated_at: new Date().toISOString()
    });
  }

  const rows = [...byDate.values()].sort((x, y) => (x.date as string).localeCompare(y.date as string));
  if (!rows.length) return { rows_imported: 0, rows_updated: 0, first_date: null, last_date: null, errors: errors.length ? errors : ['No valid rows parsed.'] };

  for (let i = 0; i < rows.length; i += 1000) {
    const { error } = await supabase.from('asset_daily_prices').upsert(rows.slice(i, i + 1000), { onConflict: 'asset_symbol,date' });
    if (error) throw error;
  }

  return {
    rows_imported: rows.length,
    rows_updated: 0,
    first_date: rows[0].date as string,
    last_date: rows[rows.length - 1].date as string,
    errors
  };
};
