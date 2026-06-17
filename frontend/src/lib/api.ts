// Centralized auth-aware fetch wrapper.
// All authenticated API calls MUST go through apiFetch — it guarantees:
//   1. JWT token auto-injected (Bearer header)
//   2. On 401 / network auth failure → clear token + force reload to login page
// This is the single source of truth for STORAGE_KEY and token handling.
// Without this, a stale/expired token leaves the UI stuck showing "auth failed"
// no matter how many times the user refreshes (App.tsx reads token at boot).

export const STORAGE_KEY = 'nexus_token'

/**
 * Auth-aware fetch. Wraps window.fetch.
 * - Reads token from localStorage and injects `Authorization: Bearer <token>`.
 * - On HTTP 401, clears the token and reloads so App.tsx falls back to login.
 * - init.headers may override (merged on top of injected Authorization).
 */
export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem(STORAGE_KEY)
  const injectedHeaders: Record<string, string> = {}
  if (token) injectedHeaders.Authorization = `Bearer ${token}`

  // Merge: caller headers override injected ones (but Authorization only if caller sets it).
  const headers = new Headers(init.headers || {})
  for (const [k, v] of Object.entries(injectedHeaders)) {
    if (!headers.has(k)) headers.set(k, v)
  }

  const res = await fetch(input, { ...init, headers })

  if (res.status === 401) {
    // Token rejected (expired, revoked, or JWT_SECRET changed on server).
    // Clear + reload so user re-authenticates. Without this, the app keeps
    // retrying with the same dead token forever.
    handleAuthFailure()
  }

  return res
}

/**
 * Centralized auth-failure handler. Also used by the WebSocket layer on
 * close code 4001 (jwt.verify failure) so both transports share one recovery path.
 */
export function handleAuthFailure(): void {
  localStorage.removeItem(STORAGE_KEY)
  // Hard reload → App.tsx re-reads token (now null) → renders login page.
  // Using reload (not router nav) because there is no router; this is the
  // simplest guaranteed reset of all in-memory state holding the stale token.
  if (typeof window !== 'undefined') {
    window.location.reload()
  }
}
