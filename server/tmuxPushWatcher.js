// Tmux push watcher — pure logic extracted from server.js for testability.
//
// Design goals:
// - Auto-discover every tmux window (no per-window app registration needed).
// - Notify only on stable busy -> terminal-state transitions.
// - Never notify for plain shell prompt returns.
// - Suppress classification flicker and enforce per-kind cooldowns.

import { createHash } from 'node:crypto';

export const LINKED_SESSION_PREFIX = '__nexus_ws_';

/**
 * Parses `tmux list-windows -a -F` output into watch targets.
 * Rows belonging to internal Nexus linked sessions are excluded.
 */
export function parseTmuxWindowList(output) {
  const targets = [];
  for (const line of String(output).split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('|');
    if (parts.length < 5) continue;
    const [session, windowIndexRaw, windowId, windowName, paneId] = parts;
    if (!session || session.startsWith(LINKED_SESSION_PREFIX)) continue;
    const windowIndex = Number.parseInt(windowIndexRaw, 10);
    if (!Number.isInteger(windowIndex) || windowIndex < 0) continue;
    if (!windowId || !paneId) continue;
    targets.push({
      projectId: session,
      windowIndex,
      windowId,
      windowName,
      paneId,
    });
  }
  return targets;
}

/**
 * Classifies the tail of a pane capture.
 *
 * Returns one of:
 * - 'busy'              work appears to be running
 * - 'permission.asked'  an interactive approval prompt is visible
 * - 'question.asked'    an interactive question prompt is visible
 * - 'session.error'     an error/failure tail is visible
 * - 'session.idle'      an agent idle marker is visible (notify-worthy)
 * - 'idle_silent'       a plain shell prompt or empty pane (never notify)
 */
export function classifyTmuxPane(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const tail = lines.slice(-12).join('\n');
  if (!tail) return 'idle_silent';
  // OpenCode keeps its input chrome visible while a request is running. The
  // authoritative difference is the interrupt affordance: it is present only
  // during an active generation. Check it before the idle prompt markers.
  if (/esc interrupt/i.test(tail)) return 'busy';
  if (hasInteractivePrompt(lines, PERMISSION_HINT)) return 'permission.asked';
  if (hasInteractivePrompt(lines, QUESTION_HINT)) return 'question.asked';
  if (
    /(error|exception|traceback|failed|fatal)/i.test(tail) &&
    /(^|\n)\s*(error|failed|fatal)/i.test(tail)
  ) {
    return 'session.error';
  }
  // Agent idle chrome (OpenCode-style) is the only completion signal worth a
  // notification. A plain shell prompt is intentionally silent.
  if (/Ask anything\.\.\.|ctrl\+p commands/i.test(tail)) {
    return 'session.idle';
  }
  return 'idle_silent';
}

const PERMISSION_HINT =
  /^(?:allow|approve|permit|grant)\b.*[?？]|\[(?:y\/n|yes\/no)\]|\((?:y\/n|yes\/no)\)|允许|审批/i;
const QUESTION_HINT = /^(?:question|answer needed|please answer)\b.*[?？]|\?+\s*$/i;

function hasInteractivePrompt(lines, hint) {
  const tailLines = lines.slice(-12);
  return tailLines.some(line => hint.test(line));
}

export const WATCHER_DEFAULTS = Object.freeze({
  armRounds: 3,
  terminalRounds: 2,
  cooldownMs: 60_000,
});

const TERMINAL_KINDS = new Set([
  'permission.asked',
  'question.asked',
  'session.error',
  'session.idle',
]);

/**
 * Per-target debounce + cooldown state machine.
 *
 * Lifecycle: a 'busy' classification must be stable for `armRounds`
 * consecutive content changes to arm the target. Once armed, a terminal
 * classification must be stable for `terminalRounds` consecutive identical
 * classifications and must differ from the last terminal kind that was sent
 * for this target. Firing disarms the target, so the next notification
 * requires a fresh busy cycle. Per-kind cooldown suppresses repeats without
 * resetting the cooldown window.
 */
export class TmuxPushStateMachine {
  constructor(options = {}) {
    this.armRounds = options.armRounds ?? WATCHER_DEFAULTS.armRounds;
    this.terminalRounds =
      options.terminalRounds ?? WATCHER_DEFAULTS.terminalRounds;
    this.cooldownMs = options.cooldownMs ?? WATCHER_DEFAULTS.cooldownMs;
    this._states = new Map();
  }

  /**
   * @returns the terminal kind to send, 'session.status' to announce a newly
   *          armed busy cycle, or null when nothing should be sent.
   *
   * Stability is measured in poll rounds, not content changes: a static pane
   * that keeps its classification still advances the streaks, so a finished
   * agent whose tail stops changing is still delivered.
   */
  update(key, kind, digest, now) {
    let state = this._states.get(key);
    if (!state) {
      state = {
        digest: '',
        busyStreak: 0,
        armed: false,
        pendingKind: null,
        pendingStreak: 0,
        lastSentKind: null,
        lastSentAt: new Map(),
        busyAnnounced: false,
      };
      this._states.set(key, state);
    }

    if (kind === 'busy') {
      state.pendingKind = null;
      state.pendingStreak = 0;
      state.busyStreak += 1;
      if (!state.armed && state.busyStreak >= this.armRounds) {
        state.armed = true;
        state.lastSentKind = null;
      }
      if (state.armed && !state.busyAnnounced) {
        state.busyAnnounced = true;
        return 'session.status';
      }
      return null;
    }

    state.busyStreak = 0;
    if (!TERMINAL_KINDS.has(kind)) {
      // idle_silent: quietly disarm; a shell prompt is not a completion.
      state.armed = false;
      state.busyAnnounced = false;
      state.pendingKind = null;
      state.pendingStreak = 0;
      return null;
    }

    if (!state.armed) {
      state.pendingKind = null;
      state.pendingStreak = 0;
      return null;
    }

    if (state.pendingKind !== kind) {
      state.pendingKind = kind;
      state.pendingStreak = 1;
      return null;
    }
    state.pendingStreak += 1;
    if (state.pendingStreak < this.terminalRounds) return null;
    if (state.lastSentKind === kind) return null;

    const lastAt = state.lastSentAt.get(kind);
    if (lastAt !== undefined && now - lastAt < this.cooldownMs) return null;

    state.lastSentAt.set(kind, now);
    state.lastSentKind = kind;
    state.armed = false;
    state.busyAnnounced = false;
    state.pendingKind = null;
    state.pendingStreak = 0;
    return kind;
  }

  delete(key) {
    this._states.delete(key);
  }

  prune(liveKeys) {
    for (const key of this._states.keys()) {
      if (!liveKeys.has(key)) this._states.delete(key);
    }
  }
}

export function tmuxPushTargetKey(connectionId, target) {
  return `${connectionId}:${target.projectId}:${target.windowId}:${target.paneId}`;
}

export function tmuxPushDirectory(connectionId, target) {
  return `tmux://${[connectionId, target.projectId, target.windowId, target.paneId]
    .map(value => String(value).replaceAll('/', '%2F'))
    .join('/')}`;
}

export function tmuxActivityDigest(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}
