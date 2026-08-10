import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9]+$/;
const OPENCODE_BASENAMES = new Set(['opencode', 'opencode.exe']);
const SHELL_BASENAMES = new Set(['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'ash', 'tcsh', 'csh']);

export function isOpenCodeSessionId(value) {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

export function parseProcessRows(rows) {
  if (Array.isArray(rows)) {
    return rows.map((row) => {
      if (typeof row === 'string') return parseProcessRows(row)[0];
      return normalizeProcessRow(row);
    });
  }
  if (typeof rows !== 'string') throw new Error('PROCESS_ROWS_REQUIRED');
  return rows.split(/\r?\n/).filter(Boolean).map((row) => {
    const match = row.match(/^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/);
    if (!match) throw new Error(`INVALID_PROCESS_ROW: ${row}`);
    return normalizeProcessRow({ pid: match[1], ppid: match[2], command: match[3] });
  });
}

export function readProcessRows() {
  return parseProcessRows(execFileSync('ps', ['-axo', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    stdio: 'pipe',
  }));
}

export function discoverPaneProcess({ panePid, processRows = readProcessRows() }) {
  const rootPid = normalizePid(panePid);
  const rows = parseProcessRows(processRows);
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  if (!byPid.has(rootPid)) throw new Error(`PANE_PROCESS_NOT_FOUND: ${rootPid}`);

  const descendants = collectDescendants(rootPid, rows);
  const candidates = descendants.filter((row) => OPENCODE_BASENAMES.has(commandBasename(row.command)));
  if (candidates.length > 1) {
    throw new Error(`OPENCODE_SESSION_PROCESS_AMBIGUOUS: ${candidates.map((row) => row.pid).join(',')}`);
  }
  if (candidates.length === 1) {
    let openCodeSessionId = null;
    let bindingError = null;
    try {
      openCodeSessionId = parseOpenCodeSessionId(candidates[0].command);
    } catch (error) {
      // `opencode --yolo` is a valid live terminal but has no exact history
      // identity. Preserve that distinction instead of rejecting PTY attach.
      if (error.message !== 'OPENCODE_SESSION_ID_MISSING') throw error;
      bindingError = error.message;
    }
    return {
      terminalKind: 'opencode',
      openCodeSessionId,
      bindingError,
      panePid: rootPid,
      process: { ...candidates[0] },
    };
  }

  const pane = byPid.get(rootPid);
  if (!SHELL_BASENAMES.has(commandBasename(pane.command))) {
    throw new Error(`PANE_PROCESS_NOT_SHELL: ${pane.command}`);
  }
  return {
    terminalKind: 'shell',
    openCodeSessionId: null,
    panePid: rootPid,
    process: { ...pane },
  };
}

export function parseOpenCodeSessionId(command) {
  const tokens = tokenizeCommand(command);
  const ids = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    let value = null;
    if (token === '-s' || token === '--session') {
      value = tokens[index + 1];
      if (value === undefined || value === '') throw new Error('OPENCODE_SESSION_ID_MISSING');
      index += 1;
    } else if (token.startsWith('--session=')) {
      value = token.slice('--session='.length);
      if (!value) throw new Error('OPENCODE_SESSION_ID_MISSING');
    }
    if (value !== null) {
      if (!isOpenCodeSessionId(value)) throw new Error('OPENCODE_SESSION_ID_INVALID');
      ids.push(value);
    }
  }
  if (ids.length === 0) throw new Error('OPENCODE_SESSION_ID_MISSING');
  if (new Set(ids).size > 1) throw new Error('OPENCODE_SESSION_ID_AMBIGUOUS');
  return ids[0];
}

export function tokenizeCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return [];
  const tokens = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+)/g;
  let match;
  while ((match = pattern.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

export function commandBasename(command) {
  const executable = tokenizeCommand(command)[0] || '';
  return basename(executable).replace(/^[-]+/, '').toLowerCase();
}

export function bindingTransition(previousSessionId, nextSessionId) {
  if (previousSessionId === nextSessionId) return { changed: false, preserveRecorder: true, rotateGeneration: false };
  if (previousSessionId === null && nextSessionId !== null) {
    return { changed: true, preserveRecorder: true, rotateGeneration: false };
  }
  return { changed: true, preserveRecorder: false, rotateGeneration: true };
}

export function recordingStartState(terminalKind) {
  if (terminalKind === 'shell') return { complete: true, gap: null };
  if (terminalKind === 'opencode') return { complete: false, gap: 'recording_started_after_target' };
  throw new Error(`UNKNOWN_TERMINAL_KIND: ${terminalKind}`);
}

export function bindingTransitionWithRecordingState(previousSessionId, nextSessionId, terminalKind) {
  const transition = bindingTransition(previousSessionId, nextSessionId);
  return {
    ...transition,
    recordingState: transition.rotateGeneration ? recordingStartState(terminalKind) : null,
  };
}

function normalizeProcessRow(row) {
  const pid = normalizePid(row?.pid);
  const ppid = normalizePpid(row?.ppid);
  if (typeof row?.command !== 'string') throw new Error(`INVALID_PROCESS_ROW: ${pid}`);
  return { pid, ppid, command: row.command.trim() };
}

function normalizePid(value) {
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('PANE_PID_REQUIRED');
  return pid;
}

function normalizePpid(value) {
  const ppid = Number(value);
  if (!Number.isSafeInteger(ppid) || ppid < 0) throw new Error('INVALID_PROCESS_ROW_PPID');
  return ppid;
}

function collectDescendants(rootPid, rows) {
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row);
  }
  const descendants = [];
  const queue = [...(children.get(rootPid) || [])];
  const visited = new Set([rootPid]);
  while (queue.length) {
    const row = queue.shift();
    if (visited.has(row.pid)) continue;
    visited.add(row.pid);
    descendants.push(row);
    queue.push(...(children.get(row.pid) || []));
  }
  return descendants;
}
