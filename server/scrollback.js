import { randomUUID } from 'node:crypto';
import { execFile as defaultExecFile } from 'node:child_process';

export const DEFAULT_SCROLLBACK_TTL_MS = 10 * 60_000;
export const DEFAULT_SCROLLBACK_MAX_SNAPSHOTS = 12;
export const DEFAULT_SCROLLBACK_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_PAGE_LIMIT = 400;
export const DEFAULT_LEGACY_CAPTURE_LINES = 3_000;
export const MAX_PAGE_LIMIT = 1_000;
export const MAX_LEGACY_CAPTURE_LINES = 10_000;
export const FULL_HISTORY_CAPTURE_START = '-';

export function splitLogicalLines(content) {
  const value = String(content ?? '');
  if (!value) return [];
  return (value.endsWith('\n') ? value.slice(0, -1) : value).split('\n');
}

function parseInteger(value, defaultValue = null) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function validateSnapshot(snapshot) {
  if (snapshot === undefined) return null;
  if (typeof snapshot !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(snapshot)) return false;
  return snapshot;
}

function sameTargetIdentity(left, right) {
  return Boolean(left && right)
    && left.session === right.session
    && left.windowIndex === right.windowIndex
    && left.windowId === right.windowId
    && left.paneId === right.paneId;
}

export function parseScrollbackParams({ session, windowIndex, lines, limit, offset, snapshot }) {
  if (typeof session !== 'string' || !session || session.length > 128 || /[\u0000-\u001f\u007f:]/.test(session)) {
    return { ok: false, error: 'invalid scrollback session' };
  }
  if (!Number.isSafeInteger(windowIndex) || windowIndex < 0) {
    return { ok: false, error: 'invalid scrollback window' };
  }

  const hasPaginationParams = limit !== undefined || offset !== undefined || snapshot !== undefined;
  if (lines !== undefined && hasPaginationParams) {
    return { ok: false, error: 'ambiguous scrollback pagination mode' };
  }
  const isLegacy = !hasPaginationParams;
  if (isLegacy) {
    const parsedLines = parseInteger(lines, DEFAULT_LEGACY_CAPTURE_LINES);
    const parsedOffset = parseInteger(offset, 0);
    const parsedSnapshot = validateSnapshot(snapshot);
    if (parsedLines === null || parsedLines < 1) return { ok: false, error: 'invalid scrollback lines' };
    if (parsedOffset === null || parsedOffset !== 0) return { ok: false, error: 'invalid scrollback offset' };
    if (parsedSnapshot === false || parsedSnapshot !== null) {
      return { ok: false, error: 'legacy scrollback does not accept snapshots' };
    }
    return {
      ok: true,
      isLegacy: true,
      legacyLines: Math.min(parsedLines, MAX_LEGACY_CAPTURE_LINES),
      limit: null,
      offset: 0,
      snapshot: parsedSnapshot,
    };
  }

  const parsedLimit = parseInteger(limit, DEFAULT_PAGE_LIMIT);
  const parsedOffset = parseInteger(offset, 0);
  const parsedSnapshot = validateSnapshot(snapshot);
  if (parsedLimit === null || parsedLimit < 1 || parsedLimit > MAX_PAGE_LIMIT) {
    return { ok: false, error: 'invalid scrollback limit' };
  }
  if (parsedOffset === null) return { ok: false, error: 'invalid scrollback offset' };
  if (parsedSnapshot === false) return { ok: false, error: 'invalid scrollback snapshot' };
  return {
    ok: true,
    isLegacy: false,
    limit: parsedLimit,
    offset: parsedOffset,
    snapshot: parsedSnapshot,
  };
}

export function paginateLines(lines, offset, limit) {
  const page = lines.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    content: page.join('\n'),
    offset,
    returnedLines: page.length,
    totalLines: lines.length,
    hasMore: nextOffset < lines.length,
    nextOffset: nextOffset < lines.length ? nextOffset : null,
  };
}

export class ScrollbackStore {
  constructor({
    ttlMs = DEFAULT_SCROLLBACK_TTL_MS,
    maxSnapshots = DEFAULT_SCROLLBACK_MAX_SNAPSHOTS,
    maxBytes = DEFAULT_SCROLLBACK_MAX_BYTES,
    now = () => Date.now(),
    idFactory = () => randomUUID(),
  } = {}) {
    this.ttlMs = ttlMs;
    this.maxSnapshots = maxSnapshots;
    this.maxBytes = maxBytes;
    this.totalBytes = 0;
    this.now = now;
    this.idFactory = idFactory;
    this.snapshots = new Map();
  }

