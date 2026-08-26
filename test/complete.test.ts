import type { Catalog, TableMeta } from '@shared/ipc'
import { resolveContext } from '../src/renderer/src/sql/context.ts'
import { suggest } from '../src/renderer/src/sql/complete.ts'

let pass = 0, fail = 0
function ok(label: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? '\n       ' + extra : ''}`) }
}
function at(sqlWithCaret: string) {
  const offset = sqlWithCaret.indexOf('|')
  return resolveContext(sqlWithCaret.replace('|', ''), offset)
}

// A small schema with a cross-schema foreign key, matching the live fixture.
const col = (name: string, dataType: string, pk = false, nullable = true, ordinal = 1) =>
  ({ name, dataType, nullable, defaultValue: null, isPrimaryKey: pk, ordinal, comment: null })

const orderLine: TableMeta = {
  schema: 'shop', name: 'order_line', kind: 'table', comment: null,
  columns: [
    col('order_line_id', 'uuid', true, false, 1),
    col('order_id', 'uuid', false, false, 2),
    col('product_id', 'uuid', false, false, 3),
    col('is_primary', 'boolean', false, false, 5)
  ],
  primaryKey: ['order_line_id'],
  foreignKeys: [
    { name: 'fk_line_order', columns: ['order_id'], refSchema: 'shop', refTable: 'orders', refColumns: ['order_id'] },
    { name: 'fk_line_product', columns: ['product_id'], refSchema: 'billing', refTable: 'product', refColumns: ['product_id'] }
  ],
  indexes: [], rowEstimate: 1200
}
const orders: TableMeta = {
  schema: 'shop', name: 'orders', kind: 'table', comment: null,
  columns: [col('order_id', 'uuid', true, false, 1), col('name', 'text', false, true, 2)],
  primaryKey: ['order_id'], foreignKeys: [], indexes: [], rowEstimate: 500
}
const product: TableMeta = {
  schema: 'billing', name: 'product', kind: 'table', comment: null,
  columns: [col('product_id', 'uuid', true, false, 1), col('display_name', 'text', false, true, 2)],
  primaryKey: ['product_id'], foreignKeys: [], indexes: [], rowEstimate: 30
}
const catalog: Catalog = {
  connectionId: 'c1', database: 'testdb', fetchedAt: 0,
  schemas: [
    { name: 'shop', tables: [orders, orderLine] },
    { name: 'billing', tables: [product] }
  ]
}

const labels = (s: ReturnType<typeof suggest>) => s.map(x => x.label)
const top = (s: ReturnType<typeof suggest>) => [...s].sort((a, b) => a.rank - b.rank)[0]

console.log('alias-qualified columns')
{
  const s = suggest(at('select * from shop.order_line ap where ap.|'), catalog)
  ok('lists that table columns', labels(s).includes('product_id'))
  ok('excludes other tables', !labels(s).includes('display_name'))
  ok('primary key sorts first', top(s).label === 'order_line_id', `got ${top(s)?.label}`)
  const pk = s.find(x => x.label === 'order_line_id')!
  ok('PK badge in detail', pk.detail.includes('PK'), pk.detail)
  const fk = s.find(x => x.label === 'product_id')!
  ok('FK badge in detail', fk.detail.includes('FK'), fk.detail)
  ok('FK target documented', (fk.documentation ?? '').includes('billing.product.product_id'), fk.documentation)
}

console.log('schema-qualified tables')
{
  const s = suggest(at('select * from shop.|'), catalog)
  ok('lists tables in schema', labels(s).sort().join(',') === 'order_line,orders', labels(s).sort().join(','))
}

console.log('FROM clause')
{
  const s = suggest(at('select * from |'), catalog)
  ok('offers schemas', s.some(x => x.kind === 'schema' && x.label === 'billing'))
  ok('offers qualified tables', labels(s).includes('shop.order_line'))
}

console.log('JOIN ... ON foreign-key pre-fill')
{
  const s = suggest(at('select * from shop.order_line ap join billing.product p on |'), catalog)
  const best = top(s)
  ok('top suggestion is the FK condition', best.label === 'ap.product_id = p.product_id', `got ${best?.label}`)
  ok('marked as foreign key', best.detail === 'foreign key')
}
{
  // Reverse direction: FK lives on the table already in scope.
  const s = suggest(at('select * from billing.product p join shop.order_line ap on |'), catalog)
  const best = top(s)
  ok('works in reverse direction', best.label === 'ap.product_id = p.product_id', `got ${best?.label}`)
}
{
  const s = suggest(at('select * from shop.order_line ap join shop.orders o on |'), catalog)
  ok('picks the right FK of two', top(s).label === 'ap.order_id = o.order_id', `got ${top(s)?.label}`)
}

console.log('multi-table scope qualifies inserts')
{
  const s = suggest(at('select | from shop.order_line ap join billing.product p on ap.product_id = p.product_id'), catalog)
  const ins = s.find(x => x.label === 'display_name')
  ok('qualifies with alias when ambiguous', ins?.insert === 'p.display_name', ins?.insert)
}
{
  const s = suggest(at('select | from shop.order_line ap'), catalog)
  const ins = s.find(x => x.label === 'product_id')
  ok('no qualifier when single table', ins?.insert === 'product_id', ins?.insert)
}

console.log('degradation')
ok('no catalog still gives keywords', suggest(at('select | from t'), null).some(x => x.kind === 'keyword'))
ok('unknown alias yields nothing', suggest(at('select * from shop.orders a where zz.|'), catalog).length === 0)

console.log('auto-alias in table position')
{
  const s = suggest(at('select * from |'), catalog)
  const t = s.find(x => x.label === 'shop.order_line')!
  ok('appends a generated alias', t.insert === 'shop.order_line ${1:ol}', t.insert)
  ok('marked as a snippet', t.snippet === true)
  const one = s.find(x => x.label === 'billing.product')!
  ok('single-word table uses first letter', one.insert === 'billing.product ${1:p}', one.insert)
}
{
  // "p" is already taken by the first table, so the second must not collide.
  const s = suggest(at('select * from billing.product p join |'), catalog)
  const t = s.find(x => x.label === 'billing.product')!
  ok('dedupes against aliases in scope', t.insert === 'billing.product ${1:p2}', t.insert)
}
{
  const s = suggest(at('select * from shop.orders a where |'), catalog)
  const col = s.find(x => x.kind === 'column')!
  ok('no alias snippet outside table position', !col.snippet)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
