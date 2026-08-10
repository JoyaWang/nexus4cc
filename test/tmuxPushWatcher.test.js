import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TmuxPushStateMachine,
  classifyTmuxPane,
  parseTmuxWindowList,
  tmuxPushTargetKey,
} from '../server/tmuxPushWatcher.js';

const TARGET = {
  projectId: '28',
  windowIndex: 1,
  windowId: '@39',
  windowName: 'MoCode离线通知',
  paneId: '%41',
};
const KEY = tmuxPushTargetKey('conn-1', TARGET);
const EPOCH = 1_800_000_000_000;

function digestOf(text) {
  return `d:${text}`;
}

test('window list parsing filters linked sessions and keeps windowName', () => {
  const output = [
    '28|1|@39|MoCode离线通知|%41',
    '__nexus_ws_abc|0|@1|internal|%2',
    '0|0|@0|JoyaProjects|%1',
    'broken|row',
    '',
  ].join('\n');
  const targets = parseTmuxWindowList(output);
  assert.equal(targets.length, 2);
  assert.deepEqual(targets[0], TARGET);
  assert.equal(targets[1].projectId, '0');
  assert.equal(targets.some(t => t.projectId.startsWith('__nexus_ws_')), false);
});

test('shell prompt is idle_silent, never session.idle', () => {
  assert.equal(classifyTmuxPane('$ ls\nfile1\n❯ '), 'idle_silent');
  assert.equal(classifyTmuxPane('output\n› '), 'idle_silent');
  assert.equal(classifyTmuxPane('output\n> '), 'idle_silent');
  assert.equal(classifyTmuxPane(''), 'idle_silent');
});

test('agent idle chrome is the only completion signal', () => {
  assert.equal(
    classifyTmuxPane('Done.\nAsk anything...\nctrl+p commands'),
    'session.idle',
  );
  assert.equal(classifyTmuxPane('some random quiet text'), 'idle_silent');
});

test('interrupt affordance wins over idle markers', () => {
  assert.equal(
    classifyTmuxPane('Ask anything...\nesc interrupt'),
    'busy',
  );
});

test('permission requires an interactive prompt shape', () => {
  assert.equal(
    classifyTmuxPane('Do you want to proceed?\nAllow this action? [y/n]'),
    'permission.asked',
  );
  // Prose mentioning approvals must not trigger.
  assert.equal(
    classifyTmuxPane('I will allow this pattern in code reviews.'),
    'idle_silent',
  );
});

test('question requires an interactive question line', () => {
  assert.equal(
    classifyTmuxPane('Question: which file should I edit?'),
    'question.asked',
  );
});

test('error tail is detected', () => {
  assert.equal(
    classifyTmuxPane('running tests\nError: boom\ntraceback follows'),
    'session.error',
  );
});

test('busy must be stable before arming; flicker never notifies', () => {
  const sm = new TmuxPushStateMachine();
  let now = EPOCH;
  // Oscillate busy/idle with changing content — the false-positive pattern
  // observed in production.
  for (let i = 0; i < 20; i++) {
    const busyAction = sm.update(KEY, 'busy', digestOf(`busy-${i}`), now);
    assert.ok(busyAction === null || busyAction === 'session.status');
    now += 2000;
    const idleAction = sm.update(KEY, 'session.idle', digestOf(`idle-${i}`), now);
    assert.equal(idleAction, null);
    now += 2000;
  }
});

test('stable busy arms once, then stable terminal fires once', () => {
  const sm = new TmuxPushStateMachine();
  let now = EPOCH;
  assert.equal(sm.update(KEY, 'busy', digestOf('b1'), now += 2000), null);
  assert.equal(sm.update(KEY, 'busy', digestOf('b2'), now += 2000), null);
  // Third stable busy announces the busy cycle to the relay.
  assert.equal(sm.update(KEY, 'busy', digestOf('b3'), now += 2000), 'session.status');
  assert.equal(sm.update(KEY, 'busy', digestOf('b4'), now += 2000), null);
  // Terminal needs two consecutive identical classifications.
  assert.equal(sm.update(KEY, 'session.idle', digestOf('i1'), now += 2000), null);
  assert.equal(sm.update(KEY, 'session.idle', digestOf('i2'), now += 2000), 'session.idle');
  // Fired: disarmed. Further idle changes do not notify.
  assert.equal(sm.update(KEY, 'session.idle', digestOf('i3'), now += 2000), null);
});

