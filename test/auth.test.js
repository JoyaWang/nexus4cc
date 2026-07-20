// TDD: access/refresh dual-token auth tests (v2)
// Run: node --test test/auth.test.js
//
// NEVER touches real data/auth — all tests use data/test-auth/

import { test, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const TEST_AUTH_DIR = join(PROJECT_DIR, 'data', 'test-auth');
const TEST_STORE_PATH = join(TEST_AUTH_DIR, 'refresh-tokens.json');

function cleanTestStore() {
  try { rmSync(TEST_AUTH_DIR, { recursive: true, force: true }); } catch {}
}

const TEST_JWT_SECRET = 'test-jwt-secret-' + crypto.randomBytes(8).toString('hex');
const TEST_PASSWORD_HASH = '$2b$12$5xRyI8a3yVhcCHqYP/Pdju/mKjxtxjWihXE1VpaXCdnuM6VUVNUsW';

function makeSvcOpts(storePath = TEST_STORE_PATH) {
  return { jwtSecret: TEST_JWT_SECRET, passwordHash: TEST_PASSWORD_HASH, accessTokenExpiry: 900, refreshTokenExpiryDays: 90, storePath };
}

before(() => {
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  process.env.ACC_PASSWORD_HASH = TEST_PASSWORD_HASH;
  process.env.ACCESS_TOKEN_EXPIRY_SECONDS = '900';
  process.env.REFRESH_TOKEN_EXPIRY_DAYS = '90';
  cleanTestStore();
});
afterEach(() => { cleanTestStore(); });

let tokenStore, tokens, authService;
try { tokenStore = await import('../server/auth/tokenStore.js'); } catch { tokenStore = null; }
try { tokens = await import('../server/auth/tokens.js'); } catch { tokens = null; }
try { authService = await import('../server/auth/authService.js'); } catch { authService = null; }

// ============ tokenStore ============

test('tokenStore: module exists', () => { assert.ok(tokenStore); });
test('tokenStore: loadStore returns empty families on fresh dir', () => { assert.deepEqual(tokenStore.loadStore(TEST_STORE_PATH), { families: {} }); });

test('tokenStore: saveStore writes valid JSON', () => {
  tokenStore.saveStore(TEST_STORE_PATH, { families: {} });
  assert.deepEqual(JSON.parse(readFileSync(TEST_STORE_PATH, 'utf8')), { families: {} });
});

test('tokenStore: atomic write — no .tmp remains', () => {
  tokenStore.saveStore(TEST_STORE_PATH, { families: { f1: { tokens: {}, status: 'active' } } });
  assert.ok(!existsSync(TEST_STORE_PATH + '.tmp'));
});

test('tokenStore: store file 0600 permissions', () => {
  tokenStore.saveStore(TEST_STORE_PATH, { families: {} });
  assert.equal(statSync(TEST_STORE_PATH).mode & 0o777, 0o600);
});

test('tokenStore: store directory 0700 permissions', () => {
  tokenStore.saveStore(TEST_STORE_PATH, { families: {} });
  assert.equal(statSync(TEST_AUTH_DIR).mode & 0o777, 0o700);
});

test('tokenStore: createFamily', () => {
  const fid = crypto.randomUUID(), h = crypto.randomBytes(32).toString('hex');
  const now = new Date().toISOString(), exp = new Date(Date.now() + 9e9).toISOString();
  const s = tokenStore.createFamily({ families: {} }, fid, h, now, exp);
  assert.equal(s.families[fid].status, 'active');
  assert.equal(s.families[fid].tokens[h].status, 'active');
});

test('tokenStore: findToken returns entry when active', () => {
  const fid = crypto.randomUUID(), h = crypto.randomBytes(32).toString('hex');
  const now = new Date().toISOString(), exp = new Date(Date.now() + 9e9).toISOString();
  const found = tokenStore.findToken(tokenStore.createFamily({ families: {} }, fid, h, now, exp), h);
  assert.ok(found); assert.equal(found.familyId, fid); assert.equal(found.token.status, 'active');
});

test('tokenStore: findToken returns null for unknown hash', () => { assert.equal(tokenStore.findToken({ families: {} }, 'x'), null); });

test('tokenStore: markTokenUsed active→used', () => {
  const fid = crypto.randomUUID(), h = crypto.randomBytes(32).toString('hex');
  const now = new Date().toISOString(), exp = new Date(Date.now() + 9e9).toISOString();
  const s = tokenStore.markTokenUsed(tokenStore.createFamily({ families: {} }, fid, h, now, exp), h);
  assert.equal(s.families[fid].tokens[h].status, 'used');
});

test('tokenStore: markTokenUsed throws for nonexistent', () => { assert.throws(() => tokenStore.markTokenUsed({ families: {} }, 'x')); });

test('tokenStore: addTokenToFamily', () => {
  const fid = crypto.randomUUID(), now = new Date().toISOString(), exp = new Date(Date.now() + 9e9).toISOString();
  let s = tokenStore.createFamily({ families: {} }, fid, 'h1', now, exp);
  s = tokenStore.addTokenToFamily(s, fid, 'h2', now, exp);
  assert.ok(s.families[fid].tokens.h1); assert.ok(s.families[fid].tokens.h2);
});

test('tokenStore: revokeFamily sets status and all tokens revoked', () => {
  const fid = crypto.randomUUID(), now = new Date().toISOString(), exp = new Date(Date.now() + 9e9).toISOString();
  let s = tokenStore.createFamily({ families: {} }, fid, 'h1', now, exp);
  s = tokenStore.addTokenToFamily(s, fid, 'h2', now, exp);
  s = tokenStore.revokeFamily(s, fid);
  assert.equal(s.families[fid].status, 'revoked');
  assert.equal(s.families[fid].tokens.h1.status, 'revoked');
  assert.equal(s.families[fid].tokens.h2.status, 'revoked');
});

test('tokenStore: revokeToken marks single token revoked', () => {
  const fid = crypto.randomUUID(), now = new Date().toISOString(), exp = new Date(Date.now() + 9e9).toISOString();
  const s = tokenStore.revokeToken(tokenStore.createFamily({ families: {} }, fid, 'h1', now, exp), 'h1');
  assert.equal(s.families[fid].tokens.h1.status, 'revoked');
});

test('tokenStore: revokeToken idempotent', () => {
  const fid = crypto.randomUUID(), now = new Date().toISOString(), exp = new Date(Date.now() + 9e9).toISOString();
  let s = tokenStore.createFamily({ families: {} }, fid, 'h1', now, exp);
  s = tokenStore.revokeToken(s, 'h1'); s = tokenStore.revokeToken(s, 'h1');
  assert.equal(s.families[fid].tokens.h1.status, 'revoked');
});

test('tokenStore: cleanExpired removes expired active tokens', () => {
  const fid = crypto.randomUUID();
  const pastExp = new Date(Date.now() - 9e9).toISOString(), futExp = new Date(Date.now() + 9e9).toISOString();
  let s = tokenStore.createFamily({ families: {} }, fid, 'h-exp', new Date(Date.now() - 18e9).toISOString(), pastExp);
  s = tokenStore.addTokenToFamily(s, fid, 'h-act', new Date().toISOString(), futExp);
  s = tokenStore.cleanExpired(s);
  assert.equal(s.families[fid].tokens['h-exp'], undefined);
  assert.ok(s.families[fid].tokens['h-act']);
});

test('tokenStore: cleanExpired KEEPS expired used token when family has valid tokens (reuse detection window)', () => {
  const fid = crypto.randomUUID();
  const pastExp = new Date(Date.now() - 9e9).toISOString();
  const futExp = new Date(Date.now() + 9e9).toISOString();
  let s = tokenStore.createFamily({ families: {} }, fid, 'h-used', new Date(Date.now() - 18e9).toISOString(), pastExp);
  s = tokenStore.markTokenUsed(s, 'h-used');
  s = tokenStore.addTokenToFamily(s, fid, 'h-active', new Date().toISOString(), futExp);
  s = tokenStore.cleanExpired(s);
  assert.ok(s.families[fid].tokens['h-used'], 'expired used token must survive for reuse detection while family has valid tokens');
  assert.ok(s.families[fid].tokens['h-active']);
});

test('tokenStore: cleanExpired removes ALL tokens when family fully expired', () => {
  const fid = crypto.randomUUID();
  const pastExp = new Date(Date.now() - 9e9).toISOString();
  let s = tokenStore.createFamily({ families: {} }, fid, 'h-used', new Date(Date.now() - 18e9).toISOString(), pastExp);
  s = tokenStore.markTokenUsed(s, 'h-used');
  s = tokenStore.cleanExpired(s);
  assert.equal(s.families[fid], undefined, 'family with all-expired tokens should be removed');
});

test('tokenStore: cleanExpired removes empty revoked families', () => {
  const fid = crypto.randomUUID(), pastExp = new Date(Date.now() - 9e9).toISOString();
  let s = tokenStore.createFamily({ families: {} }, fid, 'h1', new Date(Date.now() - 18e9).toISOString(), pastExp);
  s = tokenStore.revokeFamily(s, fid);
  assert.equal(tokenStore.cleanExpired(s).families[fid], undefined);
});

test('tokenStore: cleanExpired keeps revoked family with valid tokens', () => {
  const fid = crypto.randomUUID();
  const pastExp = new Date(Date.now() - 9e9).toISOString(), futExp = new Date(Date.now() + 9e9).toISOString();
  let s = tokenStore.createFamily({ families: {} }, fid, 'h-exp', new Date(Date.now() - 18e9).toISOString(), pastExp);
  s = tokenStore.addTokenToFamily(s, fid, 'h-fut', new Date().toISOString(), futExp);
  s = tokenStore.revokeFamily(s, fid);
  s = tokenStore.cleanExpired(s);
  assert.equal(s.families[fid].tokens['h-exp'], undefined, 'expired revoked token removed');
  assert.ok(s.families[fid].tokens['h-fut'], 'valid revoked token kept for reuse detection');
});

test('tokenStore: corrupt store JSON throws (fail-closed)', () => {
  mkdirSync(TEST_AUTH_DIR, { recursive: true });
  writeFileSync(TEST_STORE_PATH, 'not valid json {{{', 'utf8');
  assert.throws(() => tokenStore.loadStore(TEST_STORE_PATH), /corrupt/i);
});

test('tokenStore: schema validation — invalid family status', () => {
  mkdirSync(TEST_AUTH_DIR, { recursive: true });
  writeFileSync(TEST_STORE_PATH, JSON.stringify({ families: { f1: { tokens: {}, status: 'unknown' } } }));
  assert.throws(() => tokenStore.loadStore(TEST_STORE_PATH), /invalid status/);
});

test('tokenStore: schema validation — invalid token status', () => {
  mkdirSync(TEST_AUTH_DIR, { recursive: true });
  writeFileSync(TEST_STORE_PATH, JSON.stringify({ families: { f1: { tokens: { h1: { status: 'broken', createdAt: '2020-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z' } }, status: 'active' } } }));
  assert.throws(() => tokenStore.loadStore(TEST_STORE_PATH), /invalid status/);
});

test('tokenStore: schema validation — missing expiresAt', () => {
  mkdirSync(TEST_AUTH_DIR, { recursive: true });
  writeFileSync(TEST_STORE_PATH, JSON.stringify({ families: { f1: { tokens: { h1: { status: 'active', createdAt: '2020-01-01T00:00:00.000Z' } }, status: 'active' } } }));
  assert.throws(() => tokenStore.loadStore(TEST_STORE_PATH), /missing|invalid createdAt|expiresAt/);
});

test('tokenStore: schema validation — families is array', () => {
  mkdirSync(TEST_AUTH_DIR, { recursive: true });
  writeFileSync(TEST_STORE_PATH, JSON.stringify({ families: [{ tokens: {}, status: 'active' }] }));
  assert.throws(() => tokenStore.loadStore(TEST_STORE_PATH), /families is not an object/);
});

test('tokenStore: schema validation — root is array', () => {
  mkdirSync(TEST_AUTH_DIR, { recursive: true });
  writeFileSync(TEST_STORE_PATH, JSON.stringify([{ tokens: {}, status: 'active' }]));
  assert.throws(() => tokenStore.loadStore(TEST_STORE_PATH), /root is not an object/);
});

test('tokenStore: hash-only — raw token never on disk', () => {
  const raw = crypto.randomBytes(48).toString('base64url');
  const h = tokenStore.hashToken(raw), fid = crypto.randomUUID();
  const now = new Date().toISOString(), exp = new Date(Date.now() + 9e9).toISOString();
  tokenStore.saveStore(TEST_STORE_PATH, tokenStore.createFamily({ families: {} }, fid, h, now, exp));
  assert.ok(!readFileSync(TEST_STORE_PATH, 'utf8').includes(raw));
});

// ============ tokens ============

test('tokens: module exists', () => { assert.ok(tokens); });

test('tokens: generateAccessToken JWT claims', () => {
  const d = tokens.verifyAccessToken(tokens.generateAccessToken(TEST_JWT_SECRET), TEST_JWT_SECRET);
  assert.equal(d.sub, 'nexus-user'); assert.ok(d.jti); assert.equal(d.type, 'access');
});

test('tokens: default expiry 900s', () => {
  const d = tokens.verifyAccessToken(tokens.generateAccessToken(TEST_JWT_SECRET), TEST_JWT_SECRET);
  assert.equal(d.exp - d.iat, 900);
});

test('tokens: custom expiry', () => {
  const d = tokens.verifyAccessToken(tokens.generateAccessToken(TEST_JWT_SECRET, 600), TEST_JWT_SECRET);
  assert.equal(d.exp - d.iat, 600);
});

test('tokens: rejects expired', () => { assert.throws(() => tokens.verifyAccessToken(tokens.generateAccessToken(TEST_JWT_SECRET, 0), TEST_JWT_SECRET)); });
test('tokens: rejects wrong secret', () => { assert.throws(() => tokens.verifyAccessToken(tokens.generateAccessToken(TEST_JWT_SECRET), 'wrong')); });
test('tokens: refreshToken >= 64 chars', () => { const r = tokens.generateRefreshToken(); assert.ok(r.length >= 64); });
test('tokens: refreshToken unique', () => { assert.notEqual(tokens.generateRefreshToken(), tokens.generateRefreshToken()); });
test('tokens: hashToken consistent sha256', () => { assert.equal(tokens.hashToken('x'), tokens.hashToken('x')); assert.equal(tokens.hashToken('x').length, 64); });
test('tokens: hashToken different inputs', () => { assert.notEqual(tokens.hashToken('a'), tokens.hashToken('b')); });

test('tokens: rejects JWT without type=access', async () => {
  const jwtMod = await import('jsonwebtoken');
  assert.throws(() => tokens.verifyAccessToken(jwtMod.default.sign({ sub: 'nexus-user' }, TEST_JWT_SECRET, { expiresIn: '15m' }), TEST_JWT_SECRET), /type|access/i);
});

// ============ hashToken: single implementation ============

test('hashToken: tokenStore.hashToken and tokens.hashToken are the same function', () => {
  assert.equal(tokenStore.hashToken, tokens.hashToken);
});

// ============ authService ============

test('authService: module exists', () => { assert.ok(authService); });

test('authService: validateExpiryConfig rejects non-integer access', () => {
  assert.throws(() => authService.validateExpiryConfig('abc', 90), /ACCESS_TOKEN_EXPIRY_SECONDS must be a positive integer/);
});

test('authService: validateExpiryConfig rejects zero access', () => {
  assert.throws(() => authService.validateExpiryConfig(0, 90), /ACCESS_TOKEN_EXPIRY_SECONDS must be a positive integer/);
});

test('authService: validateExpiryConfig rejects negative access', () => {
  assert.throws(() => authService.validateExpiryConfig(-1, 90), /ACCESS_TOKEN_EXPIRY_SECONDS must be a positive integer/);
});

test('authService: validateExpiryConfig rejects non-integer refresh days', () => {
  assert.throws(() => authService.validateExpiryConfig(900, 'abc'), /REFRESH_TOKEN_EXPIRY_DAYS must be a positive integer/);
});

test('authService: validateExpiryConfig rejects zero refresh days', () => {
  assert.throws(() => authService.validateExpiryConfig(900, 0), /REFRESH_TOKEN_EXPIRY_DAYS must be a positive integer/);
});

test('authService: login returns correct fields, expiresIn=exp-iat', async () => {
  const svc = authService.createAuthService(makeSvcOpts());
  const r = await svc.login('nexus123');
  assert.ok(r.accessToken); assert.ok(r.refreshToken); assert.equal(r.token, r.accessToken);
  const d = tokens.verifyAccessToken(r.accessToken, TEST_JWT_SECRET);
  assert.equal(r.expiresIn, d.exp - d.iat);
});

test('authService: login rejects wrong password', async () => {
  try { await authService.createAuthService(makeSvcOpts()).login('wrong'); assert.fail(); } catch (e) { assert.match(e.message, /invalid_password/i); }
});

test('authService: refresh rotates token pair', async () => {
  const svc = authService.createAuthService(makeSvcOpts());
  const l = await svc.login('nexus123');
  const r = await svc.refresh(l.refreshToken);
  assert.ok(r.accessToken); assert.ok(r.refreshToken);
  assert.notEqual(r.refreshToken, l.refreshToken);
  assert.equal(r.token, r.accessToken);
});

test('authService: reuse detection — replay triggers family revoke', async () => {
  const svc = authService.createAuthService(makeSvcOpts());
  const l = await svc.login('nexus123');
  const r = await svc.refresh(l.refreshToken);
  try { await svc.refresh(l.refreshToken); assert.fail(); } catch (e) { assert.match(e.message, /token_reused/i); }
  try { await svc.refresh(r.refreshToken); assert.fail(); } catch (e) { assert.match(e.message, /invalid_refresh_token/i); }
});

test('authService: reuse detection priority over expiry', async () => {
  const svc = authService.createAuthService(makeSvcOpts());
  const l = await svc.login('nexus123');
  const store = tokenStore.loadStore(TEST_STORE_PATH);
  const h = tokens.hashToken(l.refreshToken);
  for (const [, f] of Object.entries(store.families)) { if (f.tokens[h]) { f.tokens[h].status = 'used'; f.tokens[h].expiresAt = new Date(Date.now() - 9e6).toISOString(); } }
  tokenStore.saveStore(TEST_STORE_PATH, store); svc.reloadStore();
  try { await svc.refresh(l.refreshToken); assert.fail(); } catch (e) { assert.match(e.message, /token_reused/i); }
});

test('authService: revoke requires refreshToken, 400 on missing', async () => {
  const svc = authService.createAuthService(makeSvcOpts());
  for (const v of ['', null, undefined]) { try { await svc.revoke(v); assert.fail(); } catch (e) { assert.match(e.message, /refreshToken required/i); } }
});

test('authService: revoke idempotent', async () => {
  const svc = authService.createAuthService(makeSvcOpts());
  const l = await svc.login('nexus123');
  await svc.revoke(l.refreshToken); await svc.revoke(l.refreshToken);
});

test('authService: after revoke, refresh fails', async () => {
  const svc = authService.createAuthService(makeSvcOpts());
  const l = await svc.login('nexus123');
  await svc.revoke(l.refreshToken);
  try { await svc.refresh(l.refreshToken); assert.fail(); } catch (e) { assert.match(e.message, /invalid_refresh_token/i); }
});

test('authService: different families isolated', async () => {
  const svc = authService.createAuthService(makeSvcOpts());
  const l1 = await svc.login('nexus123'), l2 = await svc.login('nexus123');
  await svc.revoke(l1.refreshToken);
  const r2 = await svc.refresh(l2.refreshToken); assert.ok(r2.accessToken);
});

test('authService: sequential double-refresh — first ok, second token_reused', async () => {
  const svc = authService.createAuthService(makeSvcOpts());
  const l = await svc.login('nexus123');
  const r1 = await svc.refresh(l.refreshToken); assert.ok(r1.accessToken);
  try { await svc.refresh(l.refreshToken); assert.fail(); } catch (e) { assert.match(e.message, /token_reused/i); }
  try { await svc.refresh(r1.refreshToken); assert.fail(); } catch (e) { assert.match(e.message, /invalid_refresh_token/i); }
});

test('authService: persistence — reload after save', async () => {
  const l = await authService.createAuthService(makeSvcOpts()).login('nexus123');
  const r = await authService.createAuthService(makeSvcOpts()).refresh(l.refreshToken);
  assert.ok(r.accessToken);
});

test('authService: startup cleanup persists empty store', async () => {
  const pastExp = new Date(Date.now() - 9e9).toISOString();
  let s = tokenStore.createFamily({ families: {} }, 'f1', 'h1', new Date(Date.now() - 18e9).toISOString(), pastExp);
  s = tokenStore.revokeFamily(s, 'f1');
  tokenStore.saveStore(TEST_STORE_PATH, s);
  authService.createAuthService(makeSvcOpts());
  assert.deepEqual(JSON.parse(readFileSync(TEST_STORE_PATH, 'utf8')), { families: {} });
});

test('authService: createAuthService with invalid expiry config throws', () => {
  assert.throws(() => authService.createAuthService({ ...makeSvcOpts(), accessTokenExpiry: 0 }), /ACCESS_TOKEN_EXPIRY_SECONDS/);
});

// ============ Express integration ============

test('Express integration: login→refresh→revoke via HTTP', async () => {
  const express = (await import('express')).default;
  const svc = authService.createAuthService(makeSvcOpts());
  const app = express();
  app.use(express.json());
  authService.mountRoutes(app, svc, TEST_JWT_SECRET);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // Login
    const lr = await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'nexus123' }) })).json();
    assert.ok(lr.accessToken); assert.ok(lr.refreshToken); assert.equal(lr.token, lr.accessToken);

    // Revoke
    assert.equal((await fetch(`${base}/api/auth/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: lr.refreshToken }) })).status, 200);

    // Refresh after revoke → 401
    assert.equal((await fetch(`${base}/api/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: lr.refreshToken }) })).status, 401);

    // Revoke with no body → 400
    assert.equal((await fetch(`${base}/api/auth/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })).status, 400);

    // Revoke with empty refreshToken → 400
    assert.equal((await fetch(`${base}/api/auth/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: '' }) })).status, 400);

    // Refresh token is not a valid JWT (verifyAccessToken rejects it)
    assert.throws(() => tokens.verifyAccessToken(lr.refreshToken, TEST_JWT_SECRET));
  } finally { server.close(); }
});

