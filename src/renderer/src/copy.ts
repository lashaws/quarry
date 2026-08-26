import type { Cell, QueryResult } from '@shared/ipc'

export type CopyFormat = 'csv' | 'json' | 'insert'

/** RFC 4180: quote when the value contains a delimiter, quote or newline. */
const csvCell = (v: Cell): string =>
  v === null ? '' : /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v

const sqlLiteral = (v: Cell): string => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`)

const ident = (s: string): string =>
  /^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`

/**
 * Renders rows for the clipboard. `rows` is what the grid currently shows —
 * the selection when there is one, otherwise everything past the filter.
 */
export function renderCopy(result: QueryResult, rows: Cell[][], format: CopyFormat): string {
  const headers = result.fields.map((f) => f.name)

  if (format === 'csv') {
    return [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n')
  }

  if (format === 'json') {
    return JSON.stringify(
      rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? null]))),
      null,
      2
    )
  }

  // INSERT statements target the source table when the result has one, so the
  // output is runnable rather than merely illustrative.
  const table = result.editable
    ? `${ident(result.editable.schema)}.${ident(result.editable.table)}`
    : 'target_table'
  const cols = headers.map(ident).join(', ')
  return rows
    .map((r) => `INSERT INTO ${table} (${cols}) VALUES (${r.map(sqlLiteral).join(', ')});`)
    .join('\n')
}
