import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  appendAnsiOutput,
  boundAnsiOutput,
  safeAnsiSuffix,
  terminalModeSync,
  updateAlternateScreenState,
} from '../server/terminalOutput.js';

test('safeAnsiSuffix never starts inside an ANSI control sequence', () => {
  const input = `old\x1b[31mred\x1b[0mnew`;
  const suffix = safeAnsiSuffix(input, Buffer.byteLength('\x1b[0mnew'));

  assert.equal(suffix, '\x1b[0mnew');
  assert.doesNotMatch(suffix, /^\x1b\[[0-9;]*$/);
});

test('safeAnsiSuffix preserves a complete OSC token at the suffix boundary', () => {
  const input = `old\x1b]0;terminal title\x07new`;
  const suffix = safeAnsiSuffix(input, Buffer.byteLength('\x1b]0;terminal title\x07new'));

  assert.equal(suffix, '\x1b]0;terminal title\x07new');
});

test('safeAnsiSuffix never returns an unterminated CSI or OSC token', () => {
  assert.equal(safeAnsiSuffix('visible\x1b[31', 100), 'visible');
  assert.equal(safeAnsiSuffix('visible\x1b]0;partial title', 100), 'visible');
});

test('safeAnsiSuffix keeps DCS/APC/SOS/PM payloads atomic at the suffix boundary', () => {
  for (const introducer of ['P', '_', 'X', '^']) {
    const input = `old\x1b${introducer}payload\x1b\\new`;
    const suffix = safeAnsiSuffix(input, Buffer.byteLength(`payload\x1b\\new`));

    assert.equal(suffix, 'new', `ESC ${introducer} payload must not be replayed from its middle`);
  }
});

test('appendAnsiOutput completes DCS/APC/SOS/PM tokens across PTY chunks', () => {
  for (const introducer of ['P', '_', 'X', '^']) {
    const partial = appendAnsiOutput('prefix', `\x1b${introducer}payload`, 100);
    assert.equal(partial, `prefix\x1b${introducer}payload`);
    assert.equal(
      appendAnsiOutput(partial, '\x1b\\visible', 100),
      `prefix\x1b${introducer}payload\x1b\\visible`,
    );
  }
});

test('boundAnsiOutput drops oversized unterminated DCS/APC/SOS/PM tokens', () => {
  for (const introducer of ['P', '_', 'X', '^']) {
    const output = boundAnsiOutput(`prefix\x1b${introducer}${'x'.repeat(5000)}`, 100);
    assert.equal(output, '', `ESC ${introducer} oversized token must not defeat the byte bound`);
  }
});

test('appendAnsiOutput bounds output without splitting ANSI tokens', () => {
  const output = appendAnsiOutput('prefix\x1b[38;5;42m', 'value\x1b[0m', 9);

  assert.equal(output, 'value\x1b[0m');
  assert.doesNotMatch(output, /\x1b\[[^m]*$/);
});

test('appendAnsiOutput retains an incomplete token until the next chunk completes it', () => {
  const partial = appendAnsiOutput('prefix', '\x1b[31', 100);
  assert.equal(partial, 'prefix\x1b[31');
  assert.equal(appendAnsiOutput(partial, 'mred\x1b[0m', 100), 'prefix\x1b[31mred\x1b[0m');
});

test('boundAnsiOutput never exceeds its byte limit for a huge unterminated token', () => {
  const output = boundAnsiOutput(`prefix\x1b]0;${'x'.repeat(5000)}`, 100);

  assert.equal(output, '');
  assert.ok(Buffer.byteLength(output, 'utf8') <= 100);
});

test('updateAlternateScreenState tracks enter and leave across PTY chunks', () => {
  const entered = updateAlternateScreenState(false, '', 'before\x1b[?104');
  const completed = updateAlternateScreenState(
    entered.alternateScreen,
    entered.scanTail,
    '9hafter',
  );
  const left = updateAlternateScreenState(
    completed.alternateScreen,
    completed.scanTail,
    '\x1b[?1049l',
  );

  assert.equal(entered.alternateScreen, false);
  assert.equal(completed.alternateScreen, true);
  assert.equal(left.alternateScreen, false);
});

test('terminalModeSync selects the authoritative main or alternate buffer', () => {
  assert.equal(terminalModeSync(true), '\x1b[?1049h\x1b[2J\x1b[H');
  assert.equal(terminalModeSync(false), '\x1b[?1049l\x1b[2J\x1b[H');
});
