import type { Catalog, TableMeta } from '@shared/ipc'
import type { CompletionContext, TableRef } from './context'

export type SuggestKind = 'schema' | 'table' | 'view' | 'column' | 'alias' | 'keyword' | 'join'

export interface Suggestion {
  label: string
  kind: SuggestKind
  /** text actually inserted; may differ from the label for join conditions */
  insert: string
  detail: string
  documentation?: string
  /** lower sorts first */
  rank: number
  /** insert text uses snippet syntax (a ${1:alias} placeholder) */
  snippet?: boolean
}

const KEYWORDS = [
  'select', 'from', 'where', 'group by', 'order by', 'having', 'limit', 'offset',
  'join', 'left join', 'right join', 'inner join', 'full join', 'cross join',
  'on', 'using', 'as', 'and', 'or', 'not', 'null', 'is null', 'is not null',
  'in', 'exists', 'between', 'like', 'ilike', 'case', 'when', 'then', 'else', 'end',
  'insert into', 'values', 'update', 'set', 'delete from', 'returning',
  'with', 'union', 'union all', 'intersect', 'except', 'distinct', 'asc', 'desc',
  'count(', 'sum(', 'avg(', 'min(', 'max(', 'coalesce(', 'now()'
]

/** Clauses where an identifier names a table, so a qualifier must be a schema. */
const TABLE_CLAUSES = new Set<CompletionContext['clause']>(['from', 'join', 'insert', 'update'])

