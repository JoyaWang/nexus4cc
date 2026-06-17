import test from 'node:test'
import assert from 'node:assert/strict'
import { detectKeyboardVisible } from './viewportKeyboard.ts'

test('detects iOS keyboard by viewport delta instead of 80 percent threshold', () => {
  assert.equal(detectKeyboardVisible({ isTouch: true, viewportHeight: 600, maxViewportHeight: 800 }), true)
})

test('does not mark desktop resize as keyboard', () => {
  assert.equal(detectKeyboardVisible({ isTouch: false, viewportHeight: 600, maxViewportHeight: 800 }), false)
})
