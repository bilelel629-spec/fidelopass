import { createServiceClient } from '../../src/lib/supabase';

type AdminAuditInput = {
  adminUserId: string;
  adminEmail?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  payload?: Record<string, unknown>;
};

export async function appendAdminAuditLog(input: AdminAuditInput) {
  const db = createServiceClient();
  const { error } = await db.from('admin_audit_logs').insert({
    admin_user_id: input.adminUserId,
    admin_email: input.adminEmail ?? null,
    action: input.action,
    target_type: input.targetType,
    target_id: input.targetId ?? null,
    payload: input.payload ?? {},
  });

  if (error) {
    // La table peut être absente avant migration, on évite de casser le flux admin.
    if (error.code !== '42P01') {
      console.error('[admin-audit] insert failed:', error.message);
    }
  }
}

export async function listAdminAuditLogs(limit = 20) {
  const db = createServiceClient();
  const safeLimit = Math.max(1, Math.min(limit, 100));
  const { data, error } = await db
    .from('admin_audit_logs')
    .select('id, admin_user_id, admin_email, action, target_type, target_id, payload, created_at')
    .order('created_at', { ascending: false })
    .limit(safeLimit);

  if (error) {
    if (error.code !== '42P01') {
      console.error('[admin-audit] list failed:', error.message);
    }
    return [];
  }

  return data ?? [];
}