  create(target, lines) {
    this.prune();
    const snapshotLines = [...lines];
    const byteLength = Buffer.byteLength(snapshotLines.join('\n'), 'utf8');
    if (byteLength > this.maxBytes) {
      throw new Error('scrollback snapshot exceeds byte budget');
    }
    while (
      this.snapshots.size >= this.maxSnapshots
      || (this.totalBytes + byteLength > this.maxBytes && this.snapshots.size > 0)
    ) {
      const oldestId = this.snapshots.keys().next().value;
      const oldest = this.snapshots.get(oldestId);
      this.totalBytes -= oldest?.byteLength || 0;
      this.snapshots.delete(oldestId);
    }
    const snapshotId = this.idFactory();
    const now = this.now();
    const previous = this.snapshots.get(snapshotId);
    if (previous) this.totalBytes -= previous.byteLength || 0;
    this.snapshots.set(snapshotId, {
      snapshotId,
      target: { ...target },
      lines: snapshotLines,
      byteLength,
      createdAt: now,
      lastAccessAt: now,
    });
    this.totalBytes += byteLength;
    return { snapshotId };
  }

  get(snapshotId, target) {
    this.prune();
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) return { ok: false, status: 410, code: 'scrollback_snapshot_expired' };
    if (!sameTargetIdentity(snapshot.target, target)) {
      return { ok: false, status: 409, code: 'scrollback_snapshot_target_mismatch' };
    }
    snapshot.lastAccessAt = this.now();
    return {
      ok: true,
      snapshot: {
        snapshotId: snapshot.snapshotId,
        target: { ...snapshot.target },
        lines: [...snapshot.lines],
      },
    };
  }

  prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [snapshotId, snapshot] of this.snapshots) {
      if (snapshot.lastAccessAt <= cutoff) {
        this.totalBytes -= snapshot.byteLength || 0;
        this.snapshots.delete(snapshotId);
      }
    }
  }
}

export function capturePane({ target, lines, start, execFileFn = defaultExecFile }) {
  const paneTarget = target?.paneId;
  if (!paneTarget) return Promise.reject(new Error('stable pane target required'));
  const captureStart = start ?? (lines === undefined ? FULL_HISTORY_CAPTURE_START : `-${lines}`);
  const options = { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 };
  return new Promise((resolve, reject) => {
    execFileFn('tmux', ['display', '-p', '-t', paneTarget, '#{pane_height}'], options, (displayError, displayOutput) => {
      const paneHeight = Number.parseInt(String(displayOutput ?? '').trim(), 10) || 50;
      if (displayError) return reject(displayError);
      execFileFn('tmux', ['capture-pane', '-e', '-p', '-S', captureStart, '-t', paneTarget], options, (captureError, output) => {
        if (captureError) return reject(captureError);
        resolve({ content: String(output ?? ''), paneHeight });
      });
    });
  });
}

// Remove repeated pane-height frames from full-screen apps without altering line whitespace.
export function dedupScrollback(lines, paneHeight) {
  if (lines.length <= paneHeight * 2) return lines;

  const stripAnsi = value => value.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const scrollbackEnd = lines.length - paneHeight;
  const lineHashes = new Int32Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const value = stripAnsi(lines[i]);
    let hash = 5381;
    for (let j = 0; j < value.length; j++) hash = ((hash << 5) + hash + value.charCodeAt(j)) | 0;
    lineHashes[i] = hash;
  }

  const blockFingerprint = start => {
    let fingerprint = 0;
    for (let i = start; i < start + paneHeight && i < lines.length; i++) {
      fingerprint = (fingerprint * 31 + lineHashes[i]) | 0;
    }
    return fingerprint;
  };

  const seen = new Map();
  const duplicates = [];
  for (let i = 0; i <= scrollbackEnd - paneHeight; i += paneHeight) {
    const fingerprint = blockFingerprint(i);
    if (seen.has(fingerprint)) {
      const previous = seen.get(fingerprint);
      const step = Math.max(1, paneHeight >> 3);
      let match = true;
      for (let j = 0; j < paneHeight; j += step) {
        if (lineHashes[previous + j] !== lineHashes[i + j]) { match = false; break; }
      }
      if (match) duplicates.push(previous);
    }
    seen.set(fingerprint, i);
  }
  if (duplicates.length === 0) return lines;

  const keep = new Uint8Array(lines.length).fill(1);
  for (const start of duplicates) {
    const end = Math.min(start + paneHeight, scrollbackEnd);
    for (let i = start; i < end; i++) keep[i] = 0;
  }
  return lines.filter((_, index) => keep[index]);
}
