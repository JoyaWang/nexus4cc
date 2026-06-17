import test from 'node:test'
import assert from 'node:assert/strict'
import { scrollbackKey, shouldRetainScrollbackCacheOnClose } from './scrollbackCachePolicy.ts'

test('keys scrollback cache by tmux session and window', () => {
  assert.equal(scrollbackKey('meta', 3), 'meta:3')
})

test('retains scrollback cache when overlay closes', () => {
  assert.equal(shouldRetainScrollbackCacheOnClose(), true)
})
