import { createHash } from 'node:crypto';

export const NEXUS_LINKED_SESSION_PREFIX = '__nexus_ws_';

export function isNexusLinkedSession(name) {
  return String(name || '').startsWith(NEXUS_LINKED_SESSION_PREFIX);
}

export function linkedSessionName(sourceSession, windowId) {
  const digest = createHash('sha256')
    .update(`${sourceSession}\0${windowId}`)
    .digest('hex')
    .slice(0, 20);
  return `${NEXUS_LINKED_SESSION_PREFIX}${digest}`;
}

export function parseWindowIndex(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return { ok: false, reason: 'missing_window' };
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    return { ok: false, reason: 'invalid_window' };
  }
  return { ok: true, value };
}

export function summarizeTerminalInput(value) {
  const buffer = Buffer.from(String(value), 'utf8');
  const first = buffer[0];
  const isControl = first === 0x1b || first < 0x20 || first === 0x7f;
  let kind = 'text';
  if (first === 0x1b) {
    const ascii = buffer.subarray(0, 32).toString('latin1');
    if (/^\x1b\[<\d+;\d+;\d+[mM]/.test(ascii)) kind = 'mouse_sgr';
    else if (/^\x1b\[M/.test(ascii)) kind = 'mouse_x10';
    else if (/^\x1b\[[ABCD]/.test(ascii)) kind = 'arrow';
    else kind = 'escape';
  } else if (isControl) {
    kind = 'control';
  }
  return {
    byteLength: buffer.length,
    kind,
    hex: isControl ? buffer.subarray(0, 32).toString('hex') : null,
  };
}
