const ESC = '\x1b';
const BEL = '\x07';
const STRING_CONTROL_INTRODUCERS = new Set(['P', '_', 'X', '^']);

function readAnsiToken(value, start) {
  if (value[start] !== ESC) return null;
  const next = value[start + 1];
  if (next === '[') {
    let end = start + 2;
    while (end < value.length && !/[\x40-\x7e]/.test(value[end])) end++;
    if (end === value.length) return { end, value: value.slice(start), ansi: true, complete: false };
    return { end: end + 1, value: value.slice(start, end + 1), ansi: true, complete: true };
  }
  if (next === ']') {
    let end = start + 2;
    while (end < value.length) {
      if (value[end] === BEL) return { end: end + 1, value: value.slice(start, end + 1), ansi: true, complete: true };
      if (value[end] === ESC && value[end + 1] === '\\') {
        return { end: end + 2, value: value.slice(start, end + 2), ansi: true, complete: true };
      }
      end++;
    }
    return { end: value.length, value: value.slice(start), ansi: true, complete: false };
  }
  if (STRING_CONTROL_INTRODUCERS.has(next)) {
    let end = start + 2;
    while (end < value.length) {
      if (value[end] === ESC && value[end + 1] === '\\') {
        return { end: end + 2, value: value.slice(start, end + 2), ansi: true, complete: true };
      }
      end++;
    }
    return { end: value.length, value: value.slice(start), ansi: true, complete: false };
  }
  return next === undefined
    ? { end: value.length, value: ESC, ansi: true, complete: false }
    : { end: start + 2, value: value.slice(start, start + 2), ansi: true, complete: true };
}

function tokenizeAnsi(value) {
  const tokens = [];
  let index = 0;
  let textStart = 0;
  while (index < value.length) {
    if (value[index] !== ESC) {
      index++;
      continue;
    }
    if (textStart < index) tokens.push({ value: value.slice(textStart, index), ansi: false });
    const token = readAnsiToken(value, index);
    tokens.push(token);
    index = token.end;
    textStart = index;
  }
  if (textStart < value.length) tokens.push({ value: value.slice(textStart), ansi: false });
  return tokens;
}

function takeTextSuffix(value, maxBytes) {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let result = '';
  for (const char of Array.from(value).reverse()) {
    const candidate = char + result;
    if (Buffer.byteLength(candidate, 'utf8') > maxBytes) break;
    result = candidate;
  }
  return result;
}

// Keep the suffix bounded without ever cutting an ANSI control token in half.
function boundedAnsiOutput(value, maxBytes, keepIncompleteAnsi) {
  const input = String(value ?? '');
  const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 2000;
  if (!input || limit === 0) return '';

  const selected = [];
  let remaining = limit;
  for (const token of tokenizeAnsi(input).reverse()) {
    if (token.ansi && !token.complete) {
      if (!keepIncompleteAnsi) continue;
      const incompleteSize = Buffer.byteLength(token.value, 'utf8');
      // An unterminated control string can be arbitrarily large. Never let a malformed
      // control token defeat the cache byte bound; dropping it is safer than
      // retaining a suffix that no longer contains the opening ESC byte.
      if (incompleteSize > remaining) return '';
      selected.unshift(token.value);
      remaining -= incompleteSize;
      continue;
    }
    const size = Buffer.byteLength(token.value, 'utf8');
    if (size <= remaining) {
      selected.unshift(token.value);
      remaining -= size;
      continue;
    }
    if (!token.ansi && remaining > 0) selected.unshift(takeTextSuffix(token.value, remaining));
    break;
  }
  return selected.join('');
}

// Send only complete ANSI tokens. Incomplete trailing control sequences are
// omitted rather than being interpreted as terminal commands by the client.
export function safeAnsiSuffix(value, maxBytes = 2000) {
  return boundedAnsiOutput(value, maxBytes, false);
}

// Keep incomplete trailing tokens in the server cache so a later PTY chunk can
// complete them before the cache is sent through safeAnsiSuffix().
export function boundAnsiOutput(value, maxBytes = 10000) {
  return boundedAnsiOutput(value, maxBytes, true);
}

export function appendAnsiOutput(existing, incoming, maxBytes = 10000) {
  return boundAnsiOutput(`${existing ?? ''}${incoming ?? ''}`, maxBytes);
}

const ALT_SCREEN_MODES = new Set(['47', '1047', '1049']);

// Track persistent alternate-screen mode without replaying the cached terminal
// bytes. The short scan tail lets a CSI private-mode sequence span PTY chunks.
export function updateAlternateScreenState(
  alternateScreen,
  previousTail,
  incoming,
) {
  const combined = `${previousTail ?? ''}${incoming ?? ''}`;
  const pattern = /\x1b\[\?([0-9;]*)([hl])/g;
  let nextState = Boolean(alternateScreen);
  for (const match of combined.matchAll(pattern)) {
    const modes = match[1].split(';');
    if (modes.some(mode => ALT_SCREEN_MODES.has(mode))) {
      nextState = match[2] === 'h';
    }
  }
  return {
    alternateScreen: nextState,
    scanTail: combined.slice(-64),
  };
}

// A first active client receives only mode state + a clean canvas. The resize
// nudge that follows supplies the authoritative pane pixels at the new size.
export function terminalModeSync(alternateScreen) {
  return `\x1b[?1049${alternateScreen ? 'h' : 'l'}\x1b[2J\x1b[H`;
}
