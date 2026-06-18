// Prebake the Lab price series (BTC full history + top-100 CoinGecko coins) so
// the Labs serve saved data. Heavy (~100 throttled CoinGecko calls) — run on a
// schedule (e.g. daily cron): `npm run sync:prices`.
import { syncPriceSeries } from '../services/sync/sync-price-series';

(async () => {
  console.log('▶ Lab price-series sync starting…');
  const started = Date.now();
  try {
    const count = await syncPriceSeries();
    console.log(`✓ Stored ${count} series in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    process.exit(0);
  } catch (error) {
    console.error('✗ Price-series sync failed:', error);
    process.exit(1);
  }
})();
