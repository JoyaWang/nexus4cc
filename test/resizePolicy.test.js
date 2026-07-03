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
