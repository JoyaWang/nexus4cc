import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertExactTargetIdentity,
  buildAuthoritativeIdentity,
  buildLiveTerminalIdentity,
  sameAuthoritativeIdentity,
} from '../server/authoritativeIdentity.js';
import {
  TerminalHistoryRecorder,
  paginateHistoryBlocks,
} from '../server/terminalHistoryRecorder.js';
import {
  OpenCodeBindingRegistry,
  requireOpenCodeBinding,
} from '../server/openCodeBinding.js';
import {
  bindingTransition,
  bindingTransitionWithRecordingState,
  discoverPaneProcess,
  parseOpenCodeSessionId,
  recordingStartState,
} from '../server/openCodeProcessBinding.js';

const target = {
  serverId: 'nexus-test-host',
  tmuxSession: 'project',
  windowIndex: 7,
  windowId: '@17',
  paneId: '%42',
  terminalKind: 'opencode',
  targetGeneration: 3,
};

test('authoritative identity compares every live target field and never title/cwd', () => {
  const identity = buildAuthoritativeIdentity({
    ...target,
    openCodeSessionId: 'ses_exact',
    recordingId: 'rec-1',
  });

  assert.equal(sameAuthoritativeIdentity(identity, { ...identity }), true);
  assert.equal(sameAuthoritativeIdentity(identity, { ...identity, paneId: '%99' }), false);
  assert.equal(sameAuthoritativeIdentity(identity, { ...identity, tmuxSession: 'other' }), false);
  assert.equal(sameAuthoritativeIdentity(identity, { ...identity, openCodeSessionId: 'ses_other' }), false);
  assert.equal(
    assertExactTargetIdentity(identity, { ...identity, cwd: '/other', title: 'different' }),
    true,
  );
});

test('OpenCode history requires an explicit exact binding and ignores title/cwd candidates', () => {
  const registry = new OpenCodeBindingRegistry();
  assert.throws(
    () => requireOpenCodeBinding(registry, target),
    /OPENCODE_BINDING_REQUIRED/,
  );

  registry.register({
    tmuxSession: 'project',
    windowId: '@17',
    paneId: '%42',
    openCodeSessionId: 'ses_exact',
  });
  assert.equal(requireOpenCodeBinding(registry, target), 'ses_exact');
  assert.throws(
    () => requireOpenCodeBinding(registry, { ...target, paneId: '%43' }),
    /OPENCODE_BINDING_REQUIRED/,
  );
});

test('live OpenCode terminal identity permits a missing optional history binding', () => {
  const identity = buildLiveTerminalIdentity({
    ...target,
    openCodeSessionId: null,
    recordingId: 'rec-live-unbound',
  });
  assert.equal(identity.terminalKind, 'opencode');
  assert.equal(identity.openCodeSessionId, null);
  assert.throws(
    () => buildAuthoritativeIdentity(identity),
    /OPENCODE_BINDING_REQUIRED/,
  );
});

const panePid = 52258;
const shellRows = [
  { pid: panePid, ppid: 1, command: '/bin/zsh -i' },
];

test('discovers the exact session from a descendant using every supported session flag', () => {
  for (const command of [
    'opencode --yolo -s ses_02664151bffeBRxChqi41ZAOYW',
    'opencode --yolo --session ses_02664151bffeBRxChqi41ZAOYW',
    'opencode --yolo --session=ses_02664151bffeBRxChqi41ZAOYW',
    '/opt/OpenCode/opencode.exe --session=ses_02664151bffeBRxChqi41ZAOYW',
  ]) {
    const result = discoverPaneProcess({
      panePid,
      processRows: [...shellRows, { pid: 60000, ppid: panePid, command }],
    });
    assert.deepEqual(
      { terminalKind: result.terminalKind, openCodeSessionId: result.openCodeSessionId },
      { terminalKind: 'opencode', openCodeSessionId: 'ses_02664151bffeBRxChqi41ZAOYW' },
    );
  }
});

