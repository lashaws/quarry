import type { TableMeta } from '@shared/ipc'

const ident = (s: string): string =>
  /^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`

/**
 * Regenerates CREATE TABLE DDL from the catalog snapshot. Deliberately built
 * from introspected metadata rather than pg_dump, so it works without a shell
 * and stays consistent with what the tree shows.
 */
export function renderDdl(t: TableMeta): string {
  const q = `${ident(t.schema)}.${ident(t.name)}`
  if (t.kind === 'view' || t.kind === 'matview') {
    return `-- ${t.kind} ${q}\n-- ${t.columns.length} columns\n${columnComment(t)}`
  }

  const lines: string[] = [`CREATE TABLE ${q} (`]
  const body: string[] = []

  for (const c of t.columns) {
    const serial = serialType(c.dataType, c.defaultValue)
    // A serial column introspects as `integer DEFAULT nextval('t_id_seq')`.
    // Emitting that verbatim produces DDL that cannot be replayed, because the
    // sequence it names is never created. Collapse it back to `serial`.
    const parts = [`    ${ident(c.name)} ${serial ?? c.dataType}`]
    if (!c.nullable && !serial) parts.push('NOT NULL')
    if (c.defaultValue && !serial) parts.push(`DEFAULT ${c.defaultValue}`)
    body.push(parts.join(' '))
  }

  if (t.primaryKey.length) {
    body.push(`    PRIMARY KEY (${t.primaryKey.map(ident).join(', ')})`)
  }
  for (const fk of t.foreignKeys) {
    body.push(
      `    CONSTRAINT ${ident(fk.name)} FOREIGN KEY (${fk.columns.map(ident).join(', ')}) ` +
        `REFERENCES ${ident(fk.refSchema)}.${ident(fk.refTable)} (${fk.refColumns.map(ident).join(', ')})`
    )
  }

  lines.push(body.join(',\n'), ');')

  // Primary-key indexes are implied by the constraint above; don't restate them.
  for (const idx of t.indexes.filter((i) => !i.primary)) {
    if (!idx.columns.length) continue
    lines.push(
      `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${ident(idx.name)} ` +
        `ON ${q} (${idx.columns.map(ident).join(', ')});`
    )
  }

  if (t.comment) lines.push(`COMMENT ON TABLE ${q} IS ${literal(t.comment)};`)
  for (const c of t.columns.filter((x) => x.comment)) {
    lines.push(`COMMENT ON COLUMN ${q}.${ident(c.name)} IS ${literal(c.comment!)};`)
  }

  return lines.join('\n')
}

const SERIAL_FOR: Record<string, string> = {
  smallint: 'smallserial',
  integer: 'serial',
  bigint: 'bigserial'
}

/** Returns the serial spelling when a column is an integer backed by a sequence. */
function serialType(dataType: string, defaultValue: string | null): string | null {
  if (!defaultValue || !/^nextval\(/i.test(defaultValue)) return null
  return SERIAL_FOR[dataType.toLowerCase()] ?? null
}

function columnComment(t: TableMeta): string {
  return t.columns.map((c) => `--   ${c.name} ${c.dataType}`).join('\n')
}

const literal = (s: string): string => `'${s.replace(/'/g, "''")}'`
