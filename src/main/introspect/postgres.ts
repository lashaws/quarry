import type {
  Catalog, ColumnMeta, ForeignKey, IndexMeta, RoutineKind, RoutineMeta, SchemaMeta, SequenceMeta,
  SourceTarget, TableKind, TableMeta, TriggerMeta, TypeMeta
} from '@shared/ipc'
import type { PgConnection } from '../drivers/postgres'

const SYSTEM_SCHEMAS = `('pg_catalog','information_schema')`
const NOT_TEMP = `n.nspname NOT LIKE 'pg\\_%' AND n.nspname NOT IN ${SYSTEM_SCHEMAS}`

/** Objects an extension installed (pgcrypto's functions, say) are noise in the tree. */
const NOT_EXTENSION = (catalog: string, oid: string): string =>
  `NOT EXISTS (SELECT 1 FROM pg_depend dep WHERE dep.classid = '${catalog}'::regclass
                  AND dep.objid = ${oid} AND dep.deptype = 'e')`

const PROKIND: Record<string, RoutineKind> = { f: 'function', p: 'procedure', a: 'aggregate', w: 'window' }
const TYPTYPE: Record<string, TypeMeta['kind']> = { e: 'enum', d: 'domain', c: 'composite', r: 'range' }

const RELKIND: Record<string, TableKind> = {
  r: 'table',
  p: 'partitioned',
  v: 'view',
  m: 'matview',
  f: 'foreign'
}

/**
 * One snapshot pass, a handful of queries, assembled in JS. For a schema this size
 * (136 tables) this is far faster than lazy per-node loading, and it makes
 * completion instant because the whole catalog is already in memory.
 */