test('process-tree discovery keeps unbound OpenCode live while invalid and ambiguous ids fail closed', () => {
  assert.deepEqual(
    discoverPaneProcess({ panePid, processRows: [...shellRows, { pid: 60001, ppid: panePid, command: 'opencode --yolo' }] }),
    {
      terminalKind: 'opencode',
      openCodeSessionId: null,
      bindingError: 'OPENCODE_SESSION_ID_MISSING',
      panePid,
      process: { pid: 60001, ppid: panePid, command: 'opencode --yolo' },
    },
  );
  assert.throws(
    () => discoverPaneProcess({ panePid, processRows: [...shellRows, { pid: 60002, ppid: panePid, command: 'opencode -s nope' }] }),
    /OPENCODE_SESSION_ID_INVALID/,
  );
  assert.throws(
    () => parseOpenCodeSessionId('opencode -s ses_one --session=ses_two'),
    /OPENCODE_SESSION_ID_AMBIGUOUS/,
  );
  assert.throws(
    () => discoverPaneProcess({
      panePid,
      processRows: [
        ...shellRows,
        { pid: 60003, ppid: panePid, command: 'opencode -s ses_one' },
        { pid: 60004, ppid: panePid, command: 'opencode -s ses_two' },
      ],
    }),
    /OPENCODE_SESSION_PROCESS_AMBIGUOUS/,
  );
});

test('non-descendant OpenCode is never adopted and shell state is complete', () => {
  const result = discoverPaneProcess({
    panePid,
    processRows: [
      ...shellRows,
      { pid: 61000, ppid: 99999, command: 'opencode -s ses_not_a_child' },
    ],
  });
  assert.equal(result.terminalKind, 'shell');
  assert.equal(result.openCodeSessionId, null);
  assert.deepEqual(recordingStartState(result.terminalKind), { complete: true, gap: null });
  assert.deepEqual(recordingStartState('opencode'), {
    complete: false,
    gap: 'recording_started_after_target',
  });
});

test('session changes rotate generations, while shell-to-OpenCode preserves the recorder', () => {
  assert.deepEqual(bindingTransition(null, 'ses_new'), {
    changed: true,
    preserveRecorder: true,
    rotateGeneration: false,
  });
  assert.deepEqual(bindingTransition('ses_old', 'ses_new'), {
    changed: true,
    preserveRecorder: false,
    rotateGeneration: true,
  });
  const oldIdentity = buildAuthoritativeIdentity({
    ...target,
    openCodeSessionId: 'ses_old',
    targetGeneration: 4,
    recordingId: 'rec-old',
  });
  const newIdentity = buildAuthoritativeIdentity({
    ...target,
    openCodeSessionId: 'ses_new',
    targetGeneration: 5,
    recordingId: 'rec-new',
  });
  assert.equal(sameAuthoritativeIdentity(oldIdentity, newIdentity), false);
});

test('generation recorder state follows the discovered terminal kind', () => {
  assert.deepEqual(
    bindingTransitionWithRecordingState('ses_old', null, 'shell'),
    {
      changed: true,
      preserveRecorder: false,
      rotateGeneration: true,
      recordingState: { complete: true, gap: null },
    },
  );
  assert.deepEqual(
    bindingTransitionWithRecordingState('ses_old', 'ses_new', 'opencode'),
    {
      changed: true,
      preserveRecorder: false,
      rotateGeneration: true,
      recordingState: {
        complete: false,
        gap: 'recording_started_after_target',
      },
    },
  );
  assert.deepEqual(
    bindingTransitionWithRecordingState(null, 'ses_exact', 'opencode'),
    {
      changed: true,
      preserveRecorder: true,
      rotateGeneration: false,
      recordingState: null,
    },
  );
  assert.deepEqual(recordingStartState('shell'), { complete: true, gap: null });
  assert.deepEqual(recordingStartState('opencode'), {
    complete: false,
    gap: 'recording_started_after_target',
  });
});

test('recorder emits self-contained serialized checkpoints, never raw PTY chunks', async () => {
  const recorder = new TerminalHistoryRecorder({
    identity: buildAuthoritativeIdentity({
      ...target,
      openCodeSessionId: 'ses_exact',
      recordingId: 'rec-test',
    }),
    maxBytes: 1024 * 1024,
    complete: true,
  });

  await recorder.append('\x1b[38;5;196m粗体\x1b[1m\x1b[0m\r\n', {
    cols: 80,
    rows: 24,
    resizeEpoch: 0,
  });
  await recorder.resize({ cols: 100, rows: 30 });
  await recorder.append('\x1b[2J\x1b[HALT\x1b[?1049h', {
    cols: 100,
    rows: 30,
    resizeEpoch: 1,
  });

  const page = await recorder.page({ limit: 10 });
  assert.equal(page.complete, true);
  assert.ok(page.blocks.length >= 2);
  assert.equal(page.blocks.every((block) => block.selfContained === true), true);
  assert.equal(page.blocks.some((block) => block.ansi.includes('\x1b[2J')), false);
  assert.equal(page.blocks.some((block) => block.ansi.includes('粗体')), true);
  assert.equal(page.blocks.some((block) => block.cols === 100 && block.resizeEpoch === 1), true);
  assert.equal(page.blocks.every((block) => block.ansi.startsWith('\x1b[0m')), true);
  assert.equal(page.blocks.every((block) => block.ansi.endsWith('\x1b[0m')), true);
});

