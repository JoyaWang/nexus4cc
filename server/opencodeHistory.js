import { DatabaseSync } from 'node:sqlite';

const OPENCODE_DB_PATH = `${process.env.HOME}/.local/share/opencode/opencode.db`;

// 从 OpenCode SQLite 读指定会话的全量对话历史（纯文本，按时间排序）。
// 用于 alternate-screen TUI 的历史展示：tmux scrollback 只有 1 行，
// 完整对话在 OpenCode 自己的存储里。
export function readOpenCodeHistory({ directory, title }) {
  if (!directory || !title) {
    throw new Error('directory and title are required');
  }

  const db = openDb();

  try {
    // 找会话：directory + title 匹配
    const session = db.prepare(`
      SELECT id FROM session
      WHERE directory = ? AND title = ?
      ORDER BY time_updated DESC
      LIMIT 1
    `).get(directory, title);

    if (!session) {
      return { ok: false, error: 'session_not_found', lines: [] };
    }

    return readSessionParts(db, session.id);
  } finally {
    db.close();
  }
}

// Fallback：精确匹配（directory + title）失败时，取该 directory 下最近更新的会话。
// 用于 paneTitle/windowName 均与 SQLite title 不一致的边缘场景。
export function readLatestOpenCodeHistory({ directory }) {
  if (!directory) {
    throw new Error('directory is required');
  }

  const db = openDb();

  try {
    const session = db.prepare(`
      SELECT id FROM session
      WHERE directory = ?
      ORDER BY time_updated DESC
      LIMIT 1
    `).get(directory);

    if (!session) {
      return { ok: false, error: 'session_not_found', lines: [] };
    }

    return readSessionParts(db, session.id);
  } finally {
    db.close();
  }
}

function openDb() {
  try {
    return new DatabaseSync(OPENCODE_DB_PATH, { readOnly: true });
  } catch (error) {
    throw new Error(`OpenCode database unavailable: ${error.message}`);
  }
}

function readSessionParts(db, sessionId) {
  // 读该会话的所有 text part（按时间排序）
  const parts = db.prepare(`
    SELECT json_extract(data, '$.text') AS text, time_created
    FROM part
    WHERE session_id = ? AND json_extract(data, '$.type') = 'text'
    ORDER BY time_created ASC
  `).all(sessionId);

  // 拼成行（每个 part 按 \n 拆行，保留原始格式）
  const lines = [];
  for (const part of parts) {
    const text = part.text;
    if (!text) continue;
    const partLines = text.split('\n');
    for (const line of partLines) {
      lines.push(line);
    }
    // part 之间空一行分隔
    lines.push('');
  }

  return { ok: true, lines, sessionId };
}
