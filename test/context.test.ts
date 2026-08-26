import { resolveContext } from '../src/renderer/src/sql/context.ts'

let pass = 0, fail = 0
function eq(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`) }
}
/** "|" marks the caret. */
function at(sqlWithCaret: string) {
  const offset = sqlWithCaret.indexOf('|')
  return resolveContext(sqlWithCaret.replace('|', ''), offset)
}

console.log('clause detection')
eq('after FROM', at('select * from |').clause, 'from')
eq('in SELECT list', at('select | from users').clause, 'select')
eq('after WHERE', at('select * from users where |').clause, 'where')
eq('after ON', at('select * from a join b on |').clause, 'on')
eq('after ORDER BY', at('select * from t order by |').clause, 'order')
eq('after UPDATE SET', at('update users set |').clause, 'set')

console.log('alias resolution on incomplete SQL')
eq('alias map', at('select * from shop.users u where u.|').tables,
   [{ schema: 'shop', table: 'users', alias: 'u' }])
eq('qualifier captured', at('select * from shop.users u where u.|').qualifier, 'u')
eq('prefix captured', at('select * from shop.users u where u.na|').prefix, 'na')
eq('AS alias', at('select * from billing.product as p where p.|').tables,
   [{ schema: 'billing', table: 'product', alias: 'p' }])
eq('unqualified table', at('select * from users where |').tables,
   [{ schema: null, table: 'users', alias: null }])
eq('ON is not an alias', at('select * from a join b on |').tables,
   [{ schema: null, table: 'a', alias: null }, { schema: null, table: 'b', alias: null }])
eq('WHERE is not an alias', at('select * from users where |').tables[0].alias, null)

console.log('multiple tables')
eq('two joined tables', at('select | from shop.users u join billing.product p on u.id = p.uid').tables,
   [{ schema: 'shop', table: 'users', alias: 'u' },
    { schema: 'billing', table: 'product', alias: 'p' }])

console.log('join target for ON pre-fill')
eq('join target', at('select * from shop.users u join billing.product p on |').joinTarget,
   { schema: 'billing', table: 'product', alias: 'p' })

console.log('subquery scoping')
eq('inner scope wins', at('select * from outer_t where id in (select | from inner_t i)').tables,
   [{ schema: null, table: 'inner_t', alias: 'i' }])

console.log('robustness')
eq('empty input', at('|').clause, 'unknown')
eq('semicolon in string does not split', at("select ';' from t where |").tables,
   [{ schema: null, table: 't', alias: null }])
eq('second statement isolated', at('select * from a; select * from b where |').tables,
   [{ schema: null, table: 'b', alias: null }])
eq('quoted identifier table', at('select * from "My Schema"."My Table" t where t.|').tables,
   [{ schema: 'My Schema', table: 'My Table', alias: 't' }])

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
