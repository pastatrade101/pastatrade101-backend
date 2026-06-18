// One-shot ingestion run for cron / manual use: `npm run sync`.
// Exits non-zero on failure so a scheduler can detect problems.
import { runFullSync } from '../services/sync';

(async () => {
  console.log('▶ Pastatrade full sync starting…');
  const started = Date.now();
  try {
    const result = await runFullSync();
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`✓ Sync complete in ${seconds}s:`, result);
    process.exit(0);
  } catch (error) {
    console.error('✗ Sync failed:', error);
    process.exit(1);
  }
})();