test('first append resizes the headless terminal before writing and checkpoints the passed dimensions', async () => {
  const recorder = new TerminalHistoryRecorder({
    identity: buildAuthoritativeIdentity({
      ...target,
      openCodeSessionId: 'ses_exact',
      recordingId: 'rec-first-size',
    }),
    complete: true,
  });
  await recorder.append('首个 checkpoint', { cols: 80, rows: 24, resizeEpoch: 7 });
  const page = await recorder.page({ limit: 10 });
  assert.equal(page.blocks[0].cols, 80);
  assert.equal(page.blocks[0].rows, 24);
  assert.equal(page.blocks[0].resizeEpoch, 7);
});

test('history paging reaches earliest sequence beyond legacy limits', () => {
  const blocks = Array.from({ length: 6001 }, (_, index) => ({
    sequence: index + 1,
    ansi: `\x1b[38;5;${index % 256}mROW_${index}\x1b[0m`,
    cols: 120,
    rows: 40,
    resizeEpoch: 0,
    selfContained: true,
  }));

  let cursor;
  let pages = 0;
  let earliest = null;
  do {
    const page = paginateHistoryBlocks(blocks, { limit: 97, cursor });
    pages += 1;
    earliest = page.earliestSequence;
    cursor = page.olderCursor;
  } while (cursor !== null);

  assert.equal(earliest, 1);
  assert.ok(pages > 60);
});

test('recorder persists metadata and ANSI blocks without a plain-text substitute', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-history-'));
  try {
    const filePath = join(dir, 'recording.json');
    const recorder = new TerminalHistoryRecorder({
      identity: buildAuthoritativeIdentity({
        ...target,
        terminalKind: 'shell',
        openCodeSessionId: null,
        recordingId: 'rec-persist',
      }),
      filePath,
      complete: false,
      gap: 'recording_started_after_target',
    });
    await recorder.append('\x1b[38;5;196mCJK 中文\x1b[0m', { cols: 90, rows: 25 });
    await recorder.flush();
    const persisted = JSON.parse(readFileSync(filePath, 'utf8'));
    assert.equal(persisted.identity.recordingId, 'rec-persist');
    assert.equal(persisted.complete, false);
    assert.deepEqual(persisted.gaps, ['recording_started_after_target']);
    assert.match(persisted.blocks[0].ansi, /\x1b\[38;5;196m/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('serializer failure produces selfContained=false and an explicit gap', async () => {
  const recorder = new TerminalHistoryRecorder({
    identity: buildAuthoritativeIdentity({
      ...target,
      terminalKind: 'shell',
      openCodeSessionId: null,
      recordingId: 'rec-serialize-failure',
    }),
    complete: true,
  });
  recorder._terminal.__nexusSerializeAddon.serialize = () => {
    throw new Error('serializer unavailable');
  };
  await recorder.append('raw chunk must never become a visual block');
  const page = await recorder.page({ limit: 10 });
  assert.equal(page.complete, false);
  assert.ok(page.gaps.includes('visual_checkpoint_serialization_failed'));
  assert.equal(page.blocks[0].selfContained, false);
  assert.equal(page.blocks[0].ansi, '');
});

test('server v2 history route has no title/cwd/latest-directory resolver', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const route = source.match(/app\.get\('\/api\/sessions\/:id\/terminal-history'[\s\S]*?\n\}\);/);
  assert.ok(route, 'v2 terminal history route must exist');
  assert.doesNotMatch(route[0], /paneTitle|windowName|cwd|readLatestOpenCodeHistory|readOpenCodeHistory/);
  assert.match(source, /OPENCODE_BINDING_REQUIRED/);
  assert.match(source, /ws\.send\(JSON\.stringify\(\{ type: 'hello'/);
});
