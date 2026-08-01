// Regression guard: verify server.js actually wires the resizePolicy module.
//
// Pure-helper unit tests (resizePolicy.test.js) prove the decision functions
// are correct in isolation. This file proves server.js is actually USING them
// in the right places — so a future refactor that accidentally drops the
// import, or stops calling shouldResizePTY() in the resize branch, is caught
// here instead of silently regressing the no-PC-break guarantee.
//
// This is a static source scan (no I/O, no tmux, no JWT) — deliberately
// chosen because server.js is a single-file monolith that cannot be imported
// as a module without booting the whole server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(join(__dirname, '..', 'server.js'), 'utf8');

test('server.js imports the resizePolicy module', () => {
  assert.match(serverSrc, /from ['"]\.\/server\/resizePolicy\.js['"]/);
});

test('server.js imports all four policy functions', () => {
  assert.match(serverSrc, /\bparseResizeMode\b/);
  assert.match(serverSrc, /\bshouldResizePTY\b/);
  assert.match(serverSrc, /\bactiveClientSizes\b/);
  assert.match(serverSrc, /\bcomputeMinSize\b/);
});

test('server.js parses resizeMode from the WS URL query string', () => {
  assert.match(serverSrc, /parseResizeMode\(url\.searchParams\.get\(['"]resizeMode['"]\)\)/);
});

test('server.js records per-client resize mode (clientModes map)', () => {
  // PTY entries carry a clientModes Map...
  assert.match(serverSrc, /clientModes:\s*new Map\(\)/);
  // ...populated on connection...
  assert.match(serverSrc, /entry\.clientModes\.set\(ws,\s*resizeMode\)/);
  // ...and cleaned up on close/error.
  assert.match(serverSrc, /ent\.clientModes\.delete\(ws\)/);
});

test('server.js gates pty.resize on shouldResizePTY in the resize message branch', () => {
  // The resize branch must call shouldResizePTY(mode) before pty.resize().
  assert.match(serverSrc, /if \(shouldResizePTY\(mode\)\)\s*\{[\s\S]*?ent\.pty\.resize/);
});

test('server.js recomputes min size using active clients only on disconnect', () => {
  assert.match(serverSrc, /activeClientSizes\(ent\.clientSizes,\s*ent\.clientModes\)/);
  assert.match(serverSrc, /computeMinSize\(activeSizes\)/);
});

test('server.js no longer hardcodes an unconditional pty.resize in resize branch', () => {
  // The OLD code did `ent.pty.resize(...)` directly after setting clientSizes.
  // After Phase 2, every pty.resize in the resize branch must be guarded by
  // shouldResizePTY. We assert there is no bare (unguarded) resize call right
  // after clientSizes.set in the resize branch by checking the branch source.
  const resizeBranchMatch = serverSrc.match(
    /data\.type === ['"]resize['"][\s\S]*?}\s*}\s*catch/
  );
  assert.ok(resizeBranchMatch, 'resize branch must exist');
  const branch = resizeBranchMatch[0];
  assert.match(branch, /shouldResizePTY/, 'resize branch must gate on shouldResizePTY');
});

// ---- v2 auth wiring guards ----

test('server.js imports authService module', () => {
  assert.match(serverSrc, /from ['"]\.\/server\/auth\/authService\.js['"]/);
});

test('server.js uses createAuthService for auth initialization', () => {
  assert.match(serverSrc, /createAuthService/);
});

test('server.js uses mountAuthRoutes to wire auth endpoints', () => {
  assert.match(serverSrc, /mountAuthRoutes/);
});

test('server.js uses verifyAccessToken (not raw jwt.verify) in authMiddleware', () => {
  assert.match(serverSrc, /verifyAccessToken\(token,\s*JWT_SECRET\)/);
});

test('server.js uses verifyAccessToken in WebSocket connection handler', () => {
  assert.match(serverSrc, /verifyAccessToken\(token,\s*JWT_SECRET\)/);
});

test('server.js no longer uses jwt.verify directly', () => {
  assert.ok(!serverSrc.match(/jwt\.verify/), 'server.js must not use jwt.verify directly');
});

test('server.js no longer uses jwt.sign directly', () => {
  assert.ok(!serverSrc.match(/jwt\.sign/), 'server.js must not use jwt.sign directly');
});

// ---- strict per-window PTY target guards ----

test('server.js attaches PTYs through per-window linked tmux sessions', () => {
  assert.match(serverSrc, /linkedSessionName\(session,\s*target\.windowId\)/);
  assert.match(serverSrc, /new-session['"],\s*['"]-d['"],\s*['"]-s['"],\s*linkedSession,\s*['"]-t['"],\s*session/);
  assert.match(serverSrc, /select-window['"],\s*['"]-t['"],\s*`\$\{linkedSession\}:\$\{windowIndex\}`/);
  assert.match(serverSrc, /attach-session['"],\s*['"]-t['"],\s*linkedSession/);
});

test('server.js rejects missing targets instead of falling back to default or first window', () => {
  const targetBlock = serverSrc.match(/function resolveTmuxWindow[\s\S]*?function ensureWindowPty[\s\S]*?\n}\n\n\/\/ WebSocket/);
  assert.ok(targetBlock, 'target resolution and ensureWindowPty blocks must exist');
  assert.doesNotMatch(targetBlock[0], /safeSession\s*=\s*TMUX_SESSION/);
  assert.doesNotMatch(targetBlock[0], /targetWindow\s*=\s*parseInt\(windows\[0\]/);
  assert.match(targetBlock[0], /session_not_found/);
  assert.match(targetBlock[0], /window_not_found/);
  assert.match(serverSrc, /ws\.close\(4404,\s*code\)/);
});

test('server.js records requested and actual target identity', () => {
  assert.match(serverSrc, /event:\s*['"]nexus\.ws\.connect_attempt['"]/);
  assert.match(serverSrc, /event:\s*['"]nexus\.ws\.target_resolved['"]/);
  assert.match(serverSrc, /requestedSession:\s*session/);
  assert.match(serverSrc, /requestedWindowIndex:\s*windowIndex/);
  assert.match(serverSrc, /actualSession:\s*target\.session/);
  assert.match(serverSrc, /actualWindowIndex:\s*target\.windowIndex/);
});

test('server.js hides internal linked sessions from public session lists', () => {
  assert.match(serverSrc, /filter\(session => !isNexusLinkedSession\(session\.name\)\)/);
  assert.match(serverSrc, /filter\(project => !isNexusLinkedSession\(project\.name\)\)/);
});

// ---- liveness + lifecycle hardening guards ----

test('channels API exposes pane_current_command as cmd for liveness display', () => {
  assert.match(serverSrc, /pane_current_command/);
  assert.match(serverSrc, /const cmd = parts\[4\] \|\| ''/);
  assert.match(serverSrc, /return \{ index, name, active, cwd, cmd \}/);
});

test('delete project kills linked sessions so windows cannot zombify', () => {
  const block = serverSrc.match(/app\.delete\('\/api\/projects\/:name'[\s\S]*?\n\}\)/);
  assert.ok(block, 'delete project route must exist');
  assert.match(block[0], /killLinkedSessionsFor\(sessionName\)/);
});

test('killLinkedSessionsFor disposes ptyMap entries and group-matched tmux leaks', () => {
  assert.match(serverSrc, /entry\.sourceSession === sourceSession\) disposePtyEntry/);
  assert.match(serverSrc, /group === sourceSession && isNexusLinkedSession\(name\)/);
});

test('delete window disposes the matching PTY entry and linked session', () => {
  const block = serverSrc.match(/app\.delete\('\/api\/sessions\/:id'[\s\S]*?\n\}\)/);
  assert.ok(block, 'delete session route must exist');
  assert.match(block[0], /disposePtyEntry\(key, entry\)/);
});

test('ensureWindowPty evicts stale PTY when the target window is dead', () => {
  assert.match(serverSrc, /nexus\.pty\.dead_window_evicted/);
  assert.match(serverSrc, /disposePtyEntry\(ptyKey\(session, windowIndex\), stale\)/);
});
