import type { Catalog, TableMeta } from '@shared/ipc'
import { maskLiterals, statementAt } from '@shared/sql'
import { resolveContext, type TableRef } from './context'

/**
 * Expands the `*` in the statement under the caret into its real column list.
 * With several tables in scope the columns are alias-qualified, so the result is
 * still unambiguous.
 */
export function expandStar(
  sql: string,
  offset: number,
  catalog: Catalog | null
): { start: number; end: number; text: string } | null {
  if (!catalog) return null
  const stmt = statementAt(sql, offset)
  if (!stmt) return null

  const masked = maskLiterals(sql)
  // The `*` between SELECT and FROM, not one inside an expression like count(*).
  const selectAt = masked.toLowerCase().indexOf('select', stmt.start)
  if (selectAt === -1 || selectAt >= stmt.end) return null
  const fromAt = findFrom(masked, selectAt, stmt.end)
  const limit = fromAt === -1 ? stmt.end : fromAt

  let star = -1
  for (let i = selectAt + 6; i < limit; i++) {
    if (masked[i] !== '*') continue
    // Skip "count(*)" and friends.
    let j = i - 1
    while (j > selectAt && /\s/.test(masked[j])) j--
    if (masked[j] === '(') continue
    star = i
    break
  }
  if (star === -1) return null

  const ctx = resolveContext(sql, star)
  const visible = ctx.tables
    .map((ref) => ({ ref, meta: findTable(catalog, ref) }))
    .filter((v): v is { ref: TableRef; meta: TableMeta } => !!v.meta)
  if (!visible.length) return null

  const multi = visible.length > 1
  const columns = visible.flatMap((v) =>
    v.meta.columns.map((c) => {
      const name = quote(c.name)
      return multi ? `${quote(v.ref.alias ?? v.meta.name)}.${name}` : name
    })
  )
  if (!columns.length) return null

  return { start: star, end: star + 1, text: columns.join(', ') }
}

/** The FROM that closes this SELECT list, ignoring any inside subqueries. */
function findFrom(masked: string, from: number, end: number): number {
  let depth = 0
  const lower = masked.toLowerCase()
  for (let i = from; i < end; i++) {
    const c = masked[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (depth === 0 && lower.startsWith('from', i) && isBoundary(lower, i, i + 4)) return i
  }
  return -1
}

const isBoundary = (s: string, start: number, end: number): boolean =>
  !/[a-z0-9_$]/.test(s[start - 1] ?? ' ') && !/[a-z0-9_$]/.test(s[end] ?? ' ')

function findTable(catalog: Catalog, ref: TableRef): TableMeta | undefined {
  const schemas = ref.schema
    ? catalog.schemas.filter((s) => s.name.toLowerCase() === ref.schema!.toLowerCase())
    : catalog.schemas
  for (const s of schemas) {
    const t = s.tables.find((x) => x.name.toLowerCase() === ref.table.toLowerCase())
    if (t) return t
  }
  return undefined
}

const quote = (name: string): string =>
  /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`
