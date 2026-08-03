import test from 'node:test';
import assert from 'node:assert/strict';

import { readOpenCodeHistory } from '../server/opencodeHistory.js';

// 只测参数校验与错误路径（不依赖真实 OpenCode DB）：
// 真实 DB 集成由 E2E 覆盖（NEXUS_OPENCODE_HISTORY 输出行数）。
test('readOpenCodeHistory requires directory and title', () => {
  assert.throws(() => readOpenCodeHistory({ title: 'x' }), /directory/);
  assert.throws(() => readOpenCodeHistory({ directory: 'x' }), /title/);
});

test('readOpenCodeHistory returns session_not_found for unknown directory', () => {
  const result = readOpenCodeHistory({
    directory: '/nonexistent/joya-dir-xyz',
    title: 'unknown title',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'session_not_found');
  assert.deepEqual(result.lines, []);
});
