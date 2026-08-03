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
    execFileFn('tmux', ['display', '-p', '-t', paneTarget, '#{pane_height}|#{history_limit}'], options, (displayError, displayOutput) => {
      const [heightRaw, historyLimitRaw] = String(displayOutput ?? '').trim().split('|');
      const paneHeight = Number.parseInt(heightRaw, 10) || 50;
      const historyLimit = Number.parseInt(historyLimitRaw, 10) || 0;
      if (displayError) return reject(displayError);
      // tmux 3.5a 会把 `capture-pane -S -` 解析成 `-S -0`（只捕获当前屏幕，不含 scrollback），
      // 所以“全部历史”必须显式展开为 `-S -<history_limit>`；超出历史起点时 tmux 会自动从起点截断，无副作用。
      const effectiveStart = captureStart === FULL_HISTORY_CAPTURE_START
        ? `-${Math.max(historyLimit, 1)}`
        : captureStart;
      execFileFn('tmux', ['capture-pane', '-e', '-p', '-S', effectiveStart, '-t', paneTarget], options, (captureError, output) => {
        if (captureError) return reject(captureError);
        resolve({ content: String(output ?? ''), paneHeight });
      });
    });
  });
}

// capture-pane 的结果末尾总是包含“当前屏幕”的 paneHeight 行（实时终端里已可见）。
// 历史记录里再包含它们会造成内容重复（见 docs/HISTORY_MODE_REDESIGN.md），因此剔除。
// 注意：这也替代了旧 dedupScrollback 的职责——dedup 会把重复日志/滚动帧误删，
// 且 tmux 的 alternate-screen（全屏应用）帧本就不写入 scrollback，删块去重毫无必要。
export function stripCurrentPane(lines, paneHeight) {
  const height = Number.isSafeInteger(paneHeight) && paneHeight > 0 ? paneHeight : 0;
  if (height === 0) return [...lines];
  if (lines.length <= height) return [];
  return lines.slice(0, lines.length - height);
}
