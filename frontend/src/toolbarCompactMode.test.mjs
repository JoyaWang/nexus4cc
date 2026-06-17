import test from 'node:test'
import assert from 'node:assert/strict'
import { getToolbarMode } from './toolbarCompactMode.mjs'

test('uses compact toolbar when mobile keyboard is visible', () => {
  assert.equal(getToolbarMode({ isPC: false, keyboardVisible: true }), 'keyboard-compact')
})
