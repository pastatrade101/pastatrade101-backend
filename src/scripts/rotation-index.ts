/**
 * Rotation Index — start it, or add the days since the last saved one.
 *
 *   npm run index:rotation -- --start       create it on the newest final day (once)
 *   npm run index:rotation                  add any final days not saved yet
 *   options: --dry-run (compute and print, write nothing)   --id rotation-balanced
 *            --from YYYY-MM-DD with --dry-run: replay from a past date (a check, never saved)
 *
 * The price sync does the daily step on its own once the index exists.
 */
import { isIndexId, stepRotationIndex } from '../services/rotation-index/rotationIndex.service';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const id = arg('id') ?? 'rotation-balanced';
const start = process.argv.includes('--start');
const dryRun = process.argv.includes('--dry-run');
const from = arg('from'); // dry runs only: replay from a past date

(async () => {
  if (!isIndexId(id)) throw new Error(`Unknown index: ${id}`);
  const r = await stepRotationIndex(id, { start: start || Boolean(from), dryRun, from });
  for (const w of r.warnings) console.log(`! ${w}`);
  if (!r.added) {
    console.log(r.note === 'not started' ? `${id} has not been started — run with --start.` : `${id} is up to date.`);
    process.exit(0);
  }
  console.log(`${dryRun ? 'Would add' : '✓ Added'} ${r.added} day(s) to ${id}: ${r.from} → ${r.to}`);
  for (const row of r.rows ?? []) {
    const t = row.trades?.index.map((x) => `${x.side} ${x.coin} ${x.value.toFixed(2)}`).join(', ');
    const v = row.review ? `review → sell [${row.review.sells.map((s) => s.coin).join(', ')}] buy [${row.review.adds.join(', ')}] keep [${row.review.keep.join(', ')}]` : '';
    console.log(`  ${row.date}  index ${row.nav.toFixed(2)}  BTC ${row.btc.toFixed(2)}  top-10 ${row.top10.toFixed(2)}  ${t ?? ''} ${v}`);
  }
  if (r.latest && !dryRun) console.log(`  latest ${r.latest.date}: index ${r.latest.nav.toFixed(2)}, BTC ${r.latest.btc.toFixed(2)}, top-10 ${r.latest.top10.toFixed(2)}`);
  process.exit(0);
})().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