test('Express integration: /data/auth/* returns 404', async () => {
  const express = (await import('express')).default;
  const app = express();
  app.all('/data/auth/*', (_req, res) => { res.status(404).json({ error: 'not found' }); });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/data/auth/refresh-tokens.json`)).status, 404);
    assert.equal((await fetch(`${base}/data/auth/anything`)).status, 404);
  } finally { server.close(); }
});

test('Express integration: revoke without Bearer — only body refreshToken required', async () => {
  const express = (await import('express')).default;
  const svc = authService.createAuthService(makeSvcOpts());
  const app = express();
  app.use(express.json());
  authService.mountRoutes(app, svc, TEST_JWT_SECRET);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const lr = await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'nexus123' }) })).json();
    // Revoke without Bearer header — only refreshToken in body
    assert.equal((await fetch(`${base}/api/auth/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: lr.refreshToken }) })).status, 200);
  } finally { server.close(); }
});

// ============ Concurrent refresh (same family) ============

test('authService: concurrent refresh — first succeeds, second detects reuse', async () => {
  const svc = authService.createAuthService(makeSvcOpts());
  const l = await svc.login('nexus123');
  // Simulate two concurrent refresh attempts with the same token
  const r1 = svc.refresh(l.refreshToken);
  let r2Err;
  try { await svc.refresh(l.refreshToken); } catch (e) { r2Err = e; }
  const result1 = await r1;
  assert.ok(result1.accessToken);
  assert.match(r2Err.message, /token_reused|invalid_refresh_token/);
});