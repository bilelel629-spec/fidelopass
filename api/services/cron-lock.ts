import type { createServiceClient } from '../../src/lib/supabase';

type ServiceClient = ReturnType<typeof createServiceClient>;

const processOwner = [
  process.env.RAILWAY_REPLICA_ID,
  process.env.RAILWAY_DEPLOYMENT_ID,
  process.env.HOSTNAME,
  process.pid,
].filter(Boolean).join(':') || `process:${process.pid}`;

type CronLockResult<T> = {
  acquired: boolean;
  value?: T;
  error?: unknown;
};

function isMissingLockRpc(error: { code?: string; message?: string } | null | undefined) {
  const message = error?.message ?? '';
  return error?.code === 'PGRST202' || error?.code === '42883' || /try_acquire_cron_lock|function .*does not exist/i.test(message);
}

export async function withCronLock<T>(
  db: ServiceClient,
  name: string,
  ttlSeconds: number,
  task: () => Promise<T>,
): Promise<CronLockResult<T>> {
  const { data: acquired, error } = await db.rpc('try_acquire_cron_lock', {
    p_name: name,
    p_ttl_seconds: ttlSeconds,
    p_owner: processOwner,
  });

  if (error) {
    console.warn(`[cron-lock] ${name} indisponible:`, error.message);
    if (isMissingLockRpc(error)) {
      const value = await task();
      return { acquired: true, value, error };
    }
    return { acquired: false, error };
  }

  if (!acquired) return { acquired: false };

  try {
    const value = await task();
    return { acquired: true, value };
  } finally {
    const { error: releaseError } = await db.rpc('release_cron_lock', {
      p_name: name,
      p_owner: processOwner,
    });
    if (releaseError) {
      console.warn(`[cron-lock] release ${name} failed:`, releaseError.message);
    }
  }
}
