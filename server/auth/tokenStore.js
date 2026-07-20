// Refresh token persistence store
// Data model: { families: { <familyId>: { tokens: { <sha256>: { status, createdAt, expiresAt } }, status } } }
// Atomic write via tmp + rename, 0600 file, 0700 dir
//
// Concurrency note: all mutations (rotateRefreshToken, revoke, etc.) operate on a
// single in-memory `store` object and persist via synchronous writeFileSync+rename.
// Node.js is single-threaded for JS execution, so no two mutations can interleave.
// If this service is ever clustered, the store must be replaced with a shared
// database or file-lock mechanism.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { hashToken } from './tokens.js';

const VALID_STATUSES = new Set(['active', 'used', 'revoked']);
const VALID_FAMILY_STATUSES = new Set(['active', 'revoked']);

function validateStoreSchema(store) {
  if (!store || typeof store !== 'object' || Array.isArray(store)) {
    throw new Error('corrupt token store: root is not an object');
  }
  if (store.families == null) return;
  if (typeof store.families !== 'object' || Array.isArray(store.families)) {
    throw new Error('corrupt token store: families is not an object');
  }
  for (const [fid, family] of Object.entries(store.families)) {
    if (!family || typeof family !== 'object' || Array.isArray(family)) {
      throw new Error(`corrupt token store: family ${fid} is not an object`);
    }
    if (!VALID_FAMILY_STATUSES.has(family.status)) {
      throw new Error(`corrupt token store: family ${fid} has invalid status "${family.status}"`);
    }
    if (!family.tokens || typeof family.tokens !== 'object' || Array.isArray(family.tokens)) {
      throw new Error(`corrupt token store: family ${fid} tokens is not an object`);
    }
    for (const [hash, token] of Object.entries(family.tokens)) {
      if (!token || typeof token !== 'object' || Array.isArray(token)) {
        throw new Error(`corrupt token store: token entry ${fid}/${hash.slice(0, 8)}… is not an object`);
      }
      if (!VALID_STATUSES.has(token.status)) {
        throw new Error(`corrupt token store: token ${fid}/${hash.slice(0, 8)}… has invalid status "${token.status}"`);
      }
      if (typeof token.createdAt !== 'string' || typeof token.expiresAt !== 'string') {
        throw new Error(`corrupt token store: token ${fid}/${hash.slice(0, 8)}… missing/invalid createdAt or expiresAt`);
      }
    }
  }
}

export function ensureAuthDir(storePath) {
  const dir = dirname(storePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function loadStore(storePath) {
  ensureAuthDir(storePath);
  try {
    const raw = readFileSync(storePath, 'utf8');
    const parsed = JSON.parse(raw);
    validateStoreSchema(parsed);
    return { families: parsed.families || {} };
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error('corrupt token store: invalid JSON — refusing to start (fail-closed)');
    }
    if (err.message.startsWith('corrupt token store')) throw err;
    if (err.code === 'ENOENT') return { families: {} };
    throw err;
  }
}

export function saveStore(storePath, store) {
  ensureAuthDir(storePath);
  const tmp = storePath + '.tmp';
  const json = JSON.stringify(store, null, 2);
  writeFileSync(tmp, json, { mode: 0o600 });
  renameSync(tmp, storePath);
}

export function createFamily(store, familyId, tokenHash, createdAt, expiresAt) {
  store.families[familyId] = {
    tokens: {
      [tokenHash]: { status: 'active', createdAt, expiresAt },
    },
    status: 'active',
  };
  return store;
}

export function findToken(store, tokenHash) {
  for (const [familyId, family] of Object.entries(store.families)) {
    if (family.tokens[tokenHash]) {
      return { familyId, token: family.tokens[tokenHash] };
    }
  }
  return null;
}

export function markTokenUsed(store, tokenHash) {
  for (const [, family] of Object.entries(store.families)) {
    if (family.tokens[tokenHash]) {
      if (family.tokens[tokenHash].status !== 'active') {
        throw new Error('Token not in active state');
      }
      family.tokens[tokenHash].status = 'used';
      return store;
    }
  }
  throw new Error('Token not found');
}

export function addTokenToFamily(store, familyId, tokenHash, createdAt, expiresAt) {
  if (!store.families[familyId]) {
    throw new Error('Family not found');
  }
  store.families[familyId].tokens[tokenHash] = {
    status: 'active',
    createdAt,
    expiresAt,
  };
  return store;
}

export function revokeFamily(store, familyId) {
  if (!store.families[familyId]) return store;
  store.families[familyId].status = 'revoked';
  for (const [, token] of Object.entries(store.families[familyId].tokens)) {
    token.status = 'revoked';
  }
  return store;
}

export function revokeToken(store, tokenHash) {
  for (const [, family] of Object.entries(store.families)) {
    if (family.tokens[tokenHash]) {
      family.tokens[tokenHash].status = 'revoked';
      return store;
    }
  }
  return store;
}

// cleanExpired removes expired tokens and empty revoked families.
// Strategy: expired *active* tokens are always removed (they can't be used).
// Expired *used* tokens are kept as long as their family still has any
// non-expired token — they are needed for reuse detection (a replayed used
// token must trigger family revocation even after it expires). Once every
// token in a family is expired, the entire family is safe to remove.
export function cleanExpired(store) {
  const now = new Date();
  for (const [familyId, family] of Object.entries(store.families)) {
    // Remove expired active tokens (unusable, no reuse detection value)
    for (const [hash, token] of Object.entries(family.tokens)) {
      if (token.status === 'active' && new Date(token.expiresAt) < now) {
        delete family.tokens[hash];
      }
    }
    // Check if any token in the family is still within its validity window
    const hasValidToken = Object.values(family.tokens).some(
      t => new Date(t.expiresAt) >= now
    );
    if (!hasValidToken) {
      // All tokens expired — safe to remove entire family
      // (reuse detection window has closed for this family)
      delete store.families[familyId];
    } else if (family.status === 'revoked') {
      // Revoked family with some still-valid tokens: only remove the
      // expired ones (they have no reuse detection value in a revoked family)
      for (const [hash, token] of Object.entries(family.tokens)) {
        if (new Date(token.expiresAt) < now) {
          delete family.tokens[hash];
        }
      }
      if (Object.keys(family.tokens).length === 0) {
        delete store.families[familyId];
      }
    }
  }
  return store;
}

export { hashToken };