import { collectIcoProjects } from '../sources/icodrops.client';
import { collectCryptorankProjects } from '../sources/cryptorank.client';
import { storeIcoProjects } from './icoIntelligence.service';
import { watchedIds } from './cryptorankWatch.service';

// Collect from every configured source → score → store (deduped across sources).
// Graceful throughout: each source contributes 0 when unconfigured/empty.
//
// CryptoRank (primary) is tracked-by-id on the free plan: it enriches the
// admin-managed watchlist. ICO Drops is secondary and off by default.
export const runIcoSync = async (): Promise<number> => {
  let total = 0;

  const ids = await watchedIds();
  if (ids.length) {
    const projects = await collectCryptorankProjects(ids);
    if (projects.length) {
      const { inserted, updated } = await storeIcoProjects(projects, 'cryptorank');
      total += inserted + updated;
    }
  }

  const ic = await collectIcoProjects();
  if (ic.projects.length) {
    const { inserted, updated } = await storeIcoProjects(ic.projects, 'icodrops');
    total += inserted + updated;
  }

  return total;
};
