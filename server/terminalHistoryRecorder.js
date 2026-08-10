import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';

const { Terminal } = headless;
const { SerializeAddon } = serialize;

export const DEFAULT_RECORDER_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_CHECKPOINT_DEBOUNCE_MS = 40;

const CHECKPOINT_BOUNDARY = /\x1b\[\?1049[hl]|\x1b\[\?(?:47|1047)[hl]|\x1b\[2J|\x1b\[3J|\x1b\[H/;

/**
 * Records rendered terminal state, not raw PTY chunks.
 *
 * Raw PTY bytes are written into one headless xterm instance. A visual block
 * is created only from SerializeAddon's current screen serialization. This
 * prevents a later clear-screen/alternate-screen frame from overwriting the
 * meaning of an earlier history block during replay.
 */
export class TerminalHistoryRecorder {
  constructor({
    identity,
    recordingId = identity?.recordingId || randomUUID(),
    maxBytes = DEFAULT_RECORDER_MAX_BYTES,
    complete = false,
    gap = null,
    filePath = null,
    checkpointDebounceMs = DEFAULT_CHECKPOINT_DEBOUNCE_MS,
  }) {
    this.identity = { ...identity, recordingId };
    this.recordingId = recordingId;
    this.maxBytes = maxBytes;
    this.complete = complete;
    this.gaps = gap ? [gap] : [];
    this.blocks = [];
    this.sequence = 0;
    this.resizeEpoch = 0;
    this.cols = 120;
    this.rows = 30;
    this.bytes = 0;
    this.filePath = filePath;
    this.checkpointDebounceMs = checkpointDebounceMs;
    this._dirty = false;
    this._timer = null;
    this._writeQueue = Promise.resolve();
    this._checkpointQueue = Promise.resolve();
    this._terminal = this._newTerminal(this.cols, this.rows);
    this._persist();
  }

  append(
    ansi,
    { cols = this.cols, rows = this.rows, resizeEpoch = this.resizeEpoch } = {},
  ) {
    if (typeof ansi !== 'string' || ansi.length === 0) return this._writeQueue;
    this._writeQueue = this._writeQueue.then(
      async () => {
        if (cols !== this.cols || rows !== this.rows) {
          if (this._timer !== null) {
            clearTimeout(this._timer);
            this._timer = null;
          }
          await this._checkpointQueue;
          if (this._dirty) await this._checkpoint('resize-before-append');
          this._terminal.resize(cols, rows);
          this.cols = cols;
          this.rows = rows;
        }
        await new Promise((resolve, reject) => {
        this._terminal.write(ansi, () => {
          this.resizeEpoch = resizeEpoch;
          this._dirty = true;
          if (CHECKPOINT_BOUNDARY.test(ansi)) {
            this._queueCheckpoint('terminal-boundary');
          } else {
            this._scheduleDebouncedCheckpoint();
          }
          resolve();
        });
        }).catch((error) => {
          this._recordFailure('visual_checkpoint_write_failed', error);
          throw error;
        });
      },
    );
    return this._writeQueue;
  }

  resize({ cols, rows }) {
    if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 1 || rows < 1) {
      return Promise.reject(new Error('invalid recorder resize'));
    }
    this._writeQueue = this._writeQueue.then(async () => {
      await this._checkpointQueue;
      await this._checkpoint('resize-before');
      this._terminal.resize(cols, rows);
      this.cols = cols;
      this.rows = rows;
      this.resizeEpoch += 1;
      this._dirty = true;
      await this._checkpoint('resize-after');
    });
    return this._writeQueue;
  }

  async page({ limit = 400, cursor = null } = {}) {
    await this.flush();
    return paginateHistoryBlocks(this.blocks, {
      limit,
      cursor,
      identity: this.identity,
      complete: this.complete,
      gaps: this.gaps,
    });
  }

  setIdentity(identity) {
    this.identity = { ...identity, recordingId: this.recordingId };
    this._persist();
  }

  invalidate(reason = 'recording_generation_superseded') {
    this.complete = false;
    this._addGap(reason);
    this._persist();
    this.dispose();
  }

  async flush() {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    await this._writeQueue;
    await this._checkpointQueue;
    await this._checkpoint('flush');
  }

  dispose() {
    if (this._timer !== null) clearTimeout(this._timer);
    this._terminal.dispose();
  }

  _newTerminal(cols, rows) {
    const terminal = new Terminal({
      cols,
      rows,
      scrollback: 0,
      allowProposedApi: true,
    });
    const addon = new SerializeAddon();
    terminal.loadAddon(addon);
    terminal.__nexusSerializeAddon = addon;
    return terminal;
  }

  _scheduleDebouncedCheckpoint() {
    if (this._timer !== null) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this._queueCheckpoint('debounced-output');
    }, this.checkpointDebounceMs);
  }

  _queueCheckpoint(reason) {
    this._checkpointQueue = this._checkpointQueue.then(() => this._checkpoint(reason));
    return this._checkpointQueue;
  }

  async _checkpoint(reason) {
    if (!this._dirty) return;
    this._dirty = false;
    const sequence = ++this.sequence;
    try {
      const serialized = this._terminal.__nexusSerializeAddon.serialize();
      if (typeof serialized !== 'string') {
        throw new Error('SerializeAddon returned a non-string checkpoint');
      }
      const ansi = `\x1b[0m${serialized || '\x1b[2J\x1b[H'}\x1b[0m`;
      this._appendBlock({
        sequence,
        ansi,
        cols: this.cols,
        rows: this.rows,
        resizeEpoch: this.resizeEpoch,
        selfContained: true,
        checkpointReason: reason,
      });
    } catch (error) {
      this._recordFailure('visual_checkpoint_serialization_failed', error, sequence, reason);
    }
  }

  _appendBlock(block) {
    const byteLength = Buffer.byteLength(block.ansi, 'utf8');
    if (this.bytes + byteLength > this.maxBytes) {
      this.complete = false;
      this._addGap('recording_byte_budget_exceeded');
      this.blocks.push({
        sequence: block.sequence,
        ansi: '',
        cols: block.cols,
        rows: block.rows,
        resizeEpoch: block.resizeEpoch,
        selfContained: false,
        checkpointReason: 'recording-byte-budget-exceeded',
      });
      this._persist();
      return;
    }
    this.blocks.push({ ...block });
    this.bytes += byteLength;
    this._persist();
  }

  _recordFailure(gap, error, sequence = ++this.sequence, reason = 'failure') {
    this.complete = false;
    this._addGap(gap);
    this.blocks.push({
      sequence,
      ansi: '',
      cols: this.cols,
      rows: this.rows,
      resizeEpoch: this.resizeEpoch,
      selfContained: false,
      checkpointReason: reason,
      error: error?.message || String(error),
    });
    this._persist();
  }

  _addGap(gap) {
    if (!this.gaps.includes(gap)) this.gaps.push(gap);
  }

  _persist() {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    writeFileSync(this.filePath, JSON.stringify({
      identity: this.identity,
      recordingId: this.recordingId,
      complete: this.complete,
      gaps: this.gaps,
      sequence: this.sequence,
      resizeEpoch: this.resizeEpoch,
      cols: this.cols,
      rows: this.rows,
      blocks: this.blocks,
    }), { encoding: 'utf8', mode: 0o600 });
  }
}

export function paginateHistoryBlocks(
  blocks,
  { limit = 400, cursor = null, identity, complete = true, gaps = [] } = {},
) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid history page limit');
  const endExclusive = cursor === null ? blocks.length : cursor;
  if (!Number.isSafeInteger(endExclusive) || endExclusive < 0 || endExclusive > blocks.length) {
    throw new Error('invalid history cursor');
  }
  const start = Math.max(0, endExclusive - limit);
  const pageBlocks = blocks.slice(start, endExclusive).map((block) => ({ ...block }));
  return {
    identity,
    complete,
    gaps: [...gaps],
    blocks: pageBlocks,
    earliestSequence: blocks.length ? blocks[0].sequence : null,
    latestSequence: blocks.length ? blocks[blocks.length - 1].sequence : null,
    pageEarliestSequence: pageBlocks.length ? pageBlocks[0].sequence : null,
    pageLatestSequence: pageBlocks.length ? pageBlocks[pageBlocks.length - 1].sequence : null,
    olderCursor: start > 0 ? start : null,
  };
}
