// Unit tests for server-side resize isolation policy (Nexus4CC Phase 2 spike).
// Run with: node --test test/resizePolicy.test.js
//
// These tests cover the PURE decision functions only. They do NOT spin up
// server.js, node-pty, tmux, or any WebSocket. The contract being verified:
//   - passive clients never trigger pty.resize
//   - active clients continue to trigger pty.resize
//   - on reconnect/close, min-size recomputation only considers active clients
//   - default behaviour (no resizeMode param) is active (back-compat with Web)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RESIZE_MODE,
  parseResizeMode,
  shouldResizePTY,
  activeClientSizes,
  computeMinSize,
  normalizeResizeSize,
  resizePlan,
  shouldBroadcastPTYOutput,
} from '../server/resizePolicy.js';

// ---------- parseResizeMode ----------

test('parseResizeMode: returns ACTIVE when param is null/undefined/empty', () => {
  assert.equal(parseResizeMode(null), RESIZE_MODE.ACTIVE);
  assert.equal(parseResizeMode(undefined), RESIZE_MODE.ACTIVE);
  assert.equal(parseResizeMode(''), RESIZE_MODE.ACTIVE);
});

test('parseResizeMode: returns PASSIVE when param is "passive" (case-insensitive)', () => {
  assert.equal(parseResizeMode('passive'), RESIZE_MODE.PASSIVE);
  assert.equal(parseResizeMode('PASSIVE'), RESIZE_MODE.PASSIVE);
  assert.equal(parseResizeMode('PaSsIvE'), RESIZE_MODE.PASSIVE);
});

test('parseResizeMode: returns ACTIVE when param is "active" (case-insensitive)', () => {
  assert.equal(parseResizeMode('active'), RESIZE_MODE.ACTIVE);
  assert.equal(parseResizeMode('ACTIVE'), RESIZE_MODE.ACTIVE);
});

test('parseResizeMode: unknown values fall back to ACTIVE (back-compat, never break Web)', () => {
  assert.equal(parseResizeMode('silent'), RESIZE_MODE.ACTIVE);
  assert.equal(parseResizeMode('mobile'), RESIZE_MODE.ACTIVE);
  assert.equal(parseResizeMode('true'), RESIZE_MODE.ACTIVE);
});

// ---------- shouldResizePTY ----------

test('shouldResizePTY: ACTIVE client may resize PTY', () => {
  assert.equal(shouldResizePTY(RESIZE_MODE.ACTIVE), true);
});

test('shouldResizePTY: PASSIVE client must NOT resize PTY', () => {
  assert.equal(shouldResizePTY(RESIZE_MODE.PASSIVE), false);
});

test('normalizeResizeSize: rejects invalid sizes and clamps terminal minimums', () => {
  assert.equal(normalizeResizeSize('bad', 30), null);
  assert.equal(normalizeResizeSize(100, 'bad'), null);
  assert.equal(normalizeResizeSize(-1, 30), null);
  assert.equal(normalizeResizeSize(true, true), null);
  assert.equal(normalizeResizeSize([80], [24]), null);
  assert.equal(normalizeResizeSize({ cols: 80 }, 24), null);
  assert.equal(normalizeResizeSize('', ' '), null);
  assert.equal(normalizeResizeSize('0x50', '24'), null);
  assert.deepEqual(normalizeResizeSize('80', '24'), { cols: 80, rows: 24 });
  assert.deepEqual(normalizeResizeSize(1, 2), { cols: 10, rows: 5 });
});

test('resize gate remains closed for invalid input and opens only for a valid normalized size', () => {
  const pending = { id: 'active' };
  const pendingClients = new Set([pending]);

  assert.equal(normalizeResizeSize('bad', 30), null);
  assert.equal(shouldBroadcastPTYOutput(pending, pendingClients), false);
  assert.deepEqual(resizePlan(RESIZE_MODE.ACTIVE, 80, 24, true), [
    { cols: 80, rows: 23 },
    { cols: 80, rows: 24 },
  ]);
  pendingClients.delete(pending);
  assert.equal(shouldBroadcastPTYOutput(pending, pendingClients), true);
});

test('resizePlan: first active resize nudges rows then repaints at the target size', () => {
  assert.deepEqual(resizePlan(RESIZE_MODE.ACTIVE, 120, 40, true), [
    { cols: 120, rows: 39 },
    { cols: 120, rows: 40 },
  ]);
  assert.deepEqual(resizePlan(RESIZE_MODE.ACTIVE, 8, 5, true), [
    { cols: 10, rows: 5 },
    { cols: 10, rows: 5 },
  ]);
});

test('resizePlan: subsequent active resize is one operation and passive is none', () => {
  assert.deepEqual(resizePlan(RESIZE_MODE.ACTIVE, 120, 40, false), [{ cols: 120, rows: 40 }]);
  assert.deepEqual(resizePlan(RESIZE_MODE.PASSIVE, 120, 40, true), []);
});

