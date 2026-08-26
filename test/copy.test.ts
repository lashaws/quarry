import type { QueryResult } from '@shared/ipc'
import { renderCopy } from '../src/renderer/src/copy.ts'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, extra = ''): void => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? '\n       ' + extra : ''}`) }
}

const base: QueryResult = {
  queryId: 'q', rowCount: null, complete: true, durationMs: 1, command: 'SELECT', notices: [],
  fields: [
    { name: 'id', dataType: 'int4', affinity: 'numeric' },
    { name: 'name', dataType: 'text', affinity: 'text' }
  ],
  rows: [],
  editable: { schema: 'billing', table: 'demo', pkColumns: ['id'], columnMap: { 0: 'id', 1: 'name' } }
}
const rows = [['1', 'alpha'], ['2', null], ['3', 'has, comma'], ['4', "O'Brien"]]

console.log('CSV')
{
  const out = renderCopy(base, rows, 'csv').split('\n')
  ok('header first', out[0] === 'id,name')
  ok('plain row', out[1] === '1,alpha')
  ok('NULL becomes empty', out[2] === '2,')
  ok('quotes a comma', out[3] === '3,"has, comma"', out[3])
  ok('leaves apostrophes alone', out[4] === "4,O'Brien", out[4])
}
{
  const out = renderCopy(base, [['1', 'a"b']], 'csv').split('\n')[1]
  ok('doubles embedded quotes', out === '1,"a""b"', out)
}
{
  const out = renderCopy(base, [['1', 'line1\nline2']], 'csv').split('\n')
  ok('quotes embedded newline', out[1].startsWith('1,"line1'), out[1])
}

console.log('\nJSON')
{
  const parsed = JSON.parse(renderCopy(base, rows, 'json'))
  ok('array of objects', Array.isArray(parsed) && parsed.length === 4)
  ok('keys are column names', JSON.stringify(parsed[0]) === '{"id":"1","name":"alpha"}', JSON.stringify(parsed[0]))
  ok('NULL stays null', parsed[1].name === null)
}

console.log('\nINSERT')
{
  const out = renderCopy(base, rows, 'insert').split('\n')
  ok('targets the source table', out[0].startsWith('INSERT INTO billing.demo (id, name) VALUES ('), out[0])
  ok('NULL is unquoted', out[1] === "INSERT INTO billing.demo (id, name) VALUES ('2', NULL);", out[1])
  ok('escapes apostrophes', out[3].includes("'O''Brien'"), out[3])
  ok('statements end with a semicolon', out.every(l => l.endsWith(';')))
}
{
  const readOnly = { ...base, editable: null }
  const out = renderCopy(readOnly, [['1', 'a']], 'insert')
  ok('falls back when there is no source table', out.startsWith('INSERT INTO target_table'), out)
}
{
  const odd = {
    ...base,
    fields: [{ name: 'Mixed Case', dataType: 'text', affinity: 'text' as const }],
    editable: { schema: 'billing', table: 'demo', pkColumns: [], columnMap: { 0: 'Mixed Case' } }
  }
  ok('quotes identifiers that need it', renderCopy(odd, [['x']], 'insert').includes('"Mixed Case"'))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
