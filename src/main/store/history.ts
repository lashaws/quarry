import { DatabaseSync } from 'node:sqlite'
import type { HistoryEntry } from '@shared/ipc'
import { filePath } from './paths'

let db: DatabaseSync | null = null

/** Uses Node 24's built-in node:sqlite — no native module, no Electron rebuild. */
function handle(): DatabaseSync {
  if (db) return db
  db = new DatabaseSync(filePath('history.db'))
  db.exec(`
    CREATE TABLE IF NOT EXISTS history (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      connection_id  TEXT NOT NULL,
      connection_name TEXT NOT NULL,
      sql            TEXT NOT NULL,
      started_at     INTEGER NOT NULL,
      duration_ms    INTEGER NOT NULL,
      row_count      INTEGER,
      error          TEXT
    );
    CREATE INDEX IF NOT EXISTS history_started_at ON history(started_at DESC);
    CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(
      sql, content='history', content_rowid='id', tokenize='porter unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS history_ai AFTER INSERT ON history BEGIN
      INSERT INTO history_fts(rowid, sql) VALUES (new.id, new.sql);
    END;
  `)
  return db
}

export function record(e: Omit<HistoryEntry, 'id'>): void {
  const stmt = handle().prepare(
    `INSERT INTO history (connection_id, connection_name, sql, started_at, duration_ms, row_count, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  stmt.run(e.connectionId, e.connectionName, e.sql, e.startedAt, e.durationMs, e.rowCount, e.error)
}

export function search(term: string, limit = 200): HistoryEntry[] {
  const h = handle()
  const rows = term.trim()
    ? h
        .prepare(
          `SELECT h.* FROM history_fts f JOIN history h ON h.id = f.rowid
           WHERE history_fts MATCH ? ORDER BY h.started_at DESC LIMIT ?`
        )
        .all(ftsQuery(term), limit)
    : h.prepare(`SELECT * FROM history ORDER BY started_at DESC LIMIT ?`).all(limit)

  return (rows as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id),
    connectionId: String(r.connection_id),
    connectionName: String(r.connection_name),
    sql: String(r.sql),
    startedAt: Number(r.started_at),
    durationMs: Number(r.duration_ms),
    rowCount: r.row_count === null ? null : Number(r.row_count),
    error: r.error === null ? null : String(r.error)
  }))
}

/** FTS5 chokes on bare punctuation; quote each term and prefix-match the last. */
function ftsQuery(term: string): string {
  const parts = term.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"`)
  if (!parts.length) return '""'
  parts[parts.length - 1] += '*'
  return parts.join(' ')
}
