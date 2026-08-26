import type { EditTarget, GridEdits, TableMeta } from '@shared/ipc'
import { buildChanges, renderPreview } from '../src/main/query/dml.ts'
import { renderDdl } from '../src/main/query/ddl.ts'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, extra = ''): void => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? '\n       ' + extra : ''}`) }
}

const target: EditTarget = {
  schema: 'shop', table: 'order_line',
  pkColumns: ['order_line_id'],
  columnMap: { 0: 'order_line_id', 1: 'order_id', 2: 'is_primary' }
}
const rows = [
  ['pk-1', 'acct-1', 'false'],
  ['pk-2', 'acct-2', 'true'],
  ['pk-3', 'acct-3', 'false']
]
const edits = (o: Partial<GridEdits>): GridEdits => ({ updates: [], inserts: [], deletes: [], ...o })

console.log('UPDATE')
{
  const c = buildChanges(target, rows, edits({
    updates: [{ rowIndex: 1, columnIndex: 2, oldValue: 'true', newValue: 'false' }]
  }))
  ok('one statement', c.length === 1)
  ok('sets the column', c[0].sql === 'UPDATE "shop"."order_line" SET "is_primary" = $1 WHERE "order_line_id" = $2', c[0].sql)
  ok('binds params in order', JSON.stringify(c[0].params) === '["false","pk-2"]', JSON.stringify(c[0].params))
}
{
  const c = buildChanges(target, rows, edits({
    updates: [
      { rowIndex: 0, columnIndex: 1, oldValue: 'acct-1', newValue: 'x' },
      { rowIndex: 0, columnIndex: 2, oldValue: 'false', newValue: 'true' }
    ]
  }))
  ok('two columns collapse into one UPDATE', c.length === 1 && c[0].sql.includes('"order_id" = $1, "is_primary" = $2'), c[0].sql)
}
{
  const c = buildChanges(target, rows, edits({
    updates: [
      { rowIndex: 0, columnIndex: 1, oldValue: 'acct-1', newValue: 'first' },
      { rowIndex: 0, columnIndex: 1, oldValue: 'first', newValue: 'second' }
    ]
  }))
  ok('re-editing a cell emits one SET', (c[0].sql.match(/=/g) ?? []).length === 2, c[0].sql)
  ok('  keeps the latest value', c[0].params[0] === 'second')
}
{
  const c = buildChanges(target, rows, edits({
    updates: [{ rowIndex: 0, columnIndex: 1, oldValue: 'a', newValue: null }]
  }))
  ok('NULL is a bound param, not literal SQL', c[0].params[0] === null && c[0].sql.includes('= $1'))
  ok('preview renders NULL', renderPreview(c[0]).includes('= NULL'), renderPreview(c[0]))
}

console.log('\nINSERT')
{
  const c = buildChanges(target, rows, edits({
    inserts: [{ id: 'n1', values: { 0: 'pk-9', 1: 'acct-9' } }]
  }))
  ok('one insert', c.length === 1 && c[0].kind === 'insert')
  ok('omits untouched columns so defaults apply',
     c[0].sql === 'INSERT INTO "shop"."order_line" ("order_line_id", "order_id") VALUES ($1, $2)', c[0].sql)
  ok('binds values', JSON.stringify(c[0].params) === '["pk-9","acct-9"]')
}
{
  // An explicit NULL must be written. Dropping it let a column default win, so
  // pressing NULL on a new row silently produced the default instead.
  const c = buildChanges(target, rows, edits({
    inserts: [{ id: 'n3', values: { 0: 'pk-9', 2: null } }]
  }))
  ok('explicit NULL is written, not dropped',
     c[0].sql === 'INSERT INTO "shop"."order_line" ("order_line_id", "is_primary") VALUES ($1, $2)', c[0].sql)
  ok('  bound as a NULL param', JSON.stringify(c[0].params) === '["pk-9",null]', JSON.stringify(c[0].params))
}
{
  const c = buildChanges(target, rows, edits({ inserts: [{ id: 'n2', values: {} }] }))
  ok('empty row uses DEFAULT VALUES', c[0].sql.endsWith('DEFAULT VALUES'), c[0].sql)
}

console.log('\nDELETE')
{
  const c = buildChanges(target, rows, edits({ deletes: [2, 0] }))
  ok('two deletes', c.length === 2)
  ok('sorted by row', c[0].params[0] === 'pk-1' && c[1].params[0] === 'pk-3')
  ok('addressed by PK', c[0].sql === 'DELETE FROM "shop"."order_line" WHERE "order_line_id" = $1', c[0].sql)
}

console.log('\nupdate + delete of the same row')
{
  const c = buildChanges(target, rows, edits({
    updates: [{ rowIndex: 1, columnIndex: 2, oldValue: 'true', newValue: 'false' }],
    deletes: [1]
  }))
  ok('the doomed row is not updated first', c.length === 1 && c[0].kind === 'delete',
     c.map(x => x.kind).join(','))
}
{
  const c = buildChanges(target, rows, edits({
    updates: [{ rowIndex: 0, columnIndex: 2, oldValue: 'false', newValue: 'true' }],
    deletes: [1]
  }))
  ok('an unrelated row is still updated', c.map(x => x.kind).join(',') === 'update,delete')
}

console.log('\npreview rendering')
{
  const change = {
    sql: 'UPDATE "s"."t" SET "a$1" = $1 WHERE "id" = $2',
    params: ['new', '7'] as (string | null)[],
    kind: 'update' as const,
    rowIndex: 0
  }
  // A blanket regex sweep rewrites the $1 inside the quoted identifier too.
  ok('leaves $1 inside a quoted identifier alone',
     renderPreview(change) === `UPDATE "s"."t" SET "a$1" = 'new' WHERE "id" = '7'`, renderPreview(change))
}
{
  const change = {
    sql: 'UPDATE t SET a = $1, b = $2, c = $3, d = $4, e = $5, f = $6, g = $7, h = $8, i = $9, j = $10',
    params: Array.from({ length: 10 }, (_v, i) => String(i + 1)) as (string | null)[],
    kind: 'update' as const, rowIndex: 0
  }
  ok('$10 is not corrupted by $1', renderPreview(change).endsWith("j = '10'"), renderPreview(change))
}

console.log('\nordering and safety')
{
  const c = buildChanges(target, rows, edits({
    updates: [{ rowIndex: 0, columnIndex: 2, oldValue: 'false', newValue: 'true' }],
    inserts: [{ id: 'n', values: { 0: 'pk-x' } }],
    deletes: [1]
  }))
  ok('inserts, then updates, then deletes',
     c.map(x => x.kind).join(',') === 'insert,update,delete', c.map(x => x.kind).join(','))
}
{
  let threw = false
  try {
    buildChanges({ ...target, columnMap: { 1: 'order_id' } }, rows, edits({
      updates: [{ rowIndex: 0, columnIndex: 1, oldValue: 'a', newValue: 'b' }]
    }))
  } catch { threw = true }
  ok('refuses to update when the PK is absent from the result', threw)
}
{
  let threw = false
  try {
    buildChanges(target, [[null, 'a', 'b']], edits({ deletes: [0] }))
  } catch { threw = true }
  ok('refuses to delete a row whose PK is NULL', threw)
}
{
  const c = buildChanges(target, rows, edits({
    updates: [{ rowIndex: 0, columnIndex: 1, oldValue: 'a', newValue: "O'Brien" }]
  }))
  ok('quotes are escaped in the preview only', renderPreview(c[0]).includes("'O''Brien'"), renderPreview(c[0]))
  ok('  the executed SQL stays parameterised', c[0].sql.includes('$1') && !c[0].sql.includes("O'Brien"))
}

console.log('\nDDL generation')
{
  const t: TableMeta = {
    schema: 'shop', name: 'order_line', kind: 'table', comment: 'Joins an order to a product',
    columns: [
      { name: 'order_line_id', dataType: 'uuid', nullable: false, defaultValue: 'gen_random_uuid()', isPrimaryKey: true, ordinal: 1, comment: null },
      { name: 'order_id', dataType: 'uuid', nullable: false, defaultValue: null, isPrimaryKey: false, ordinal: 2, comment: 'FK to orders' },
      { name: 'notes', dataType: 'text', nullable: true, defaultValue: null, isPrimaryKey: false, ordinal: 3, comment: null }
    ],
    primaryKey: ['order_line_id'],
    foreignKeys: [{ name: 'fk_line_order', columns: ['order_id'], refSchema: 'shop', refTable: 'orders', refColumns: ['order_id'] }],
    indexes: [
      { name: 'order_line_pkey', columns: ['order_line_id'], unique: true, primary: true },
      { name: 'idx_line_order', columns: ['order_id'], unique: false, primary: false }
    ],
    rowEstimate: 10
  }
  const ddl = renderDdl(t)
  ok('creates the table', ddl.startsWith('CREATE TABLE shop.order_line ('), ddl.split('\n')[0])
  ok('emits NOT NULL', ddl.includes('order_id uuid NOT NULL'))
  ok('emits DEFAULT', ddl.includes('DEFAULT gen_random_uuid()'))
  ok('emits PRIMARY KEY', ddl.includes('PRIMARY KEY (order_line_id)'))
  ok('emits the FK constraint', ddl.includes('FOREIGN KEY (order_id) REFERENCES shop.orders (order_id)'))
  ok('emits secondary indexes', ddl.includes('CREATE INDEX idx_line_order'))
  ok('omits the implicit PK index', !ddl.includes('order_line_pkey'))
  ok('emits table comment', ddl.includes("COMMENT ON TABLE shop.order_line IS 'Joins an order to a product'"))
  ok('emits column comment', ddl.includes("COMMENT ON COLUMN shop.order_line.order_id IS 'FK to orders'"))
  ok('only quotes identifiers that need it', !ddl.includes('"order_id"'))
}
{
  const odd: TableMeta = {
    schema: 'weird', name: 'Mixed Case', kind: 'table', comment: null,
    columns: [{ name: 'Col One', dataType: 'text', nullable: true, defaultValue: null, isPrimaryKey: false, ordinal: 1, comment: null }],
    primaryKey: [], foreignKeys: [], indexes: [], rowEstimate: null
  }
  const ddl = renderDdl(odd)
  ok('quotes identifiers that do need it', ddl.includes('"Mixed Case"') && ddl.includes('"Col One"'), ddl.split('\n')[0])
}

{
  const serial: TableMeta = {
    schema: 's', name: 't', kind: 'table', comment: null,
    columns: [
      { name: 'id', dataType: 'integer', nullable: false, defaultValue: "nextval('s.t_id_seq'::regclass)", isPrimaryKey: true, ordinal: 1, comment: null },
      { name: 'big', dataType: 'bigint', nullable: false, defaultValue: "nextval('s.t_big_seq'::regclass)", isPrimaryKey: false, ordinal: 2, comment: null },
      { name: 'plain', dataType: 'integer', nullable: false, defaultValue: '7', isPrimaryKey: false, ordinal: 3, comment: null }
    ],
    primaryKey: ['id'], foreignKeys: [], indexes: [], rowEstimate: null
  }
  const ddl = renderDdl(serial)
  // Emitting the raw nextval() default yields DDL that cannot be replayed,
  // because the sequence it names is never created.
  ok('collapses serial columns', ddl.includes('id serial') && !ddl.includes('nextval'), ddl)
  ok('  handles bigserial', ddl.includes('big bigserial'))
  ok('  leaves ordinary defaults alone', ddl.includes('plain integer NOT NULL DEFAULT 7'), ddl)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
