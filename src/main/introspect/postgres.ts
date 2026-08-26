import type { Catalog, ColumnMeta, ForeignKey, IndexMeta, SchemaMeta, TableKind, TableMeta } from '@shared/ipc'
import type { PgConnection } from '../drivers/postgres'

const SYSTEM_SCHEMAS = `('pg_catalog','information_schema')`
const NOT_TEMP = `n.nspname NOT LIKE 'pg\\_%' AND n.nspname NOT IN ${SYSTEM_SCHEMAS}`

const RELKIND: Record<string, TableKind> = {
  r: 'table',
  p: 'partitioned',
  v: 'view',
  m: 'matview',
  f: 'foreign'
}

/**
 * One snapshot pass, four queries, assembled in JS. For a schema this size
 * (136 tables) this is far faster than lazy per-node loading, and it makes
 * completion instant because the whole catalog is already in memory.
 */
export async function introspect(conn: PgConnection): Promise<Catalog> {
  const [relations, columns, constraints, indexes, dbRows] = await Promise.all([
    conn.query(`
      SELECT c.oid, n.nspname AS schema, c.relname AS name, c.relkind,
             obj_description(c.oid, 'pg_class') AS comment,
             CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS row_estimate
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','p','v','m','f') AND ${NOT_TEMP}
       ORDER BY n.nspname, c.relname`),
    conn.query(`
      SELECT a.attrelid AS oid, a.attname AS name, a.attnum AS ordinal,
             format_type(a.atttypid, a.atttypmod) AS data_type,
             NOT a.attnotnull AS nullable,
             pg_get_expr(d.adbin, d.adrelid) AS default_value,
             col_description(a.attrelid, a.attnum) AS comment
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attnum > 0 AND NOT a.attisdropped
         AND c.relkind IN ('r','p','v','m','f') AND ${NOT_TEMP}
       ORDER BY a.attrelid, a.attnum`),
    conn.query(`
      SELECT con.conrelid AS oid, con.conname AS name, con.contype,
             con.conkey, con.confkey,
             fn.nspname AS ref_schema, fc.relname AS ref_table, con.confrelid AS ref_oid
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_class fc ON fc.oid = con.confrelid
        LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
       WHERE con.contype IN ('p','f') AND ${NOT_TEMP}`),
    conn.query(`
      SELECT i.indrelid AS oid, ic.relname AS name, i.indisunique AS unique,
             i.indisprimary AS primary, i.indkey::text AS keys
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indrelid
        JOIN pg_class ic ON ic.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE ${NOT_TEMP}`),
    conn.query('SELECT current_database() AS db')
  ])

  // attnum -> column name, per relation, so constraints can name their columns.
  const colsByOid = new Map<number, ColumnMeta[]>()
  const nameByAttnum = new Map<number, Map<number, string>>()
  for (const r of columns) {
    const oid = Number(r.oid)
    const col: ColumnMeta = {
      name: String(r.name),
      dataType: String(r.data_type),
      nullable: Boolean(r.nullable),
      defaultValue: r.default_value === null ? null : String(r.default_value),
      isPrimaryKey: false,
      ordinal: Number(r.ordinal),
      comment: r.comment === null ? null : String(r.comment)
    }
    if (!colsByOid.has(oid)) colsByOid.set(oid, [])
    colsByOid.get(oid)!.push(col)
    if (!nameByAttnum.has(oid)) nameByAttnum.set(oid, new Map())
    nameByAttnum.get(oid)!.set(col.ordinal, col.name)
  }

  const resolve = (oid: number, keys: unknown): string[] => {
    const map = nameByAttnum.get(oid)
    if (!map || !Array.isArray(keys)) return []
    return (keys as number[]).map((k) => map.get(Number(k))).filter((n): n is string => !!n)
  }

  const pkByOid = new Map<number, string[]>()
  const fksByOid = new Map<number, ForeignKey[]>()
  for (const r of constraints) {
    const oid = Number(r.oid)
    if (r.contype === 'p') {
      pkByOid.set(oid, resolve(oid, r.conkey))
    } else {
      const refOid = Number(r.ref_oid)
      const fk: ForeignKey = {
        name: String(r.name),
        columns: resolve(oid, r.conkey),
        refSchema: String(r.ref_schema ?? ''),
        refTable: String(r.ref_table ?? ''),
        refColumns: resolve(refOid, r.confkey)
      }
      if (!fksByOid.has(oid)) fksByOid.set(oid, [])
      fksByOid.get(oid)!.push(fk)
    }
  }

  const idxByOid = new Map<number, IndexMeta[]>()
  for (const r of indexes) {
    const oid = Number(r.oid)
    // indkey is a space-separated int2vector; 0 marks an expression column.
    const attnums = String(r.keys).trim().split(/\s+/).map(Number).filter((n) => n > 0)
    const idx: IndexMeta = {
      name: String(r.name),
      columns: resolve(oid, attnums),
      unique: Boolean(r.unique),
      primary: Boolean(r.primary)
    }
    if (!idxByOid.has(oid)) idxByOid.set(oid, [])
    idxByOid.get(oid)!.push(idx)
  }

  const bySchema = new Map<string, TableMeta[]>()
  for (const r of relations) {
    const oid = Number(r.oid)
    const pk = pkByOid.get(oid) ?? []
    const cols = colsByOid.get(oid) ?? []
    for (const c of cols) c.isPrimaryKey = pk.includes(c.name)
    const table: TableMeta = {
      schema: String(r.schema),
      name: String(r.name),
      kind: RELKIND[String(r.relkind)] ?? 'table',
      comment: r.comment === null ? null : String(r.comment),
      columns: cols,
      primaryKey: pk,
      foreignKeys: fksByOid.get(oid) ?? [],
      indexes: idxByOid.get(oid) ?? [],
      rowEstimate: r.row_estimate === null ? null : Number(r.row_estimate)
    }
    if (!bySchema.has(table.schema)) bySchema.set(table.schema, [])
    bySchema.get(table.schema)!.push(table)
  }

  const schemas: SchemaMeta[] = [...bySchema.entries()]
    .map(([name, tables]) => ({ name, tables }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return {
    connectionId: conn.config.id,
    database: String(dbRows[0]?.db ?? conn.config.database ?? ''),
    schemas,
    fetchedAt: Date.now()
  }
}
