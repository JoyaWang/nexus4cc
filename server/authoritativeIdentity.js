const REQUIRED_FIELDS = [
  'serverId',
  'tmuxSession',
  'windowIndex',
  'windowId',
  'paneId',
  'terminalKind',
  'targetGeneration',
  'recordingId',
];

export function buildAuthoritativeIdentity(value) {
  return buildIdentity(value, { requireOpenCodeBinding: true });
}

// A live PTY target is authoritative even when an unmanaged OpenCode process
// was started without `-s/--session`. History lookup must remain fail-closed,
// but the optional history binding must never prevent attaching to the PTY.
export function buildLiveTerminalIdentity(value) {
  return buildIdentity(value, { requireOpenCodeBinding: false });
}

function buildIdentity(value, { requireOpenCodeBinding }) {
  const identity = {
    serverId: value?.serverId,
    tmuxSession: value?.tmuxSession,
    windowIndex: value?.windowIndex,
    windowId: value?.windowId,
    paneId: value?.paneId,
    terminalKind: value?.terminalKind,
    openCodeSessionId: value?.openCodeSessionId ?? null,
    targetGeneration: value?.targetGeneration,
    recordingId: value?.recordingId,
  };
  validateAuthoritativeIdentity(identity);
  if (requireOpenCodeBinding && identity.terminalKind === 'opencode' && !identity.openCodeSessionId) {
    throw new Error('OPENCODE_BINDING_REQUIRED');
  }
  if (identity.terminalKind !== 'opencode' && identity.openCodeSessionId !== null) {
    throw new Error('non-opencode identity cannot carry openCodeSessionId');
  }
  return identity;
}

export function validateAuthoritativeIdentity(identity) {
  for (const field of REQUIRED_FIELDS) {
    if (identity?.[field] === undefined || identity?.[field] === null || identity?.[field] === '') {
      throw new Error(`invalid authoritative identity: ${field} is required`);
    }
  }
  if (!Number.isSafeInteger(identity.windowIndex) || identity.windowIndex < 0) {
    throw new Error('invalid authoritative identity: windowIndex');
  }
  if (!Number.isSafeInteger(identity.targetGeneration) || identity.targetGeneration < 1) {
    throw new Error('invalid authoritative identity: targetGeneration');
  }
  return identity;
}

export function sameAuthoritativeIdentity(left, right) {
  return REQUIRED_FIELDS.every((field) => left?.[field] === right?.[field])
    && (left?.openCodeSessionId ?? null) === (right?.openCodeSessionId ?? null);
}

export function assertExactTargetIdentity(expected, actual) {
  if (!sameAuthoritativeIdentity(expected, actual)) {
    throw new Error('authoritative identity mismatch');
  }
  return true;
}
