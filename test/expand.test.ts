import type { Catalog, TableMeta } from '@shared/ipc'
import { expandStar } from '../src/renderer/src/sql/expand.ts'
import { describeAt } from '../src/renderer/src/sql/describe.ts'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, extra = ''): void => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? '\n       ' + extra : ''}`) }
}
const col = (name: string, dataType: string, pk = false, nullable = true, ordinal = 1) =>
  ({ name, dataType, nullable, defaultValue: null, isPrimaryKey: pk, ordinal, comment: null })

const users: TableMeta = {
  schema: 'shop', name: 'users', kind: 'table', comment: 'People with logins',
  columns: [col('user_id', 'uuid', true, false, 1), col('email', 'text', false, false, 2), col('name', 'text', false, true, 3)],
  primaryKey: ['user_id'],
  foreignKeys: [], indexes: [{ name: 'idx_email', columns: ['email'], unique: true, primary: false }],
  rowEstimate: 4200
}
const orders: TableMeta = {
  schema: 'billing', name: 'orders', kind: 'table', comment: null,
  columns: [col('order_id', 'uuid', true, false, 1), col('user_id', 'uuid', false, false, 2)],
  primaryKey: ['order_id'],
  foreignKeys: [{ name: 'fk_o_u', columns: ['user_id'], refSchema: 'shop', refTable: 'users', refColumns: ['user_id'] }],
  indexes: [], rowEstimate: 900
}
const catalog: Catalog = {
  connectionId: 'c', database: 'd', fetchedAt: 0,
  schemas: [{ name: 'shop', tables: [users] }, { name: 'billing', tables: [orders] }]
}
const run = (sqlWithCaret: string) => {
  const offset = sqlWithCaret.indexOf('|')
  const sql = sqlWithCaret.replace('|', '')
  const r = expandStar(sql, offset, catalog)
  return r ? sql.slice(0, r.start) + r.text + sql.slice(r.end) : null
}

console.log('expandStar')
ok('single table expands unqualified',
   run('select *| from shop.users') === 'select user_id, email, name from shop.users',
   String(run('select *| from shop.users')))
ok('caret anywhere in statement works',
   run('select * from shop.users where |1=1') === 'select user_id, email, name from shop.users where 1=1',
   String(run('select * from shop.users where |1=1')))
ok('multi-table qualifies by alias',
   run('select *| from shop.users u join billing.orders o on o.user_id = u.user_id')
     === 'select u.user_id, u.email, u.name, o.order_id, o.user_id from shop.users u join billing.orders o on o.user_id = u.user_id',
   String(run('select *| from shop.users u join billing.orders o on o.user_id = u.user_id')))
ok('count(*) is left alone', run('select count(*)| from shop.users') === null)
ok('star inside a string is ignored', run(`select '*'| from shop.users`) === null)
ok('unknown table yields nothing', run('select *| from nope.nothing') === null)
ok('no catalog yields nothing', expandStar('select * from shop.users', 8, null) === null)

console.log('\ndescribeAt')
const d = (sqlWithCaret: string) => {
  const offset = sqlWithCaret.indexOf('|')
  return describeAt(sqlWithCaret.replace('|', ''), offset, catalog)
}
ok('table name resolves', d('select * from shop.us|ers')?.kind === 'table', JSON.stringify(d('select * from shop.us|ers')?.kind))
ok('  carries the table', d('select * from shop.us|ers')?.table?.name === 'users')
ok('  documents the comment', (d('select * from shop.us|ers')?.markdown ?? '').includes('People with logins'))
ok('  lists columns', (d('select * from shop.us|ers')?.markdown ?? '').includes('user_id'))
ok('alias resolves to its table', d('select * from shop.users u where u|.email = 1')?.table?.name === 'users')
ok('column resolves', d('select * from shop.users u where u.em|ail = 1')?.kind === 'column')
ok('  documents the type', (d('select * from shop.users u where u.em|ail = 1')?.markdown ?? '').includes('text'))
ok('  documents the index', (d('select * from shop.users u where u.em|ail = 1')?.markdown ?? '').includes('idx_email'))
ok('FK column documents its target',
   (d('select * from billing.orders o where o.us|er_id = 1')?.markdown ?? '').includes('shop.users.user_id'),
   d('select * from billing.orders o where o.us|er_id = 1')?.markdown)
ok('schema resolves', d('select * from sh|op.users')?.kind === 'schema')
ok('keyword resolves to nothing', d('sel|ect * from shop.users') === null)
ok('no catalog yields nothing', describeAt('select * from shop.users', 16, null) === null)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