test('shouldBroadcastPTYOutput: pending active clients are suppressed until resize is accepted', () => {
  const active = { id: 'active' };
  const pending = new Set([active]);

  assert.equal(shouldBroadcastPTYOutput(active, pending), false);
  pending.delete(active);
  assert.equal(shouldBroadcastPTYOutput(active, pending), true);
});

// ---------- activeClientSizes ----------

test('activeClientSizes: returns only ACTIVE client sizes (filters out passive)', () => {
  const wsA = { id: 'A' };
  const wsB = { id: 'B' };
  const wsC = { id: 'C' };
  const clientSizes = new Map([
    [wsA, { cols: 100, rows: 30 }],
    [wsB, { cols: 40, rows: 10 }],   // passive — must be excluded even though smaller
    [wsC, { cols: 80, rows: 24 }],
  ]);
  const clientModes = new Map([
    [wsA, RESIZE_MODE.ACTIVE],
    [wsB, RESIZE_MODE.PASSIVE],
    [wsC, RESIZE_MODE.ACTIVE],
  ]);
  const result = activeClientSizes(clientSizes, clientModes);
  assert.equal(result.length, 2);
  // The passive client's tiny size must NOT appear in active set.
  for (const s of result) {
    assert.notEqual(s.cols, 40);
  }
});

test('activeClientSizes: empty when no active clients', () => {
  const ws = { id: 'P' };
  const clientSizes = new Map([[ws, { cols: 40, rows: 10 }]]);
  const clientModes = new Map([[ws, RESIZE_MODE.PASSIVE]]);
  assert.equal(activeClientSizes(clientSizes, clientModes).length, 0);
});

test('activeClientSizes: returns ALL when clientModes empty (back-compat: legacy entries)', () => {
  const ws1 = { id: '1' };
  const ws2 = { id: '2' };
  const clientSizes = new Map([
    [ws1, { cols: 100, rows: 30 }],
    [ws2, { cols: 80, rows: 24 }],
  ]);
  // No modes recorded — old behaviour: everyone is active.
  const result = activeClientSizes(clientSizes, new Map());
  assert.equal(result.length, 2);
});

// ---------- computeMinSize ----------

test('computeMinSize: returns min cols/rows across active clients', () => {
  const sizes = [
    { cols: 120, rows: 40 },
    { cols: 80, rows: 24 },
    { cols: 100, rows: 30 },
  ];
  assert.deepEqual(computeMinSize(sizes), { cols: 80, rows: 24 });
});

test('computeMinSize: returns null for empty list (no recomputation needed)', () => {
  assert.equal(computeMinSize([]), null);
});

// ---------- End-to-end decision scenario (no I/O) ----------

test('SCENARIO: passive mobile resize does NOT shrink shared PTY', () => {
  // Simulate: PC is active at 120x40, mobile joins passive at 40x10.
  const wsPC = { id: 'PC' };
  const wsMobile = { id: 'Mobile' };
  const clientSizes = new Map([
    [wsPC, { cols: 120, rows: 40 }],
    [wsMobile, { cols: 40, rows: 10 }],
  ]);
  const clientModes = new Map([
    [wsPC, RESIZE_MODE.ACTIVE],
    [wsMobile, RESIZE_MODE.PASSIVE],
  ]);

  // Mobile resize message arrives.
  const mobileMode = clientModes.get(wsMobile);
  const mobileMayResize = shouldResizePTY(mobileMode);
  assert.equal(mobileMayResize, false, 'mobile passive resize must not call pty.resize');

  // Even if mobile's size is recorded, recomputation must ignore it.
  const activeSizes = activeClientSizes(clientSizes, clientModes);
  const minSize = computeMinSize(activeSizes);
  assert.deepEqual(minSize, { cols: 120, rows: 40 }, 'PTY must stay at PC size');
});

test('SCENARIO: when mobile passive disconnects, PTY size unchanged', () => {
  // Mobile leaves; only PC remains.
  const wsPC = { id: 'PC' };
  const clientSizes = new Map([[wsPC, { cols: 120, rows: 40 }]]);
  const clientModes = new Map([[wsPC, RESIZE_MODE.ACTIVE]]);

  const activeSizes = activeClientSizes(clientSizes, clientModes);
  const minSize = computeMinSize(activeSizes);
  assert.deepEqual(minSize, { cols: 120, rows: 40 });
});

test('SCENARIO: two active clients still recompute to min (preserves existing Web behaviour)', () => {
  const ws1 = { id: '1' };
  const ws2 = { id: '2' };
  const clientSizes = new Map([
    [ws1, { cols: 120, rows: 40 }],
    [ws2, { cols: 80, rows: 24 }],
  ]);
  const clientModes = new Map([
    [ws1, RESIZE_MODE.ACTIVE],
    [ws2, RESIZE_MODE.ACTIVE],
  ]);
  const minSize = computeMinSize(activeClientSizes(clientSizes, clientModes));
  assert.deepEqual(minSize, { cols: 80, rows: 24 });
});