test('static busy arms once and static finished tail still delivers', () => {
  const sm = new TmuxPushStateMachine();
  let now = EPOCH;
  // Content never changes: rounds, not digest changes, drive stability.
  assert.equal(sm.update(KEY, 'busy', digestOf('static-busy'), now += 2000), null);
  assert.equal(sm.update(KEY, 'busy', digestOf('static-busy'), now += 2000), null);
  assert.equal(
    sm.update(KEY, 'busy', digestOf('static-busy'), now += 2000),
    'session.status',
  );
  // The busy announcement is a one-shot even while busy persists.
  assert.equal(sm.update(KEY, 'busy', digestOf('static-busy'), now += 2000), null);
  // A finished agent tail stops changing but must still be delivered.
  assert.equal(sm.update(KEY, 'session.idle', digestOf('static-idle'), now += 2000), null);
  assert.equal(
    sm.update(KEY, 'session.idle', digestOf('static-idle'), now += 2000),
    'session.idle',
  );
  // After firing, a static idle pane stays silent.
  assert.equal(sm.update(KEY, 'session.idle', digestOf('static-idle'), now += 2000), null);
  assert.equal(sm.update(KEY, 'session.idle', digestOf('static-idle'), now += 2000), null);
});

test('cooldown suppresses repeats without resetting the window', () => {
  const sm = new TmuxPushStateMachine({ cooldownMs: 60_000 });
  let now = EPOCH;
  const cycle = (tag) => {
    for (let i = 0; i < 3; i++) sm.update(KEY, 'busy', digestOf(`b-${tag}-${i}`), now += 2000);
    sm.update(KEY, 'session.idle', digestOf(`i-${tag}-1`), now += 2000);
    return sm.update(KEY, 'session.idle', digestOf(`i-${tag}-2`), now += 2000);
  };
  assert.equal(cycle('a'), 'session.idle');
  // 30 seconds later a fresh busy->idle cycle is still inside cooldown.
  now += 30_000;
  assert.equal(cycle('b'), null);
  // After the cooldown expires the next cycle notifies again.
  now += 31_000;
  assert.equal(cycle('c'), 'session.idle');
});

test('terminal kind switch fires, same kind repeats do not', () => {
  const sm = new TmuxPushStateMachine();
  let now = EPOCH;
  for (let i = 0; i < 3; i++) sm.update(KEY, 'busy', digestOf(`b${i}`), now += 2000);
  sm.update(KEY, 'session.idle', digestOf('i1'), now += 2000);
  assert.equal(sm.update(KEY, 'session.idle', digestOf('i2'), now += 2000), 'session.idle');
  // A new busy cycle then a permission prompt notifies for the new kind.
  for (let i = 0; i < 3; i++) sm.update(KEY, 'busy', digestOf(`bb${i}`), now += 2000);
  sm.update(KEY, 'permission.asked', digestOf('p1'), now += 2000);
  assert.equal(sm.update(KEY, 'permission.asked', digestOf('p2'), now += 2000), 'permission.asked');
});

test('idle_silent disarms without notifying', () => {
  const sm = new TmuxPushStateMachine();
  let now = EPOCH;
  for (let i = 0; i < 3; i++) sm.update(KEY, 'busy', digestOf(`b${i}`), now += 2000);
  sm.update(KEY, 'idle_silent', digestOf('s1'), now += 2000);
  // Agent finished into a shell prompt: no completion notification.
  assert.equal(sm.update(KEY, 'idle_silent', digestOf('s2'), now += 2000), null);
  assert.equal(sm.update(KEY, 'session.idle', digestOf('i1'), now += 2000), null);
  assert.equal(sm.update(KEY, 'session.idle', digestOf('i2'), now += 2000), null);
});

test('prune drops state for windows that disappeared', () => {
  const sm = new TmuxPushStateMachine();
  sm.update(KEY, 'busy', digestOf('b1'), 1000);
  sm.prune(new Set());
  // State removed: the target starts cold again and cannot fire a terminal.
  assert.equal(sm.update(KEY, 'session.idle', digestOf('i1'), 3000), null);
  assert.equal(sm.update(KEY, 'session.idle', digestOf('i2'), 5000), null);
});
