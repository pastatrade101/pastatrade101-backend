import { loadHistory, syncHistory } from './data';
import { createMoonRun, type MoonParams } from './engine';
import { RUNS_TABLE_MISSING, runsTableReady, saveRun } from './store';

// One backtest job at a time, run inside the server process. The candle download
// is network-bound; the replay is chunked (a few hundred days at a time, yielding
// between chunks) so the API keeps answering other requests while it runs.

export interface JobRun {
  name: string;
  params: MoonParams;
}

export interface JobState {
  id: string;
  status: 'running' | 'done' | 'failed';
  stage: string;
  done: number;
  total: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  /** Problems that did not stop the job (pairs that failed to download). */
  warnings: string[];
  runs: { name: string; id: string | null }[];
  by: string;
}

let job: JobState | null = null;

export class JobBusy extends Error {}

export const currentJob = (): JobState | null => job;

const tick = () => new Promise<void>((r) => setImmediate(r));

export const startJob = async (runs: JobRun[], by: string): Promise<JobState> => {
  if (job?.status === 'running') throw new JobBusy('A backtest is already running — wait for it to finish.');
  if (!(await runsTableReady())) throw new Error(RUNS_TABLE_MISSING);
  const state: JobState = {
    id: `${Date.now().toString(36)}`,
    status: 'running',
    stage: 'Starting',
    done: 0,
    total: 1,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    warnings: [],
    runs: runs.map((r) => ({ name: r.name, id: null })),
    by
  };
  job = state;
  void (async () => {
    try {
      const sync = await syncHistory((stage, done, total) => Object.assign(state, { stage, done, total }));
      if (sync.failed.length) state.warnings.push(`${sync.failed.length} pair(s) could not be downloaded this time and were left out or kept at their last saved candles: ${sync.failed.slice(0, 5).join('; ')}${sync.failed.length > 5 ? ' …' : ''}`);
      Object.assign(state, { stage: 'Loading candles', done: 0, total: 1 });
      await tick();
      const history = loadHistory();
      for (const [k, r] of runs.entries()) {
        const run = createMoonRun(history, r.params);
        const label = runs.length > 1 ? `Backtest ${k + 1} of ${runs.length}: ${r.name}` : `Backtest: ${r.name}`;
        Object.assign(state, { stage: label, done: 0, total: run.totalDays });
        while (!run.step(120)) {
          state.done = run.doneDays();
          await tick();
        }
        state.stage = `${label} — saving`;
        state.runs[k].id = await saveRun(r.name, run.result(), by);
      }
      Object.assign(state, { status: 'done', stage: 'Finished', done: state.total, finishedAt: new Date().toISOString() });
    } catch (e) {
      Object.assign(state, { status: 'failed', error: e instanceof Error ? e.message : String(e), finishedAt: new Date().toISOString() });
    }
  })();
  return state;
};
