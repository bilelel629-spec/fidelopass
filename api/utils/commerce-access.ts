import type { SupabaseClient, User } from '@supabase/supabase-js';

export type CommerceMemberRole = 'owner' | 'admin' | 'staff';

export type CommerceAccess = {
  commerceId: string;
  role: CommerceMemberRole;
  isOwner: boolean;
};

type SupabaseErrorLike = {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
} | null | undefined;

const MEMBER_ROLES = new Set(['owner', 'admin', 'staff']);

export function normalizeMemberEmail(email: string) {
  return email.trim().toLowerCase();
}

export function isMissingCommerceMembersTable(error: SupabaseErrorLike) {
  const text = `${error?.message ?? ''} ${error?.details ?? ''} ${error?.hint ?? ''}`;
  return /commerce_members|schema cache|does not exist|relation/i.test(text);
}

function isNoRowsError(error: SupabaseErrorLike) {
  return error?.code === 'PGRST116' || /0 rows|no rows|multiple \(or no\) rows/i.test(error?.message ?? '');
}

function normalizeRole(role: unknown): CommerceMemberRole {
  const value = String(role ?? 'staff').toLowerCase();
  return MEMBER_ROLES.has(value) ? (value as CommerceMemberRole) : 'staff';
}

export async function resolveCommerceAccess(db: SupabaseClient, userId: string): Promise<CommerceAccess | null> {
  const owned = await db
    .from('commerces')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle();

  if (owned.error && !isNoRowsError(owned.error)) {
    throw owned.error;
  }

  if (owned.data?.id) {
    return { commerceId: owned.data.id, role: 'owner', isOwner: true };
  }

  const member = await db
    .from('commerce_members')
    .select('commerce_id, role, status')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (member.error) {
    if (isMissingCommerceMembersTable(member.error) || isNoRowsError(member.error)) return null;
    throw member.error;
  }

  if (!member.data?.commerce_id) return null;
  const role = normalizeRole(member.data.role);
  return {
    commerceId: member.data.commerce_id,
    role,
    isOwner: role === 'owner',
  };
}

export async function findAuthUserByEmail(db: SupabaseClient, email: string): Promise<User | null> {
  const normalizedEmail = normalizeMemberEmail(email);

  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;

    const users = data?.users ?? [];
    const match = users.find((user) => normalizeMemberEmail(user.email ?? '') === normalizedEmail);
    if (match) return match;
    if (users.length < 1000) break;
  }

  return null;
}
