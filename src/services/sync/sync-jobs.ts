import { supabase } from '../../config/supabase';

export interface SyncJobHandle {
  id: string | null;
}

/** Open a sync_jobs row in `running` state. Returns a handle even if the insert fails. */
export const startJob = async (
  source: string,
  jobType: string,
  triggeredBy?: string
): Promise<SyncJobHandle> => {
  const { data } = await supabase
    .from('sync_jobs')
    .insert({ source, job_type: jobType, status: 'running', triggered_by: triggeredBy ?? null })
    .select('id')
    .single();

  return { id: data?.id ?? null };
};

export const finishJob = async (
  handle: SyncJobHandle,
  status: 'success' | 'failed',
  recordsProcessed = 0,
  error?: string
): Promise<void> => {
  if (!handle.id) return;
  await supabase
    .from('sync_jobs')
    .update({
      status,
      records_processed: recordsProcessed,
      error: error ?? null,
      finished_at: new Date().toISOString()
    })
    .eq('id', handle.id);
};

/** Run `task` wrapped in a sync_jobs lifecycle (running → success/failed). */
export const withJob = async (
  source: string,
  jobType: string,
  triggeredBy: string | undefined,
  task: () => Promise<number>
): Promise<{ jobId: string | null; records: number }> => {
  const handle = await startJob(source, jobType, triggeredBy);
  try {
    const records = await task();
    await finishJob(handle, 'success', records);
    return { jobId: handle.id, records };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishJob(handle, 'failed', 0, message);
    throw error;
  }
};
