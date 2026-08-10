import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePaneListOutput,
  paneLayoutMessage,
  samePaneLayout,
  PANE_LAYOUT_FORMAT,
} from '../server/paneLayout.js';

test('parsePaneListOutput parses real tmux geometry lines', () => {
  const output = [
    '%64|0|0|34|48|1',
    '%65|35|0|34|48|0',
  ].join('\n');
  assert.deepEqual(parsePaneListOutput(output), [
    { paneId: '%64', left: 0, top: 0, width: 34, height: 48, active: true },
    { paneId: '%65', left: 35, top: 0, width: 34, height: 48, active: false },
  ]);
});

test('parsePaneListOutput supports horizontal splits', () => {
  const output = [
    '%64|0|0|69|24|0',
    '%65|0|25|69|23|1',
  ].join('\n');
  const panes = parsePaneListOutput(output);
  assert.equal(panes.length, 2);
  assert.equal(panes[1].top, 25);
  assert.equal(panes[1].height, 23);
  assert.equal(panes[1].active, true);
});

test('parsePaneListOutput drops malformed and empty lines', () => {
  const output = [
    '%64|0|0|34|48|1',
    '%broken',
    '|||',
    '%66|0|0|0|10|0', // zero width -> invalid
    '',
  ].join('\n');
  const panes = parsePaneListOutput(output);
  assert.equal(panes.length, 1);
  assert.equal(panes[0].paneId, '%64');
});

test('parsePaneListOutput returns empty for empty output', () => {
  assert.deepEqual(parsePaneListOutput(''), []);
  assert.deepEqual(parsePaneListOutput('  \n'), []);
  assert.deepEqual(parsePaneListOutput(null), []);
});

test('paneLayoutMessage serializes the wire message', () => {
  const layout = {
    windowId: '@17',
    cols: 120,
    rows: 30,
    panes: [
      { paneId: '%64', left: 0, top: 0, width: 60, height: 30, active: true },
      { paneId: '%65', left: 61, top: 0, width: 59, height: 30, active: false },
    ],
  };
  assert.deepEqual(JSON.parse(paneLayoutMessage(layout)), {
    type: 'pane_layout',
    windowId: '@17',
    cols: 120,
    rows: 30,
    panes: layout.panes,
  });
});

test('paneLayoutMessage returns null for empty layout (no fake data)', () => {
  assert.equal(paneLayoutMessage(null), null);
  assert.equal(paneLayoutMessage({ windowId: '@1', panes: [] }), null);
});

test('samePaneLayout detects geometry changes only', () => {
  const base = {
    windowId: '@17',
    cols: 120,
    rows: 30,
    panes: [
      { paneId: '%64', left: 0, top: 0, width: 34, height: 48, active: true },
      { paneId: '%65', left: 35, top: 0, width: 34, height: 48, active: false },
    ],
  };
  assert.equal(samePaneLayout(base, structuredClone(base)), true);
  const moved = structuredClone(base);
  moved.panes[1].left = 40;
  assert.equal(samePaneLayout(base, moved), false);
  const resized = structuredClone(base);
  resized.panes[0].width = 40;
  assert.equal(samePaneLayout(base, resized), false);
  const inactive = structuredClone(base);
  inactive.panes[0].active = false;
  assert.equal(samePaneLayout(base, inactive), false);
  assert.equal(samePaneLayout(base, null), false);
});

test('PANE_LAYOUT_FORMAT queries real tmux fields for divider geometry', () => {
  assert.match(PANE_LAYOUT_FORMAT, /pane_id/);
  assert.match(PANE_LAYOUT_FORMAT, /pane_left/);
  assert.match(PANE_LAYOUT_FORMAT, /pane_top/);
  assert.match(PANE_LAYOUT_FORMAT, /pane_width/);
  assert.match(PANE_LAYOUT_FORMAT, /pane_height/);
  assert.match(PANE_LAYOUT_FORMAT, /pane_active/);
});
