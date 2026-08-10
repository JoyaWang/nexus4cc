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
  assert.match(serverSrc, /\bnormalizeResizeSize\b/);
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

test('server.js normalizes resize input before recording client size', () => {
  const resizeBranchMatch = serverSrc.match(
    /data\.type === ['"]resize['"][\s\S]*?}\s*}\s*catch/
  );
  assert.ok(resizeBranchMatch, 'resize branch must exist');
  const branch = resizeBranchMatch[0];
  assert.match(branch, /normalizeResizeSize\(data\.cols,\s*data\.rows\)/);
  assert.match(branch, /if \(normalizedSize\)/);
  assert.match(branch, /ent\.clientSizes\.set\(ws,\s*normalizedSize\)/);
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

// ---- terminal output and scrollback contract guards ----

test('server.js wires ANSI-safe terminal output and scrollback modules', () => {
  assert.match(serverSrc, /from ['"]\.\/server\/terminalOutput\.js['"]/);
  assert.match(serverSrc, /from ['"]\.\/server\/scrollback\.js['"]/);
  assert.match(serverSrc, /safeAnsiSuffix/);
  assert.match(serverSrc, /capturePane/);
});

test('active WebSocket clients do not receive the lastOutput cache on connect', () => {
  const connectionBlock = serverSrc.match(/entry\.clientModes\.set\(ws, resizeMode\)[\s\S]*?ws\.on\('message'/);
  assert.ok(connectionBlock, 'WebSocket connection setup must exist');
  assert.match(connectionBlock[0], /RESIZE_MODE\.PASSIVE/);
  assert.match(connectionBlock[0], /safeAnsiSuffix\(entry\.lastOutput/);
  assert.doesNotMatch(serverSrc, /ws\.send\(entry\.lastOutput\.slice\(-2000\)\)/);
});

test('scrollback route uses the extracted capture helper and paginated snapshot metadata', () => {
  assert.match(serverSrc, /new ScrollbackStore/);
  assert.match(serverSrc, /snapshotId/);
  assert.match(serverSrc, /returnedLines/);
  assert.match(serverSrc, /totalLines/);
  assert.match(serverSrc, /hasMore/);
  assert.match(serverSrc, /nextOffset/);
});

test('first valid active resize uses a two-step resize plan', () => {
  assert.match(serverSrc, /resizePlan\([\s\S]*normalizedSize\.cols[\s\S]*normalizedSize\.rows[\s\S]*ent\.initialActiveResizeClients\.has\(ws\)/);
  assert.match(serverSrc, /ent\.initialActiveResizeClients\.delete\(ws\)/);
  assert.match(serverSrc, /for \(const size of resizeSteps\)/);
});

test('pty output is suppressed for active clients until their first resize is accepted', () => {
  const onDataBlock = serverSrc.match(/ptyProc\.onData\(\(data\) => \{[\s\S]*?\n  \}\);/);
  assert.ok(onDataBlock, 'pty onData handler must exist');
  assert.match(onDataBlock[0], /shouldBroadcastPTYOutput\(ws, ent\.initialActiveResizeClients\)/);
  assert.match(onDataBlock[0], /if \(!shouldBroadcastPTYOutput[\s\S]*?continue/);
  assert.match(serverSrc, /ent\.initialActiveResizeClients\.delete\(ws\);[\s\S]*?for \(const size of resizeSteps\)/);
});

test('first active resize syncs tracked alternate-screen state before repaint', () => {
  assert.match(serverSrc, /updateAlternateScreenState\(/);
  assert.match(serverSrc, /authoritativeAlternateScreen\(ent\)/);
  assert.match(serverSrc, /ws\.send\(terminalModeSync\(ent\.alternateScreen\)\)/);
});

test('scrollback route delegates strict request validation and separates full-history capture from legacy lines', () => {
  assert.match(serverSrc, /parseScrollbackParams/);
  assert.match(serverSrc, /start: isLegacy \? `-\$\{legacyLines\}` : '-'/);
  assert.match(serverSrc, /MAX_PAGE_LIMIT/);
  assert.match(serverSrc, /MAX_LEGACY_CAPTURE_LINES/);
});

test('scrollback route resolves stable target identity before snapshot lookup and capture', () => {
  assert.match(serverSrc, /(?:let|const) resolvedTarget[\s\S]*?resolveTmuxWindow\(session, windowIndex\)/);
  assert.match(serverSrc, /scrollbackStore\.get\(snapshotId, resolvedTarget\)/);
  assert.match(serverSrc, /capturePane\(\{[\s\S]*target: resolvedTarget/);
  assert.match(serverSrc, /capturePane\(\{[\s\S]*target: resolvedTarget[\s\S]*start:/);
  assert.equal(
    (serverSrc.match(/sameTmuxTargetIdentity\(currentTarget,\s*resolvedTarget\)/g) || []).length,
    2,
    'capture completion and capture error paths must compare full target identity',
  );
});

test('scrollback route maps missing targets to 404 and identity mismatches to 409', () => {
  assert.match(serverSrc, /scrollbackErrorStatus/);
  assert.match(serverSrc, /error\.code === ['"]session_not_found['"][\s\S]*?return 404/);
  assert.match(serverSrc, /error\.code === ['"]window_identity_mismatch['"][\s\S]*?return 409/);
});

// ---- strict per-window PTY target guards ----

test('server.js attaches PTYs through per-window linked tmux sessions', () => {
  assert.match(serverSrc, /linkedSessionName\(session,\s*target\.windowId\)/);
  assert.match(serverSrc, /new-session['"],\s*['"]-d['"],\s*['"]-s['"],\s*linkedSession,\s*['"]-t['"],\s*session/);
  assert.match(serverSrc, /select-window['"],\s*['"]-t['"],\s*`\$\{linkedSession\}:\$\{target\.windowId\}`/);
  assert.match(serverSrc, /attach-session['"],\s*['"]-t['"],\s*linkedSession/);
  assert.match(serverSrc, /resolveTmuxCurrentTarget\(linkedSession\)/);
  assert.match(serverSrc, /linkedTarget\.windowId !== target\.windowId/);
  assert.match(serverSrc, /linkedTarget\.paneId !== target\.paneId/);
  assert.match(serverSrc, /windowName: linkedTarget\.windowName/);
  assert.match(serverSrc, /cwd: linkedTarget\.cwd/);
  assert.match(serverSrc, /linked_window_identity_mismatch/);
});

test('server.js rejects missing targets instead of falling back to default or first window', () => {
  const targetBlock = serverSrc.match(/function resolveTmuxTarget[\s\S]*?function ensureWindowPty[\s\S]*?\n}\n\n\/\/ WebSocket/);
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

test('ensureWindowPty revalidates cached linked current window and pane identity', () => {
  const ensureBlock = serverSrc.match(
    /function ensureWindowPty[\s\S]*?\n}\n\nfunction authoritativeAlternateScreen/,
  );
  assert.ok(ensureBlock, 'ensureWindowPty block must exist');
  assert.match(ensureBlock[0], /resolveTmuxCurrentTarget\(cached\.linkedSession\)/);
  assert.match(ensureBlock[0], /cached\.windowId === target\.windowId/);
  assert.match(ensureBlock[0], /cached\.paneId === target\.paneId/);
  assert.match(ensureBlock[0], /linkedTarget\?\.windowId === target\.windowId/);
  assert.match(ensureBlock[0], /linkedTarget\?\.paneId === target\.paneId/);
  assert.match(ensureBlock[0], /disposePtyEntry\(key, cached\)/);
});

test('server.js imports and wires the paneLayout push module', () => {
  assert.match(serverSrc, /from ['"]\.\/server\/paneLayout\.js['"]/);
  assert.match(serverSrc, /\bpaneLayoutMessage\b/);
  assert.match(serverSrc, /\bqueryPaneLayout\b/);
  assert.match(serverSrc, /\bsamePaneLayout\b/);
});

test('server.js pushes pane layout after the identity handshake', () => {
  const handshake = serverSrc.match(
    /type: 'hello'[\s\S]*?entry\.initialActiveResizeClients\.add\(ws\)/,
  );
  assert.ok(handshake, 'hello handshake block must exist');
  assert.match(handshake[0], /pushPaneLayoutTo\(ws, entry\)/);
});

test('server.js pushes pane layout after a client resize takes effect', () => {
  const resizeIdx = serverSrc.indexOf(
    'for (const size of resizeSteps) ent.pty.resize(size.cols, size.rows);',
  );
  assert.ok(resizeIdx >= 0, 'pty.resize call must exist');
  const afterResize = serverSrc.slice(resizeIdx, resizeIdx + 500);
  assert.match(afterResize, /pushPaneLayoutTo\(ws, ent\)/);
  assert.match(afterResize, /schedulePaneLayoutPoll\(ent\)/);
});

test('server.js debounced layout poll is driven by PTY output activity', () => {
  const onDataBlock = serverSrc.match(
    /ptyProc\.onData\(\(data\) => \{[\s\S]*?for \(const ws of ent\.clients\)/,
  );
  assert.ok(onDataBlock, 'ptyProc.onData block must exist');
  assert.match(onDataBlock[0], /schedulePaneLayoutPoll\(ent\)/);
  // The debounce constant lives with the helper definition, not inside the
  // onData callback; verify it exists once in the file.
  assert.match(serverSrc, /PANE_LAYOUT_POLL_DEBOUNCE_MS = 350/);
});

test('server.js clears the layout poll timer when disposing a PTY entry', () => {
  const disposeBlock = serverSrc.match(
    /function disposePtyEntry\(key, entry\) \{[\s\S]*?\n\}/,
  );
  assert.ok(disposeBlock, 'disposePtyEntry block must exist');
  assert.match(disposeBlock[0], /entry\?\.layoutPollTimer/);
  assert.match(disposeBlock[0], /clearTimeout\(entry\.layoutPollTimer\)/);
});
