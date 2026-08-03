import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ScrollbackStore,
  capturePane,
  paginateLines,
  parseScrollbackParams,
  splitLogicalLines,
  stripCurrentPane,
} from '../server/scrollback.js';

test('splitLogicalLines preserves trailing spaces and ANSI sequences', () => {
  const content = '\x1b[31mred  \x1b[0m\nnext  \n';

  assert.deepEqual(splitLogicalLines(content), [
    '\x1b[31mred  \x1b[0m',
    'next  ',
  ]);
  assert.deepEqual(splitLogicalLines('line  '), ['line  ']);
});

test('stripCurrentPane removes the trailing current-screen lines from a capture', () => {
  const lines = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(stripCurrentPane(lines, 2), ['a', 'b', 'c']);
  assert.deepEqual(stripCurrentPane(lines, 10), []);
  assert.deepEqual(stripCurrentPane(['a', 'b'], 2), []);
  assert.deepEqual(stripCurrentPane(lines, 0), [...lines]);
  assert.deepEqual(stripCurrentPane([], 2), []);
  assert.deepEqual(stripCurrentPane(lines, -1), [...lines]);
});

test('paginateLines returns oldest content first and advances by logical lines', () => {
  const lines = ['old\x1b[31m', 'middle', 'new\x1b[0m'];

  assert.deepEqual(paginateLines(lines, 0, 2), {
    content: 'old\x1b[31m\nmiddle',
    offset: 0,
    returnedLines: 2,
    totalLines: 3,
    hasMore: true,
    nextOffset: 2,
  });
  assert.deepEqual(paginateLines(lines, 2, 2), {
    content: 'new\x1b[0m',
    offset: 2,
    returnedLines: 1,
    totalLines: 3,
    hasMore: false,
    nextOffset: null,
  });
});

test('ScrollbackStore keeps a stable snapshot, refreshes TTL on access, and rejects mismatched targets', () => {
  let now = 1000;
  const store = new ScrollbackStore({
    ttlMs: 100,
    maxSnapshots: 2,
    now: () => now,
    idFactory: () => 'snapshot-1',
  });
  const target = { session: 'session', windowIndex: 3, windowId: '@3', paneId: '%3' };
  const created = store.create(target, ['old', 'new']);

  assert.equal(created.snapshotId, 'snapshot-1');
  assert.deepEqual(store.get(created.snapshotId, { ...target }), {
    ok: true,
    snapshot: { snapshotId: 'snapshot-1', target, lines: ['old', 'new'] },
  });
  assert.deepEqual(store.get(created.snapshotId, { ...target, windowId: '@9', paneId: '%9' }), {
    ok: false,
    status: 409,
    code: 'scrollback_snapshot_target_mismatch',
  });

  now = 1050;
  assert.equal(store.get(created.snapshotId, target).ok, true);
  now = 1149;
  assert.equal(store.get(created.snapshotId, target).ok, true);
  now = 1250;
  assert.deepEqual(store.get(created.snapshotId, target), {
    ok: false,
    status: 410,
    code: 'scrollback_snapshot_expired',
  });
});

test('parseScrollbackParams validates target and separates page limit from legacy capture range', () => {
  assert.deepEqual(parseScrollbackParams({
    session: 'safe-session',
    windowIndex: 3,
  }), {
    ok: true,
    isLegacy: true,
    legacyLines: 3000,
    limit: null,
    offset: 0,
    snapshot: null,
  });

  assert.deepEqual(parseScrollbackParams({
    session: 'safe-session',
    windowIndex: 3,
    limit: '400',
    offset: '0',
  }), {
    ok: true,
    isLegacy: false,
    limit: 400,
    offset: 0,
    snapshot: null,
  });
  assert.deepEqual(parseScrollbackParams({
    session: 'safe-session',
    windowIndex: 3,
    lines: '3000',
  }), {
    ok: true,
    isLegacy: true,
    legacyLines: 3000,
    limit: null,
    offset: 0,
    snapshot: null,
  });
  assert.equal(parseScrollbackParams({ session: 'bad:target', windowIndex: 3, limit: '400', offset: '0' }).ok, false);
  assert.equal(parseScrollbackParams({ session: 'safe-session', windowIndex: -1, limit: '400', offset: '0' }).ok, false);
  assert.equal(parseScrollbackParams({ session: 'safe-session', windowIndex: 3, limit: '0', offset: '0' }).ok, false);
  assert.equal(parseScrollbackParams({ session: 'safe-session', windowIndex: 3, limit: '400', offset: '-1' }).ok, false);
  assert.equal(parseScrollbackParams({ session: 'safe-session', windowIndex: 3, limit: '400', offset: '0', snapshot: 'bad id' }).ok, false);
  assert.equal(parseScrollbackParams({ session: 'safe-session', windowIndex: 3, lines: '3000', offset: '1' }).ok, false);
  assert.equal(parseScrollbackParams({ session: 'safe-session', windowIndex: 3, lines: '3000', offset: '0' }).ok, false);
  assert.equal(parseScrollbackParams({ session: 'safe-session', windowIndex: 3, lines: '3000', limit: '400' }).ok, false);
  assert.equal(parseScrollbackParams({ session: 'safe-session', windowIndex: 3, lines: '3000', snapshot: 'snapshot-1' }).ok, false);
});

