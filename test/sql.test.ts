import { splitStatements, statementAt, maskLiterals, countTableReferences } from '../src/shared/sql.ts'

let pass = 0, fail = 0
function eq(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}\n       got      ${a}\n       expected ${e}`) }
}

console.log('splitStatements')
eq('two simple', splitStatements('select 1; select 2').map(s => s.text), ['select 1', 'select 2'])
eq('trailing semicolon', splitStatements('select 1;').map(s => s.text), ['select 1'])
eq('semicolon in string', splitStatements("select ';'; select 2").map(s => s.text), ["select ';'", 'select 2'])
eq('escaped quote', splitStatements("select 'it''s; here'; select 2").map(s => s.text), ["select 'it''s; here'", 'select 2'])
eq('line comment', splitStatements('select 1 -- ; nope\n; select 2').map(s => s.text), ['select 1 -- ; nope', 'select 2'])
eq('nested block comment', splitStatements('/* a /* b ; */ c ; */ select 1').map(s => s.text), ['/* a /* b ; */ c ; */ select 1'])
eq('quoted identifier', splitStatements('select "a;b" from t; select 2').map(s => s.text), ['select "a;b" from t', 'select 2'])

const fn = `CREATE FUNCTION f() RETURNS int AS $$
BEGIN
  RAISE NOTICE 'hi';
  RETURN 1;
END;
$$ LANGUAGE plpgsql;
SELECT f()`
eq('dollar-quoted body stays one statement', splitStatements(fn).length, 2)
eq('dollar body second stmt', splitStatements(fn)[1].text, 'SELECT f()')

const tagged = `DO $tag$ BEGIN; END; $tag$; select 9`
eq('tagged dollar quote', splitStatements(tagged).map(s => s.text), ['DO $tag$ BEGIN; END; $tag$', 'select 9'])

console.log('statementAt')
const doc = 'select 1;\nselect 2;\nselect 3'
eq('caret in first', statementAt(doc, 3)?.text, 'select 1')
eq('caret in second', statementAt(doc, 14)?.text, 'select 2')
eq('caret in third', statementAt(doc, 22)?.text, 'select 3')
eq('caret at end', statementAt(doc, doc.length)?.text, 'select 3')

console.log('maskLiterals')
eq('masks string content', maskLiterals("select 'from users' from t").includes('users'), false)
eq('preserves length', maskLiterals("select 'abc' from t").length, "select 'abc' from t".length)
eq('keeps real keywords', maskLiterals("select 'x' from t").trimEnd().endsWith('from t'), true)

console.log('audit regressions — statement boundaries')
{
  // A caret in the blank line between statements must not execute the LAST
  // statement in the buffer.
  const doc = 'SELECT 1;\n\nSELECT 2;\n\nDROP TABLE important;'
  eq('caret in first gap runs the preceding statement', statementAt(doc, 10)?.text, 'SELECT 1')
  eq('caret in second gap runs the preceding statement', statementAt(doc, 21)?.text, 'SELECT 2')
  eq('caret at the very end still runs the last', statementAt(doc, doc.length)?.text, 'DROP TABLE important')
  eq('caret before everything runs the first', statementAt(doc, 0)?.text, 'SELECT 1')
}
{
  // standard_conforming_strings=on: a trailing backslash does NOT escape the
  // closing quote, so the following statement must stay separate.
  const doc = String.raw`SELECT 'C:\Users\'; DELETE FROM t WHERE id = 1;`
  eq('backslash does not swallow the next statement', splitStatements(doc).length, 2)
  eq('  second statement intact', splitStatements(doc)[1].text, 'DELETE FROM t WHERE id = 1')
}
{
  // In an E'' literal backslash IS an escape.
  const doc = String.raw`SELECT E'a\'b'; SELECT 2`
  eq('E-string honours backslash escapes', splitStatements(doc).length, 2)
}

console.log('audit regressions — masking')
eq('apostrophe inside a quoted identifier does not blank the statement',
   maskLiterals(`SELECT * FROM "o'brien" WHERE id = 1`).includes('WHERE'), true)
eq('nested block comments are fully masked',
   maskLiterals('SELECT /* a /* b */ c */ 1').includes('c'), false)
eq('string content is still masked',
   maskLiterals("SELECT 'from users' FROM t").includes('users'), false)

console.log('audit regressions — comma-separated table lists')
eq('comma self-join counts twice', countTableReferences('select * from s.t a, s.t b where a.p = b.i'), 2)
eq('three comma refs', countTableReferences('select * from a, b, c'), 3)
eq('comma list mixed with join', countTableReferences('select * from a, b join c on 1=1'), 3)
eq('set-returning function is not a table', countTableReferences('select * from n, generate_series(1,2) g'), 1)
eq('subquery in FROM is not a table', countTableReferences('select * from (select 1) x'), 0)
eq('quoted identifiers are seen', countTableReferences('select * from "o\'x" a join "o\'x" b on 1=1'), 2)

console.log('countTableReferences')
eq('single table', countTableReferences('select * from users'), 1)
eq('join of two', countTableReferences('select * from a join b on a.id=b.id'), 2)
eq('self-join counts twice', countTableReferences('select * from t a join t b on a.id<>b.id'), 2)
eq('three-way join', countTableReferences('select * from a join b on 1=1 join c on 1=1'), 3)
eq('update counts', countTableReferences('update t set x=1'), 1)
eq('insert counts', countTableReferences('insert into t (a) values (1)'), 1)
eq('table name inside a string is ignored', countTableReferences("select 'from x' from t"), 1)
eq('table name inside a comment is ignored', countTableReferences('select 1 -- from x\nfrom t'), 1)
eq('no tables', countTableReferences('select 1'), 0)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
