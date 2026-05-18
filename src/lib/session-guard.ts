type SupabaseSession = {
  access_token: string;
  expires_at?: number | null;
};

type SupabaseLike = {
  auth: {
    getSession: () => Promise<{ data: { session: SupabaseSession | null }; error?: unknown }>;
    refreshSession: () => Promise<{ data: { session: SupabaseSession | null }; error?: unknown }>;
  };
};

type SessionOverlay = {
  remove: () => void;
  setText: (title: string, body?: string) => void;
};

const SESSION_REFRESH_LEEWAY_SECONDS = 90;
const SESSION_IDLE_REFRESH_MS = 8 * 60 * 1000;
const SESSION_LAST_ACTIVITY_KEY = 'fidelopass:last-activity-at';
const SESSION_TRACKING_FLAG = '__fidelopassSessionActivityTracking';

declare global {
  interface Window {
    __fidelopassSessionActivityTracking?: boolean;
  }
}

export function currentPathWithSearch() {
  return `${window.location.pathname}${window.location.search}`;
}

export function safeRedirectPath(value: string | null | undefined, fallback = '/dashboard') {
  if (!value) return fallback;
  if (!value.startsWith('/') || value.startsWith('//')) return fallback;
  if (value.startsWith('/login') || value.startsWith('/register')) return fallback;
  return value;
}

export function loginUrlForCurrentPage() {
  return `/login?redirect=${encodeURIComponent(currentPathWithSearch())}`;
}

export function showSessionOverlay(
  title = 'Reconnexion en cours...',
  body = 'Nous rafraîchissons votre session Fidelopass.',
): SessionOverlay {
  const existing = document.getElementById('session-refresh-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'session-refresh-overlay';
  overlay.setAttribute('role', 'status');
  overlay.setAttribute('aria-live', 'polite');
  overlay.className = 'fixed inset-0 z-[9999] flex items-center justify-center bg-[#f5f9ff]/92 px-5 backdrop-blur-md';
  overlay.innerHTML = `
    <div class="w-full max-w-sm rounded-2xl border border-sky-100 bg-white p-6 text-center shadow-2xl">
      <div class="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-sky-100 border-t-sky-600"></div>
      <p data-session-title class="mt-4 text-base font-semibold text-slate-900">${title}</p>
      <p data-session-body class="mt-2 text-sm leading-relaxed text-slate-500">${body}</p>
    </div>
  `;
  document.body.appendChild(overlay);

  return {
    remove: () => overlay.remove(),
    setText: (nextTitle: string, nextBody = '') => {
      const titleNode = overlay.querySelector('[data-session-title]');
      const bodyNode = overlay.querySelector('[data-session-body]');
      if (titleNode) titleNode.textContent = nextTitle;
      if (bodyNode) bodyNode.textContent = nextBody;
    },
  };
}

function readLastActivityAt() {
  try {
    const value = window.localStorage.getItem(SESSION_LAST_ACTIVITY_KEY);
    const timestamp = value ? Number(value) : 0;
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
  } catch {
    return null;
  }
}

export function markSessionActivity(now = Date.now()) {
  try {
    window.localStorage.setItem(SESSION_LAST_ACTIVITY_KEY, String(now));
  } catch {
    // localStorage can be unavailable in strict privacy contexts.
  }
}

export function shouldShowSessionRefreshOverlay(thresholdMs = SESSION_IDLE_REFRESH_MS) {
  const lastActivityAt = readLastActivityAt();
  if (!lastActivityAt) return false;
  return Date.now() - lastActivityAt > thresholdMs;
}

export function bindSessionActivityTracking() {
  if (window[SESSION_TRACKING_FLAG]) return;
  window[SESSION_TRACKING_FLAG] = true;

  let lastWriteAt = 0;
  const recordActivity = () => {
    const now = Date.now();
    if (now - lastWriteAt < 2000) return;
    lastWriteAt = now;
    markSessionActivity(now);
  };

  ['pointerdown', 'keydown', 'touchstart', 'scroll'].forEach((eventName) => {
    window.addEventListener(eventName, recordActivity, { passive: true });
  });
}

function sessionNeedsRefresh(session: SupabaseSession | null) {
  if (!session?.access_token) return true;
  if (!session.expires_at) return false;
  return session.expires_at - Math.floor(Date.now() / 1000) < SESSION_REFRESH_LEEWAY_SECONDS;
}

export async function getFreshSession(supabase: SupabaseLike): Promise<SupabaseSession | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (session && !sessionNeedsRefresh(session)) {
    markSessionActivity();
    return session;
  }

  const { data, error } = await supabase.auth.refreshSession();
  if (!error && data.session?.access_token) {
    markSessionActivity();
    return data.session;
  }

  if (session?.access_token) {
    markSessionActivity();
    return session;
  }

  return null;
}

export async function requireFreshSession(
  supabase: SupabaseLike,
  options: {
    redirectToLogin?: boolean;
    overlay?: SessionOverlay;
  } = {},
) {
  const { redirectToLogin = true, overlay } = options;
  const session = await getFreshSession(supabase);
  if (session?.access_token) return session;

  if (redirectToLogin) {
    overlay?.setText('Connexion requise', 'Votre session a expiré. Redirection vers la connexion...');
    window.location.replace(loginUrlForCurrentPage());
  }
  return null;
}
