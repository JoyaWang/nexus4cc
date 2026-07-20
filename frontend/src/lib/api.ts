// Centralized auth-aware fetch wrapper.
// All authenticated API calls MUST go through apiFetch — it guarantees:
//   1. JWT token auto-injected (Bearer header)
//   2. On 401 → single-flight POST /api/auth/refresh, atomic token pair replace, retry once
//   3. On refresh failure → clear tokens + force reload to login page
// This is the single source of truth for STORAGE_KEY and token handling.

import {
  getAccessToken,
  getRefreshToken,
  refreshTokens,
  clearTokens,
  ACCESS_TOKEN_KEY,
} from './authSession';

export const STORAGE_KEY = ACCESS_TOKEN_KEY;

let _isRetrying = false;

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const token = getAccessToken();
  const injectedHeaders: Record<string, string> = {};
  if (token) injectedHeaders.Authorization = `Bearer ${token}`;

  const headers = new Headers(init.headers || {});
  for (const [k, v] of Object.entries(injectedHeaders)) {
    if (!headers.has(k)) headers.set(k, v);
  }

  const res = await fetch(input, { ...init, headers });

  if (res.status === 401 && !_isRetrying && getRefreshToken()) {
    _isRetrying = true;
    try {
      const { accessToken } = await refreshTokens();
      const retryHeaders = new Headers(init.headers || {});
      retryHeaders.set('Authorization', `Bearer ${accessToken}`);
      return fetch(input, { ...init, headers: retryHeaders });
    } catch {
      // refreshTokens already clears tokens and reloads on failure
      return res;
    } finally {
      _isRetrying = false;
    }
  }

  if (res.status === 401) {
    handleAuthFailure();
  }

  return res;
}

export function handleAuthFailure(): void {
  clearTokens();
  if (typeof window !== 'undefined') {
    window.location.reload();
  }
}
