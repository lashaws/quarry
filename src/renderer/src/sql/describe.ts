import type { Catalog, TableMeta } from '@shared/ipc'
import { resolveContext, identifierAt, type TableRef } from './context'

export interface Described {
  kind: 'table' | 'column' | 'schema'
  markdown: string
  table?: TableMeta
  /** offsets of the identifier in the document */
  start: number
  end: number
}

/**
 * Identifies whatever sits under the caret, for hover docs and ⌘B navigation.
 * Resolution order matches how a reader would guess: an alias or table in scope
 * first, then a schema, then a column of any visible table.
 */
export function describeAt(sql: string, offset: number, catalog: Catalog | null): Described | null {
  if (!catalog) return null
  const id = identifierAt(sql, offset)
  if (!id) return null

  const ctx = resolveContext(sql, offset)
  const visible = ctx.tables
    .map((ref) => ({ ref, meta: findTable(catalog, ref) }))
    .filter((v): v is { ref: TableRef; meta: TableMeta } => !!v.meta)

  const lower = id.name.toLowerCase()

  // "u" in "... users u" / a bare table name
  const asAlias = visible.find(
    (v) => v.ref.alias?.toLowerCase() === lower || v.meta.name.toLowerCase() === lower
  )
  if (asAlias && !id.qualifier) {
    return { kind: 'table', markdown: tableDoc(asAlias.meta), table: asAlias.meta, start: id.start, end: id.end }
  }

  // "app" in "app.partner"
  const schema = catalog.schemas.find((s) => s.name.toLowerCase() === lower)
  if (schema && !id.qualifier) {
    return {
      kind: 'schema',
      markdown: `**${schema.name}** — schema\n\n${schema.tables.length} tables`,
      start: id.start,
      end: id.end
    }
  }

  // A table named with an explicit schema qualifier
  if (id.qualifier) {
    const qualified = catalog.schemas
      .find((s) => s.name.toLowerCase() === id.qualifier!.toLowerCase())
      ?.tables.find((t) => t.name.toLowerCase() === lower)
    if (qualified) {
      return { kind: 'table', markdown: tableDoc(qualified), table: qualified, start: id.start, end: id.end }
    }
  }

  // A column, either qualified by an alias or bare in a single-table scope
  const owners = id.qualifier
    ? visible.filter(
        (v) =>
          v.ref.alias?.toLowerCase() === id.qualifier!.toLowerCase() ||
          v.meta.name.toLowerCase() === id.qualifier!.toLowerCase()
      )
    : visible
  for (const v of owners) {
    const col = v.meta.columns.find((c) => c.name.toLowerCase() === lower)
    if (col) {
      return { kind: 'column', markdown: columnDoc(v.meta, col.name), table: v.meta, start: id.start, end: id.end }
    }
  }

  // Last resort: a table anywhere in the catalog, so ⌘B works on a bare name.
  for (const s of catalog.schemas) {
    const t = s.tables.find((x) => x.name.toLowerCase() === lower)
    if (t) return { kind: 'table', markdown: tableDoc(t), table: t, start: id.start, end: id.end }
  }
  return null
}

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

export function tableDoc(t: TableMeta): string {
  const lines: string[] = [`**${t.schema}.${t.name}** — ${t.kind}`]
  if (t.comment) lines.push('', t.comment)
  if (t.rowEstimate !== null) lines.push('', `~${t.rowEstimate.toLocaleString()} rows`)

  const fkBy = new Map(
    t.foreignKeys.flatMap((fk) =>
      fk.columns.map((c, i) => [c, `${fk.refSchema}.${fk.refTable}.${fk.refColumns[i]}`] as const)
    )
  )
  lines.push('', '| column | type | |', '|---|---|---|')
  for (const c of t.columns.slice(0, 40)) {
    const marks = [
      c.isPrimaryKey ? 'PK' : '',
      fkBy.has(c.name) ? `FK → ${fkBy.get(c.name)}` : '',
      c.nullable ? '' : 'NOT NULL'
    ].filter(Boolean).join(', ')
    lines.push(`| ${c.name} | \`${c.dataType}\` | ${marks} |`)
  }
  if (t.columns.length > 40) lines.push(`| … | ${t.columns.length - 40} more | |`)
  return lines.join('\n')
}

export function columnDoc(t: TableMeta, columnName: string): string {
  const c = t.columns.find((x) => x.name === columnName)
  if (!c) return ''
  const fk = t.foreignKeys.find((f) => f.columns.includes(columnName))
  const lines = [`**${columnName}** \`${c.dataType}\``, '', `in ${t.schema}.${t.name}`]
  const marks: string[] = []
  if (c.isPrimaryKey) marks.push('primary key')
  if (!c.nullable) marks.push('not null')
  if (c.defaultValue) marks.push(`default \`${c.defaultValue}\``)
  if (marks.length) lines.push('', marks.join(' · '))
  if (fk) {
    const i = fk.columns.indexOf(columnName)
    lines.push('', `→ ${fk.refSchema}.${fk.refTable}.${fk.refColumns[i]}`)
  }
  const idx = t.indexes.filter((i) => i.columns.includes(columnName))
  if (idx.length) lines.push('', `indexed: ${idx.map((i) => i.name).join(', ')}`)
  if (c.comment) lines.push('', c.comment)
  return lines.join('\n')
}
