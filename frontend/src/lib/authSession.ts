// Centralized auth session module.
// Single source of truth for token storage, refresh, and logout.
// - accessToken: short-lived JWT, used for API/WS auth
// - refreshToken: opaque, stored in localStorage (XSS boundary: acceptable for
//   single-user self-hosted app; not httpOnly cookie to avoid CSRF complexity)
// - Single-flight refresh: concurrent 401s share one in-flight refresh request
// - On refresh failure: clear tokens + reload to login page

export const ACCESS_TOKEN_KEY = 'nexus_token';
export const REFRESH_TOKEN_KEY = 'nexus_refresh_token';

let _refreshPromise: Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> | null = null;

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function setTokens(accessToken: string, refreshToken: string): void {
  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
}

export function clearTokens(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

export async function refreshTokens(): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  if (_refreshPromise) return _refreshPromise;

  _refreshPromise = _doRefresh();
  try {
    return await _refreshPromise;
  } finally {
    _refreshPromise = null;
  }
}

async function _doRefresh(): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    throw new Error('no refresh token');
  }

  const res = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });

  if (!res.ok) {
    clearTokens();
    if (typeof window !== 'undefined') window.location.reload();
    throw new Error('refresh failed');
  }

  const data = await res.json();
  setTokens(data.accessToken || data.token, data.refreshToken);
  return {
    accessToken: data.accessToken || data.token,
    refreshToken: data.refreshToken,
    expiresIn: data.expiresIn,
  };
}

export async function logout(): Promise<void> {
  const refreshToken = getRefreshToken();
  clearTokens();
  if (refreshToken) {
    try {
      await fetch('/api/auth/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
    } catch {
      // Network error — tokens already cleared locally, server will expire them
    }
  }
  if (typeof window !== 'undefined') window.location.reload();
}
