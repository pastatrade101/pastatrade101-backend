import { supabase } from '../../config/supabase';

// Admin audit trail. Best-effort: a logging failure (e.g. the table not migrated
// yet) must never break the admin action itself, so every write is guarded.

export type AuditAction = 'plan_change' | 'status_change' | 'extend' | 'cancel' | 'suspend' | 'reactivate' | 'note';

export const auditLog = async (
  adminId: string | null,
  actionType: AuditAction,
  targetUserId: string,
  oldValue: unknown = null,
  newValue: unknown = null,
  note?: string | null
): Promise<void> => {
  try {
    await supabase.from('admin_audit_logs').insert({
      admin_id: adminId,
      target_user_id: targetUserId,
      action_type: actionType,
      old_value: oldValue ?? null,
      new_value: newValue ?? null,
      note: note ?? null
    });
  } catch (err) {
    console.warn('[audit] failed to write audit log:', (err as Error)?.message ?? err);
  }
};

export const listAuditForUser = async (userId: string, limit = 25): Promise<Record<string, unknown>[]> => {
  try {
    const { data } = await supabase
      .from('admin_audit_logs')
      .select('id, admin_id, action_type, old_value, new_value, note, created_at, admin:users!admin_audit_logs_admin_id_fkey(full_name, email)')
      .eq('target_user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    return data ?? [];
  } catch {
    return [];
  }
};