const quoteIfNeeded = (name: string): string =>
  /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`

/** Turn resolved context plus the cached catalog into ranked suggestions. */
export function suggest(ctx: CompletionContext, catalog: Catalog | null): Suggestion[] {
  if (!catalog) return keywordSuggestions()

  const visible = resolveVisible(ctx.tables, catalog)

  if (ctx.qualifier) {
    const q = ctx.qualifier.toLowerCase()
    const schema = catalog.schemas.find((s) => s.name.toLowerCase() === q)
    const asColumns = (): Suggestion[] | null => {
      // "u." where u is an alias or table name in scope -> that table's columns.
      const hit = visible.find(
        (v) => v.ref.alias?.toLowerCase() === q || v.meta.name.toLowerCase() === q
      )
      return hit ? columnSuggestions(hit.meta) : null
    }
    const taken = new Set(
      ctx.tables.map((t) => t.alias?.toLowerCase()).filter((a): a is string => !!a)
    )
    const asTables = (): Suggestion[] | null =>
      schema
        ? schema.tables.map((t, i) =>
            tableSuggestion(t, i, false, TABLE_CLAUSES.has(ctx.clause) ? aliasFor(t.name, taken) : undefined)
          )
        : null

    // In a table position a qualifier can only be a schema. Elsewhere it is far
    // more likely an alias. A name that is both (schema "account" holding table
    // "account") resolves differently depending on where the caret sits.
    const tablePosition = TABLE_CLAUSES.has(ctx.clause)
    const first = tablePosition ? asTables() : asColumns()
    return first ?? (tablePosition ? asColumns() : asTables()) ?? []
  }

  switch (ctx.clause) {
    case 'from':
    case 'join':
    case 'insert':
    case 'update': {
      const taken = new Set(
        ctx.tables.map((t) => t.alias?.toLowerCase()).filter((a): a is string => !!a)
      )
      return [...schemaSuggestions(catalog), ...allTableSuggestions(catalog, taken)]
    }

    case 'on': {
      const join = ctx.joinTarget ? joinConditionSuggestions(ctx, visible, catalog) : []
      return [...join, ...aliasSuggestions(visible), ...visibleColumnSuggestions(visible)]
    }

    case 'select':
    case 'where':
    case 'group':
    case 'order':
    case 'having':
    case 'set':
    case 'returning':
      return [
        ...visibleColumnSuggestions(visible),
        ...aliasSuggestions(visible),
        ...keywordSuggestions()
      ]

    default:
      // No clause context: offer table names without inventing an alias.
      return [...keywordSuggestions(), ...allTableSuggestions(catalog, null)]
  }
}

interface Visible {
  ref: TableRef
  meta: TableMeta
}

function resolveVisible(refs: TableRef[], catalog: Catalog): Visible[] {
  const out: Visible[] = []
  for (const ref of refs) {
    const schemas = ref.schema
      ? catalog.schemas.filter((s) => s.name.toLowerCase() === ref.schema!.toLowerCase())
      : catalog.schemas
    for (const s of schemas) {
      const meta = s.tables.find((t) => t.name.toLowerCase() === ref.table.toLowerCase())
      if (meta) {
        out.push({ ref, meta })
        break
      }
    }
  }
  return out
}

function columnSuggestions(meta: TableMeta): Suggestion[] {
  const fkCols = new Map(meta.foreignKeys.flatMap((fk) =>
    fk.columns.map((c, i) => [c, `${fk.refSchema}.${fk.refTable}.${fk.refColumns[i]}`] as const)
  ))
  return meta.columns.map((c, i) => {
    const badges = [
      c.isPrimaryKey ? 'PK' : null,
      fkCols.has(c.name) ? 'FK' : null,
      c.nullable ? null : 'NOT NULL'
    ].filter(Boolean)
    return {
      label: c.name,
      kind: 'column' as const,
      insert: quoteIfNeeded(c.name),
      detail: `${c.dataType}${badges.length ? '  ' + badges.join(' · ') : ''}`,
      documentation: [
        `${meta.schema}.${meta.name}.${c.name}`,
        fkCols.get(c.name) ? `→ ${fkCols.get(c.name)}` : null,
        c.comment
      ].filter(Boolean).join('\n'),
      // Primary keys first, then declaration order.
      rank: (c.isPrimaryKey ? 0 : 100) + i
    }
  })
}

function visibleColumnSuggestions(visible: Visible[]): Suggestion[] {
  const multi = visible.length > 1
  return visible.flatMap((v, ti) =>
    columnSuggestions(v.meta).map((s) => ({
      ...s,
      // Qualify when more than one table is in scope, so the insert is unambiguous.
      insert: multi && v.ref.alias ? `${quoteIfNeeded(v.ref.alias)}.${s.insert}` : s.insert,
      detail: `${s.detail}  —  ${v.ref.alias ?? v.meta.name}`,
      rank: 1000 + ti * 200 + s.rank
    }))
  )
}

function aliasSuggestions(visible: Visible[]): Suggestion[] {
  return visible
    .filter((v) => v.ref.alias)
    .map((v, i) => ({
      label: v.ref.alias!,
      kind: 'alias' as const,
      insert: v.ref.alias!,
      detail: `${v.meta.schema}.${v.meta.name}`,
      rank: 500 + i
    }))
}

function schemaSuggestions(catalog: Catalog): Suggestion[] {
  return catalog.schemas.map((s, i) => ({
    label: s.name,
    kind: 'schema' as const,
    insert: quoteIfNeeded(s.name),
    detail: `schema · ${s.tables.length} tables`,
    rank: 2000 + i
  }))
}

function tableSuggestion(t: TableMeta, i: number, qualify: boolean, alias?: string): Suggestion {
  const rows = t.rowEstimate === null ? '' : `  ~${formatCount(t.rowEstimate)} rows`
  const name = qualify
    ? `${quoteIfNeeded(t.schema)}.${quoteIfNeeded(t.name)}`
    : quoteIfNeeded(t.name)
  return {
    label: qualify ? `${t.schema}.${t.name}` : t.name,
    kind: t.kind === 'view' || t.kind === 'matview' ? 'view' : 'table',
    // In a table position, append a generated alias as an editable placeholder.
    insert: alias ? `${name} \${1:${alias}}` : name,
    snippet: !!alias,
    detail: `${t.kind}${rows}${alias ? `  as ${alias}` : ''}`,
    documentation: [t.comment, `${t.columns.length} columns`].filter(Boolean).join('\n'),
    rank: 3000 + i
  }
}

function allTableSuggestions(catalog: Catalog, taken: Set<string> | null): Suggestion[] {
  return catalog.schemas.flatMap((s, si) =>
    s.tables.map((t, i) =>
      tableSuggestion(t, si * 1000 + i, true, taken ? aliasFor(t.name, taken) : undefined)
    )
  )
}

/**
 * DataGrip-style alias: initials for snake_case names, else the first letter,
 * with a numeric suffix if that alias is already used in this statement.
 */
export function aliasFor(table: string, taken: Set<string>): string {
  const parts = table.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  let base = parts.length > 1 ? parts.map((p) => p[0]).join('') : (parts[0]?.[0] ?? 't')
  if (!/^[a-z]/.test(base)) base = 't' + base
  let candidate = base
  let n = 2
  while (taken.has(candidate)) candidate = `${base}${n++}`
  return candidate
}

/**
 * The differentiator: when completing a JOIN's ON clause, read the foreign keys
 * out of the catalog and offer the whole join condition pre-filled. DataGrip
 * does not do this.
 */
function joinConditionSuggestions(
  ctx: CompletionContext,
  visible: Visible[],
  catalog: Catalog
): Suggestion[] {
  const target = ctx.joinTarget
  if (!target) return []
  const targetV = visible.find(
    (v) => v.meta.name.toLowerCase() === target.table.toLowerCase()
  )
  if (!targetV) return []

  const others = visible.filter((v) => v !== targetV)
  const nameOf = (v: Visible): string => quoteIfNeeded(v.ref.alias ?? v.meta.name)
  const out: Suggestion[] = []

  for (const other of others) {
    // FK declared on the joined table pointing at a table already in scope.
    for (const fk of targetV.meta.foreignKeys) {
      if (matches(fk.refSchema, fk.refTable, other)) {
        out.push(condition(targetV, fk.columns, other, fk.refColumns, nameOf, out.length))
      }
    }
    // FK declared the other way round.
    for (const fk of other.meta.foreignKeys) {
      if (matches(fk.refSchema, fk.refTable, targetV)) {
        out.push(condition(other, fk.columns, targetV, fk.refColumns, nameOf, out.length))
      }
    }
  }
  void catalog
  return out
}

function matches(schema: string, table: string, v: Visible): boolean {
  return v.meta.schema === schema && v.meta.name === table
}

function condition(
  left: Visible,
  leftCols: string[],
  right: Visible,
  rightCols: string[],
  nameOf: (v: Visible) => string,
  i: number
): Suggestion {
  const text = leftCols
    .map((c, k) => `${nameOf(left)}.${quoteIfNeeded(c)} = ${nameOf(right)}.${quoteIfNeeded(rightCols[k])}`)
    .join(' AND ')
  return {
    label: text,
    kind: 'join',
    insert: text,
    detail: 'foreign key',
    documentation: `${left.meta.schema}.${left.meta.name} → ${right.meta.schema}.${right.meta.name}`,
    rank: i
  }
}

function keywordSuggestions(): Suggestion[] {
  return KEYWORDS.map((k, i) => ({
    label: k,
    kind: 'keyword' as const,
    insert: k,
    detail: 'keyword',
    rank: 9000 + i
  }))
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
