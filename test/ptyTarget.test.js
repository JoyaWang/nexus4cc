import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isNexusLinkedSession,
  linkedSessionName,
  parseWindowIndex,
  summarizeTerminalInput,
} from '../server/ptyTarget.js';

test('linked session names are deterministic, hidden and window-specific', () => {
  const first = linkedSessionName('12', '@65');
  const same = linkedSessionName('12', '@65');
  const other = linkedSessionName('12', '@49');
  assert.equal(first, same);
  assert.notEqual(first, other);
  assert.equal(isNexusLinkedSession(first), true);
  assert.equal(isNexusLinkedSession('12'), false);
});

test('window query parsing rejects missing, fractional and negative targets', () => {
  assert.deepEqual(parseWindowIndex(null), { ok: false, reason: 'missing_window' });
  assert.deepEqual(parseWindowIndex('abc'), { ok: false, reason: 'invalid_window' });
  assert.deepEqual(parseWindowIndex('1.5'), { ok: false, reason: 'invalid_window' });
  assert.deepEqual(parseWindowIndex('-1'), { ok: false, reason: 'invalid_window' });
  assert.deepEqual(parseWindowIndex('0'), { ok: true, value: 0 });
  assert.deepEqual(parseWindowIndex('7'), { ok: true, value: 7 });
});

test('terminal input diagnostics classify escapes without exposing text', () => {
  assert.deepEqual(summarizeTerminalInput('\u001b[A'), {
    byteLength: 3,
    kind: 'arrow',
    hex: '1b5b41',
  });
  assert.deepEqual(summarizeTerminalInput('\u001b[<64;10;20M'), {
    byteLength: 12,
    kind: 'mouse_sgr',
    hex: '1b5b3c36343b31303b32304d',
  });
  assert.deepEqual(summarizeTerminalInput('secret command'), {
    byteLength: 14,
    kind: 'text',
    hex: null,
  });
});
