import type { Cell, CellEdit, EditTarget, GridEdits, NewRow, PendingChange } from '@shared/ipc'

const ident = (s: string): string => '"' + s.replace(/"/g, '""') + '"'

const qualified = (t: EditTarget): string => `${ident(t.schema)}.${ident(t.table)}`

/**
 * Turns staged grid edits into parameterised statements. Values are never
 * interpolated into SQL — Postgres infers each parameter's type from the target
 * column, so display strings round-trip correctly.
 *
 * Order matters: inserts, then updates, then deletes. Deleting last means a row
 * edited and then deleted in the same batch still resolves cleanly.
 */
export function buildChanges(
  target: EditTarget,
  rows: Cell[][],
  edits: GridEdits
): PendingChange[] {
  // Updating a row that is also being deleted is pointless, and if the update
  // touched the primary key the delete would then match nothing.
  const doomed = new Set(edits.deletes)
  const updates = edits.updates.filter((u) => !doomed.has(u.rowIndex))

  return [
    ...buildInserts(target, edits.inserts),
    ...buildUpdates(target, rows, updates),
    ...buildDeletes(target, rows, edits.deletes)
  ]
}

/** Result column index for each primary key column, so a row can be addressed. */
function pkIndexes(target: EditTarget): number[] {
  return target.pkColumns.map((pk) => {
    const hit = Object.entries(target.columnMap).find(([, name]) => name === pk)
    if (!hit) throw new Error(`Primary key column ${pk} is not in the result set`)
    return Number(hit[0])
  })
}

function whereByPk(
  target: EditTarget,
  row: Cell[],
  indexes: number[],
  params: Cell[]
): string {
  return target.pkColumns
    .map((pk, i) => {
      const value = row[indexes[i]]
      if (value === null) throw new Error(`Cannot address row: ${pk} is NULL`)
      params.push(value)
      return `${ident(pk)} = $${params.length}`
    })
    .join(' AND ')
}

export function buildUpdates(
  target: EditTarget,
  rows: Cell[][],
  edits: CellEdit[]
): PendingChange[] {
  // Keep only the latest edit per cell; re-editing a cell must not emit two SETs.
  const latest = new Map<string, CellEdit>()
  for (const e of edits) latest.set(`${e.rowIndex}:${e.columnIndex}`, e)

  const byRow = new Map<number, CellEdit[]>()
  for (const e of latest.values()) {
    if (!byRow.has(e.rowIndex)) byRow.set(e.rowIndex, [])
    byRow.get(e.rowIndex)!.push(e)
  }

  const indexes = pkIndexes(target)
  const changes: PendingChange[] = []
  for (const [rowIndex, rowEdits] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
    const row = rows[rowIndex]
    if (!row) continue

    const params: Cell[] = []
    const sets = rowEdits
      .sort((a, b) => a.columnIndex - b.columnIndex)
      .map((e) => {
        const col = target.columnMap[e.columnIndex]
        if (!col) throw new Error('Edited column has no source column')
        params.push(e.newValue)
        return `${ident(col)} = $${params.length}`
      })

    const where = whereByPk(target, row, indexes, params)
    changes.push({
      sql: `UPDATE ${qualified(target)} SET ${sets.join(', ')} WHERE ${where}`,
      params,
      kind: 'update',
      rowIndex
    })
  }
  return changes
}

export function buildInserts(target: EditTarget, inserts: NewRow[]): PendingChange[] {
  return inserts.map((row, i) => {
    const cols: string[] = []
    const params: Cell[] = []
    const placeholders: string[] = []

    for (const [idx, value] of Object.entries(row.values)) {
      const col = target.columnMap[Number(idx)]
      // Only absent keys are "untouched" — those keep column defaults and
      // sequences. A present key holding null is an explicit NULL and must be
      // written, or a column with a default would silently receive the default
      // instead of the NULL the user asked for.
      if (!col) continue
      cols.push(ident(col))
      params.push(value)
      placeholders.push(`$${params.length}`)
    }

    const sql = cols.length
      ? `INSERT INTO ${qualified(target)} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`
      : `INSERT INTO ${qualified(target)} DEFAULT VALUES`
    return { sql, params, kind: 'insert' as const, rowIndex: i }
  })
}

export function buildDeletes(
  target: EditTarget,
  rows: Cell[][],
  deletes: number[]
): PendingChange[] {
  const indexes = pkIndexes(target)
  return [...deletes]
    .sort((a, b) => a - b)
    .filter((rowIndex) => !!rows[rowIndex])
    .map((rowIndex) => {
      const params: Cell[] = []
      const where = whereByPk(target, rows[rowIndex], indexes, params)
      return {
        sql: `DELETE FROM ${qualified(target)} WHERE ${where}`,
        params,
        kind: 'delete' as const,
        rowIndex
      }
    })
}

/**
 * Human-readable preview shown in the staged-changes panel before submit.
 *
 * Scans rather than regex-replaces: a blanket sweep rewrites `$1` inside a
 * quoted identifier such as "a$1", so the panel would show SQL that is not what
 * is about to run.
 */
export function renderPreview(change: PendingChange): string {
  const sql = change.sql
  let out = ''
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    if (c === '"' || c === "'") {
      const end = skipQuotedRun(sql, i, c)
      out += sql.slice(i, end)
      i = end
      continue
    }
    if (c === '$' && /\d/.test(sql[i + 1] ?? '')) {
      let j = i + 1
      while (j < sql.length && /\d/.test(sql[j])) j++
      const p = change.params[Number(sql.slice(i + 1, j)) - 1]
      out += p === null || p === undefined ? 'NULL' : `'${String(p).replace(/'/g, "''")}'`
      i = j
      continue
    }
    out += c
    i++
  }
  return out
}

function skipQuotedRun(sql: string, start: number, quote: string): number {
  let i = start + 1
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) { i += 2; continue }
      return i + 1
    }
    i++
  }
  return sql.length
}
