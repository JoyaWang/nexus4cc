// Auth service — stateful service object wrapping tokenStore + tokens
// Extracted from server.js for testability without tmux/pty/WS
//
// Concurrency note: rotateRefreshToken and revoke are synchronous mutations
// on a single in-memory `store` followed by synchronous persist(). Node.js
// single-threaded JS execution guarantees no interleaving between calls.
// If clustered, replace with a shared DB or file-lock mechanism.

import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import {
  generateAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashToken,
} from './tokens.js';
import {
  loadStore as loadTokenStore,
  saveStore as saveTokenStore,
  createFamily,
  findToken,
  markTokenUsed,
  addTokenToFamily,
  revokeFamily,
  revokeToken,
  cleanExpired,
} from './tokenStore.js';

export function validateExpiryConfig(accessTokenExpiry, refreshTokenExpiryDays) {
  if (!Number.isInteger(accessTokenExpiry) || accessTokenExpiry <= 0) {
    throw new Error(`ACCESS_TOKEN_EXPIRY_SECONDS must be a positive integer, got ${accessTokenExpiry}`);
  }
  if (!Number.isInteger(refreshTokenExpiryDays) || refreshTokenExpiryDays <= 0) {
    throw new Error(`REFRESH_TOKEN_EXPIRY_DAYS must be a positive integer, got ${refreshTokenExpiryDays}`);
  }
}

export function createAuthService({ jwtSecret, passwordHash, accessTokenExpiry, refreshTokenExpiryDays, storePath }) {
  validateExpiryConfig(accessTokenExpiry, refreshTokenExpiryDays);
  const refreshTokenExpiryMs = refreshTokenExpiryDays * 86400000;
  let store = loadTokenStore(storePath);
  store = cleanExpired(store);
  saveTokenStore(storePath, store);

  function persist() {
    saveTokenStore(storePath, store);
  }

  function reloadStore() {
    store = loadTokenStore(storePath);
  }

  async function login(password) {
    const ok = await bcrypt.compare(password, passwordHash);
    if (!ok) throw Object.assign(new Error('invalid_password'), { status: 401 });
    const accessToken = generateAccessToken(jwtSecret, accessTokenExpiry);
    const refreshToken = generateRefreshToken();
    const refreshHash = hashToken(refreshToken);
    const familyId = crypto.randomUUID();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + refreshTokenExpiryMs).toISOString();
    store = createFamily(store, familyId, refreshHash, now, expiresAt);
    persist();
    const decoded = verifyAccessToken(accessToken, jwtSecret);
    return {
      accessToken,
      refreshToken,
      expiresIn: decoded.exp - decoded.iat,
      token: accessToken,
    };
  }

  function rotateRefreshToken(rawRefreshToken) {
    const tokenHash = hashToken(rawRefreshToken);
    const found = findToken(store, tokenHash);
    if (!found) {
      throw Object.assign(new Error('invalid_refresh_token'), { status: 401 });
    }
    if (store.families[found.familyId]?.status === 'revoked') {
      throw Object.assign(new Error('invalid_refresh_token'), { status: 401 });
    }
    // Reuse detection takes PRIORITY over expiry
    if (found.token.status === 'used') {
      store = revokeFamily(store, found.familyId);
      persist();
      throw Object.assign(new Error('token_reused'), { status: 401, familyRevoked: true });
    }
    if (found.token.status !== 'active') {
      throw Object.assign(new Error('invalid_refresh_token'), { status: 401 });
    }
    // Only check expiry AFTER reuse detection
    if (new Date(found.token.expiresAt) < new Date()) {
      throw Object.assign(new Error('invalid_refresh_token'), { status: 401 });
    }
    // Valid: mark old used, issue new pair
    store = markTokenUsed(store, tokenHash);
    const newAccessToken = generateAccessToken(jwtSecret, accessTokenExpiry);
    const newRefreshToken = generateRefreshToken();
    const newHash = hashToken(newRefreshToken);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + refreshTokenExpiryMs).toISOString();
    store = addTokenToFamily(store, found.familyId, newHash, now, expiresAt);
    store = cleanExpired(store);
    persist();
    const decoded = verifyAccessToken(newAccessToken, jwtSecret);
    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresIn: decoded.exp - decoded.iat,
      token: newAccessToken,
    };
  }

  function refresh(rawRefreshToken) {
    return rotateRefreshToken(rawRefreshToken);
  }

  function revoke(rawRefreshToken) {
    if (!rawRefreshToken) {
      throw Object.assign(new Error('refreshToken required'), { status: 400 });
    }
    const tokenHash = hashToken(rawRefreshToken);
    const found = findToken(store, tokenHash);
    if (found) {
      store = revokeToken(store, tokenHash);
      persist();
    }
    return { message: 'token_revoked' };
  }

  return { login, refresh, revoke, reloadStore, rotateRefreshToken };
}

// Mount auth routes onto an Express app (no authMiddleware on revoke — uses refreshToken body only)
export function mountRoutes(app, svc, jwtSecret) {
  app.post('/api/auth/login', async (req, res) => {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'password required' });
    try {
      const result = await svc.login(password);
      res.json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/auth/refresh', (req, res) => {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });
    try {
      const result = svc.refresh(refreshToken);
      res.json(result);
    } catch (err) {
      const body = { error: err.message };
      if (err.message === 'token_reused') {
        body.message = 'Refresh token reuse detected; all sessions revoked';
      }
      res.status(err.status || 500).json(body);
    }
  });

  // Revoke: NO authMiddleware — accessToken may be expired, uses refreshToken body
  app.post('/api/auth/revoke', (req, res) => {
    const { refreshToken } = req.body || {};
    try {
      const result = svc.revoke(refreshToken);
      res.json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });
}