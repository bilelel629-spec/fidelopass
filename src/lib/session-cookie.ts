const COOKIE_NAME = 'fp_session';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

export function setSessionCookie(accessToken: string) {
  if (typeof document === 'undefined') return;
  const securePart = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(accessToken)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax${securePart}`;
}

export function clearSessionCookie() {
  if (typeof document === 'undefined') return;
  const securePart = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax${securePart}`;
}

export function getSessionCookieName() {
  return COOKIE_NAME;
}
