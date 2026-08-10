import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isOpenCodeSessionId } from './openCodeProcessBinding.js';

export class OpenCodeBindingRegistry {
  constructor({ filePath = null } = {}) {
    this.filePath = filePath;
    this.bindings = new Map();
    this._load();
  }

  register({ tmuxSession, windowId, paneId, openCodeSessionId }) {
    if (!tmuxSession || !windowId || !paneId || !isOpenCodeSessionId(openCodeSessionId)) {
      throw new Error('OPENCODE_BINDING_REQUIRED');
    }
    const binding = {
      tmuxSession,
      windowId,
      paneId,
      openCodeSessionId,
    };
    this.bindings.set(bindingKey(binding), binding);
    this._persist();
    return { ...binding };
  }

  get(target) {
    const binding = this.bindings.get(bindingKey(target));
    return binding ? { ...binding } : null;
  }

  remove(target) {
    const key = bindingKey(target);
    const removed = this.bindings.delete(key);
    if (removed) this._persist();
    return removed;
  }

  _load() {
    if (!this.filePath) return;
    try {
      const values = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (!Array.isArray(values)) throw new Error('binding registry must be an array');
      for (const value of values) {
        if (value && value.tmuxSession && value.windowId && value.paneId
          && isOpenCodeSessionId(value.openCodeSessionId)) {
          this.bindings.set(bindingKey(value), { ...value });
        }
      }
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw new Error(`OpenCode binding registry unavailable: ${error.message}`);
    }
  }

  _persist() {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${this.filePath}.tmp`;
    writeFileSync(tempPath, JSON.stringify([...this.bindings.values()], null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(tempPath, this.filePath);
  }
}

export function requireOpenCodeBinding(registry, target) {
  const binding = registry?.get(target);
  if (!binding?.openCodeSessionId) throw new Error('OPENCODE_BINDING_REQUIRED');
  return binding.openCodeSessionId;
}

function bindingKey(value) {
  return `${value?.tmuxSession}\0${value?.windowId}\0${value?.paneId}`;
}