test('ScrollbackStore evicts the oldest snapshot at its capacity limit', () => {
  let id = 0;
  const store = new ScrollbackStore({ maxSnapshots: 1, idFactory: () => `snapshot-${++id}` });

  const firstTarget = { session: 'session', windowIndex: 1, windowId: '@1', paneId: '%1' };
  const secondTarget = { session: 'session', windowIndex: 2, windowId: '@2', paneId: '%2' };
  const first = store.create(firstTarget, ['first']);
  const second = store.create(secondTarget, ['second']);

  assert.equal(store.get(first.snapshotId, firstTarget).status, 410);
  assert.equal(store.get(second.snapshotId, secondTarget).ok, true);
});

test('ScrollbackStore enforces a bounded total byte budget', () => {
  let id = 0;
  const store = new ScrollbackStore({
    maxSnapshots: 10,
    maxBytes: 6,
    idFactory: () => `snapshot-${++id}`,
  });
  const firstTarget = { session: 'session', windowIndex: 1, windowId: '@1', paneId: '%1' };
  const secondTarget = { session: 'session', windowIndex: 2, windowId: '@2', paneId: '%2' };

  const first = store.create(firstTarget, ['1234']);
  const second = store.create(secondTarget, ['5678']);

  assert.equal(store.totalBytes, 4);
  assert.equal(store.get(first.snapshotId, firstTarget).status, 410);
  assert.equal(store.get(second.snapshotId, secondTarget).ok, true);
});

test('capturePane uses the stable pane identity, keeps -e, and does not trim pane output', async () => {
  const calls = [];
  const execFileFn = (command, args, options, callback) => {
    calls.push({ command, args, options });
    if (args[0] === 'display') return callback(null, '24|2000|0\n', '');
    callback(null, '\x1b[31mred  \n', '');
  };

  const result = await capturePane({
    target: { session: 'safe-session', windowIndex: 4, windowId: '@4', paneId: '%4' },
    lines: 3000,
    execFileFn,
  });

  assert.deepEqual(calls.map(call => call.command), ['tmux', 'tmux']);
  assert.deepEqual(calls[1].args, [
    'capture-pane', '-e', '-p', '-S', '-3000', '-t', '%4',
  ]);
  assert.equal(result.paneHeight, 24);
  assert.equal(result.alternateOn, false);
  assert.equal(result.content, '\x1b[31mred  \n');
});

test('capturePane expands the history-start marker to the pane history limit', async () => {
  const calls = [];
  const execFileFn = (command, args, options, callback) => {
    calls.push(args);
    if (args[0] === 'display') return callback(null, '24|2000|0\n', '');
    callback(null, 'old\nnew', '');
  };

  await capturePane({
    target: { session: 'safe-session', windowIndex: 4, windowId: '@4', paneId: '%4' },
    start: '-',
    execFileFn,
  });

  assert.deepEqual(calls[1], ['capture-pane', '-e', '-p', '-S', '-2000', '-t', '%4']);
});

test('capturePane uses the history limit when no start or lines are given', async () => {
  const calls = [];
  const execFileFn = (command, args, options, callback) => {
    calls.push(args);
    if (args[0] === 'display') return callback(null, '30|5000|0\n', '');
    callback(null, 'x\n', '');
  };

  await capturePane({
    target: { session: 'safe-session', windowIndex: 4, windowId: '@4', paneId: '%4' },
    execFileFn,
  });

  assert.deepEqual(calls[1], ['capture-pane', '-e', '-p', '-S', '-5000', '-t', '%4']);
});

test('capturePane reports alternate-screen mode for TUI panes', async () => {
  const calls = [];
  const execFileFn = (command, args, options, callback) => {
    calls.push(args);
    if (args[0] === 'display') return callback(null, '57|10000|1\n', '');
    callback(null, 'OpenCode current frame\n', '');
  };

  const result = await capturePane({
    target: { session: 'safe-session', windowIndex: 5, windowId: '@313', paneId: '%337' },
    start: '-',
    execFileFn,
  });

  assert.deepEqual(calls[0], [
    'display', '-p', '-t', '%337', '#{pane_height}|#{history_limit}|#{alternate_on}',
  ]);
  assert.deepEqual(calls[1], ['capture-pane', '-e', '-p', '-S', '-10000', '-t', '%337']);
  assert.equal(result.paneHeight, 57);
  assert.equal(result.alternateOn, true);
});

test('capturePane rejects when the pane display query fails', async () => {
  const execFileFn = (command, args, options, callback) => {
    callback(new Error('tmux unavailable'), '', '');
  };

  await assert.rejects(
    capturePane({ target: { paneId: '%4' }, execFileFn }),
    /tmux unavailable/,
  );
});
