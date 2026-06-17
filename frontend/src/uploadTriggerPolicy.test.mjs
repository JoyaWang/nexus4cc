import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldUseNativeFileLabel } from './uploadTriggerPolicy.ts'

test('uses native label for touch file upload triggers', () => {
  assert.equal(shouldUseNativeFileLabel({ isTouch: true }), true)
})
