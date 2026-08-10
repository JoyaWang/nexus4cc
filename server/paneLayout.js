// Real tmux pane geometry for the attached window, pushed to clients as a
// `pane_layout` control message.
//
// The old client-side divider detection guessed positions from terminal
// border glyphs (`|`, `-`, …) and mis-fired on OpenCode TUI frames and plain
// text separators. This module replaces that guess with authoritative tmux
// geometry: `tmux list-panes` reports every pane's exact cell rectangle, so
// the client can compute dividers from real shared edges only.
//
// Trigger timing (honest contract, not over-stated as "real time"):
//   - once right after the initial WS handshake / identity push,
//   - immediately after a client resize takes effect,
//   - on layout change detection via a debounced poll driven by PTY output
//     activity (tmux repaints the window whenever a pane is resized, split or
//     closed). Control-mode `%layout-change` subscription was considered but
//     rejected as too invasive for the existing `attach-session` PTY model;
//     the debounced poll is bounded, only runs while clients are attached,
//     and stops as soon as the window goes quiet.
//
// A failed query logs an error and sends nothing — clients must never receive
// fabricated pane geometry.

import { execFileSync } from 'node:child_process';

export const PANE_LAYOUT_FORMAT =
  '#{pane_id}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}|#{pane_active}';

/**
 * Runs `tmux list-panes` for one window of the given (linked) session and
 * returns the parsed layout, or `null` when tmux is unavailable / the target
 * disappeared. Callers decide how to log; this function never throws.
 */
export function queryPaneLayout(linkedSession, windowId, cols, rows) {
  let output;
  try {
    output = execFileSync(
      'tmux',
      ['list-panes', '-t', `${linkedSession}:${windowId}`, '-F', PANE_LAYOUT_FORMAT],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'nexus.pane_layout.query_failed',
      linkedSession,
      windowId,
      errorType: error?.constructor?.name || 'Error',
    }));
    return null;
  }
  const panes = parsePaneListOutput(output);
  if (panes.length === 0) {
    console.warn(JSON.stringify({
      event: 'nexus.pane_layout.empty_window',
      linkedSession,
      windowId,
    }));
    return null;
  }
  return { windowId, cols, rows, panes };
}

/**
 * Parses the raw `tmux list-panes` line output into pane rectangles.
 *
 * One line per pane, format:
 *   #{pane_id}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}|#{pane_active}
 *   e.g. `%64|0|0|34|48|1`
 *
 * Lines that fail to parse are skipped; a fully unparsable result means the
 * caller treats the window as unknown and sends no fake layout.
 */
export function parsePaneListOutput(output) {
  const panes = [];
  const text = String(output || '').trim();
  if (!text) return panes;
  for (const line of text.split('\n')) {
    const parts = line.trim().split('|');
    if (parts.length !== 6) continue;
    const [paneId, leftRaw, topRaw, widthRaw, heightRaw, activeRaw] = parts;
    const left = Number(leftRaw);
    const top = Number(topRaw);
    const width = Number(widthRaw);
    const height = Number(heightRaw);
    if (!paneId ||
        !Number.isInteger(left) ||
        !Number.isInteger(top) ||
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width <= 0 ||
        height <= 0) {
      continue;
    }
    panes.push({
      paneId,
      left,
      top,
      width,
      height,
      active: String(activeRaw).trim() === '1',
    });
  }
  return panes;
}

/**
 * Serializes a parsed layout into the wire message sent to clients.
 * Pure and safe: nothing here can throw or fabricate data.
 */
export function paneLayoutMessage(layout) {
  if (!layout || !Array.isArray(layout.panes) || layout.panes.length === 0) {
    return null;
  }
  return JSON.stringify({
    type: 'pane_layout',
    windowId: layout.windowId,
    cols: layout.cols,
    rows: layout.rows,
    panes: layout.panes,
  });
}

/**
 * Deep equality over the geometry that matters for divider placement.
 * `active` is included because it may drive future UI (e.g. which pane holds
 * the focus), but geometry-only layout changes are enough to trigger a push.
 */
export function samePaneLayout(left, right) {
  if (!left || !right) return false;
  if (left.windowId !== right.windowId ||
      left.cols !== right.cols ||
      left.rows !== right.rows ||
      left.panes.length !== right.panes.length) {
    return false;
  }
  for (let i = 0; i < left.panes.length; i++) {
    const a = left.panes[i];
    const b = right.panes[i];
    if (a.paneId !== b.paneId ||
        a.left !== b.left ||
        a.top !== b.top ||
        a.width !== b.width ||
        a.height !== b.height ||
        a.active !== b.active) {
      return false;
    }
  }
  return true;
}