export async function introspect(conn: PgConnection): Promise<Catalog> {
  const [relations, columns, constraints, indexes, dbRows, routines, sequences, types, triggers] = await Promise.all([
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
    conn.query('SELECT current_database() AS db'),
    conn.query(`
      SELECT p.oid, n.nspname AS schema, p.proname AS name, p.prokind,
             pg_get_function_identity_arguments(p.oid) AS args,
             CASE WHEN p.prokind = 'p' THEN NULL ELSE pg_get_function_result(p.oid) END AS returns,
             l.lanname AS language, obj_description(p.oid, 'pg_proc') AS comment
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_language l ON l.oid = p.prolang
       WHERE ${NOT_TEMP} AND ${NOT_EXTENSION('pg_proc', 'p.oid')}
       ORDER BY n.nspname, p.proname, args`),
    conn.query(`
      SELECT n.nspname AS schema, c.relname AS name, format_type(s.seqtypid, NULL) AS data_type,
             (SELECT tc.relname || '.' || a.attname
                FROM pg_depend d
                JOIN pg_class tc ON tc.oid = d.refobjid
                JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
               WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                 AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a','i')
               LIMIT 1) AS owned_by
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_sequence s ON s.seqrelid = c.oid
       WHERE c.relkind = 'S' AND ${NOT_TEMP} AND ${NOT_EXTENSION('pg_class', 'c.oid')}
       ORDER BY n.nspname, c.relname`),
    conn.query(`
      SELECT n.nspname AS schema, t.typname AS name, t.typtype,
             CASE t.typtype
               WHEN 'e' THEN (SELECT string_agg(e.enumlabel, ', ' ORDER BY e.enumsortorder)
                                FROM pg_enum e WHERE e.enumtypid = t.oid)
               WHEN 'd' THEN format_type(t.typbasetype, t.typtypmod)
               WHEN 'r' THEN (SELECT format_type(r.rngsubtype, NULL) FROM pg_range r WHERE r.rngtypid = t.oid)
             END AS detail
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        LEFT JOIN pg_class c ON c.oid = t.typrelid
       WHERE ${NOT_TEMP} AND ${NOT_EXTENSION('pg_type', 't.oid')}
         AND (t.typtype IN ('e','d','r') OR (t.typtype = 'c' AND c.relkind = 'c'))
       ORDER BY n.nspname, t.typname`),
    conn.query(`
      SELECT tg.tgrelid AS oid, tg.tgname AS name, tg.tgtype AS type, tg.tgenabled <> 'D' AS enabled
        FROM pg_trigger tg
        JOIN pg_class c ON c.oid = tg.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE NOT tg.tgisinternal AND ${NOT_TEMP}
       ORDER BY tg.tgname`)
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

  const trgByOid = new Map<number, TriggerMeta[]>()
  for (const r of triggers) {
    const oid = Number(r.oid)
    if (!trgByOid.has(oid)) trgByOid.set(oid, [])
    trgByOid.get(oid)!.push({ name: String(r.name), timing: triggerTiming(Number(r.type)), enabled: Boolean(r.enabled) })
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
      rowEstimate: r.row_estimate === null ? null : Number(r.row_estimate),
      triggers: trgByOid.get(oid) ?? []
    }
    if (!bySchema.has(table.schema)) bySchema.set(table.schema, [])
    bySchema.get(table.schema)!.push(table)
  }

  // A schema holding only functions or types is still a schema worth showing.
  const schemaMap = new Map<string, SchemaMeta>()
  const schemaOf = (name: string): SchemaMeta => {
    let s = schemaMap.get(name)
    if (!s) schemaMap.set(name, (s = { name, tables: [], routines: [], sequences: [], types: [] }))
    return s
  }
  for (const [name, tables] of bySchema) schemaOf(name).tables = tables

  for (const r of routines) {
    const routine: RoutineMeta = {
      oid: Number(r.oid),
      name: String(r.name),
      kind: PROKIND[String(r.prokind)] ?? 'function',
      args: String(r.args ?? ''),
      returns: r.returns === null ? null : String(r.returns),
      language: String(r.language),
      comment: r.comment === null ? null : String(r.comment)
    }
    schemaOf(String(r.schema)).routines!.push(routine)
  }
  for (const r of sequences) {
    const seq: SequenceMeta = {
      name: String(r.name),
      dataType: String(r.data_type),
      ownedBy: r.owned_by === null ? null : String(r.owned_by)
    }
    schemaOf(String(r.schema)).sequences!.push(seq)
  }
  for (const r of types) {
    const kind = TYPTYPE[String(r.typtype)]
    if (!kind) continue
    schemaOf(String(r.schema)).types!.push({ name: String(r.name), kind, detail: String(r.detail ?? '') })
  }

  const schemas = [...schemaMap.values()].sort((a, b) => a.name.localeCompare(b.name))

  return {
    connectionId: conn.config.id,
    database: String(dbRows[0]?.db ?? conn.config.database ?? ''),
    schemas,
    fetchedAt: Date.now()
  }
}

/**
 * pg_trigger.tgtype is a bitmask: 1 ROW, 2 BEFORE, 4 INSERT, 8 DELETE,
 * 16 UPDATE, 32 TRUNCATE, 64 INSTEAD OF. Neither BEFORE nor INSTEAD means AFTER.
 */
export function triggerTiming(type: number): string {
  const when = type & 64 ? 'INSTEAD OF' : type & 2 ? 'BEFORE' : 'AFTER'
  const events = [
    [4, 'INSERT'],
    [16, 'UPDATE'],
    [8, 'DELETE'],
    [32, 'TRUNCATE']
  ]
    .filter(([bit]) => type & (bit as number))
    .map(([, name]) => name)
  return `${when} ${events.join(' OR ')}${type & 1 ? '' : ' (statement)'}`
}

/**
 * The server's own CREATE statement for a routine, view or trigger. The CASE
 * guards keep pg_get_functiondef off aggregates, where it raises: an error here
 * would abort the user's open transaction in manual-commit mode.
 */
export async function sourceOf(conn: PgConnection, target: SourceTarget): Promise<string> {
  if (target.kind === 'routine') {
    const rows = await conn.query(
      `SELECT p.prokind, n.nspname AS schema, p.proname AS name,
              pg_get_function_identity_arguments(p.oid) AS args,
              CASE WHEN p.prokind IN ('f','p','w') THEN pg_get_functiondef(p.oid) END AS def
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.oid = $1`,
      [target.oid]
    )
    const r = rows[0]
    if (!r) throw new Error('That routine no longer exists. Refresh the catalog (⌘R).')
    if (r.def !== null) return String(r.def).trimEnd() + ';'
    return `-- aggregate ${r.schema}.${r.name}(${r.args})\n-- Postgres has no pg_get_functiondef for aggregates.`
  }

  if (target.kind === 'view') {
    const rows = await conn.query(
      `SELECT c.relkind, pg_get_viewdef(c.oid, true) AS def
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('v','m')`,
      [target.schema, target.name]
    )
    const r = rows[0]
    if (!r) throw new Error(`No such view: ${target.schema}.${target.name}`)
    const head = r.relkind === 'm' ? 'CREATE MATERIALIZED VIEW' : 'CREATE OR REPLACE VIEW'
    return `${head} ${ident(target.schema)}.${ident(target.name)} AS\n${String(r.def).trimEnd()}`
  }

  const rows = await conn.query(
    `SELECT pg_get_triggerdef(tg.oid, true) AS def
       FROM pg_trigger tg
       JOIN pg_class c ON c.oid = tg.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND tg.tgname = $3`,
    [target.schema, target.table, target.name]
  )
  if (!rows[0]) throw new Error(`No such trigger: ${target.name}`)
  return `${String(rows[0].def)};`
}

const ident = (s: string): string => (/^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`)
