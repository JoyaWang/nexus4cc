// Server-side resize isolation policy (Nexus4CC Phase 2 spike).
//
// Pure decision functions — NO side effects, NO node-pty, NO WebSocket imports.
// This module is imported by both:
//   - server.js        (live WS connection handling)
//   - test/resizePolicy.test.js (unit tests, no I/O)
//
// CONTRACT (Nexus4CC Phase 2 — server-side resize isolation):
//   - A connection declares `resizeMode=active|passive` via WS URL query.
//   - Default (no param, or unknown value) is ACTIVE — preserves existing Web
//     behaviour, so the browser UI never regresses.
//   - PASSIVE clients (e.g. Nexus Go mobile companion) may:
//       * still receive PTY output (read-only view),
//       * still send keystrokes/commands,
//       * but their resize messages MUST NOT call pty.resize,
//       * and on disconnect they MUST NOT participate in min-size recomputation.
//   - This prevents a phone / small window from shrinking the shared tmux pane
//     that an active PC client is using (the "no-PC-break" guarantee).
//
// Phase 3 hook: Nexus Go will connect with `?...&resizeMode=passive` to honour
// this contract without needing its own server-side coordination.

export const RESIZE_MODE = Object.freeze({
  ACTIVE: 'active',
  PASSIVE: 'passive',
});

// Parse the `resizeMode` query param. Unknown/missing → ACTIVE (back-compat).
// @param {string|null|undefined} param
// @returns {'active'|'passive'}
export function parseResizeMode(param) {
  if (typeof param !== 'string') return RESIZE_MODE.ACTIVE;
  const lower = param.toLowerCase();
  if (lower === RESIZE_MODE.PASSIVE) return RESIZE_MODE.PASSIVE;
  return RESIZE_MODE.ACTIVE;
}

// Whether a client with the given mode is allowed to drive pty.resize.
// @param {'active'|'passive'} mode
// @returns {boolean}
export function shouldResizePTY(mode) {
  return mode !== RESIZE_MODE.PASSIVE;
}

// Filter clientSizes down to ACTIVE clients only, for use in min-size
// recomputation when a client disconnects.
//
// Back-compat: if clientModes is empty (legacy entries, or PTY created before
// mode tracking was added), every client is treated as ACTIVE — preserving
// the pre-Phase-2 behaviour.
//
// @param {Map<ws,{cols,rows}>} clientSizes
// @param {Map<ws,('active'|'passive')>} clientModes
// @returns {Array<{cols,rows}>}
export function activeClientSizes(clientSizes, clientModes) {
  const out = [];
  if (!clientModes || clientModes.size === 0) {
    for (const size of clientSizes.values()) out.push(size);
    return out;
  }
  for (const [ws, size] of clientSizes) {
    const mode = clientModes.get(ws);
    // Unknown mode → treat as ACTIVE (safe default).
    if (mode !== RESIZE_MODE.PASSIVE) out.push(size);
  }
  return out;
}

// Compute the minimum cols/rows across a list of client sizes.
// Returns null for an empty list, signalling "no recomputation needed".
//
// @param {Array<{cols,rows}>} sizes
// @returns {{cols:number,rows:number}|null}
export function computeMinSize(sizes) {
  if (!sizes || sizes.length === 0) return null;
  let minCols = Infinity;
  let minRows = Infinity;
  for (const s of sizes) {
    if (s.cols < minCols) minCols = s.cols;
    if (s.rows < minRows) minRows = s.rows;
  }
  if (minCols === Infinity) return null;
  return { cols: minCols, rows: minRows };
}
