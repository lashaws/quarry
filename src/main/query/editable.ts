import type { Catalog, EditTarget } from '@shared/ipc'
import { countTableReferences } from '@shared/sql'

export interface SourceInfo {
  sourceTableOid: number | null
  columnAttnums: Record<number, number>
}

/**
 * DataGrip's rule, applied to the signal Postgres already gives us: a result set
 * is editable only when every real column came from a single base table and that
 * table's whole primary key is present. A join, an aggregate or a view fails this
 * and stays read-only.
 */
export function resolveEditTarget(
  catalog: Catalog | null,
  locate: (oid: number) => { schema: string; table: string } | undefined,
  info: SourceInfo,
  sql?: string
): EditTarget | null {
  if (!catalog || info.sourceTableOid == null) return null

  // A self-join reports one oid for every alias, so the oid check alone would
  // call it editable — and an UPDATE addressed by one alias's primary key would
  // write to the wrong row. Require exactly one table reference.
  if (sql !== undefined && countTableReferences(sql) > 1) return null

  const loc = locate(info.sourceTableOid)
  if (!loc) return null

  const meta = catalog.schemas
    .find((s) => s.name === loc.schema)
    ?.tables.find((t) => t.name === loc.table)
  // Views and partitioned parents are excluded: there is no single row to address.
  if (!meta || meta.kind !== 'table' || meta.primaryKey.length === 0) return null

  const byAttnum = new Map(meta.columns.map((c) => [c.ordinal, c.name]))
  const columnMap: Record<number, string> = {}
  for (const [idx, attnum] of Object.entries(info.columnAttnums)) {
    const name = byAttnum.get(Number(attnum))
    if (name) columnMap[Number(idx)] = name
  }

  // The same source column appearing twice means the table is referenced more
  // than once (or a column is selected twice); an edit would be ambiguous.
  const mapped = Object.values(columnMap)
  if (new Set(mapped).size !== mapped.length) return null

  const present = new Set(mapped)
  if (!meta.primaryKey.every((pk) => present.has(pk))) return null

  return { schema: loc.schema, table: loc.table, pkColumns: meta.primaryKey, columnMap }
}
