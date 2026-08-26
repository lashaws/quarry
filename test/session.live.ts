/**
 * Exercises the real Session against live Postgres. This layer had no automated
 * coverage, which is exactly why a connection-wide deadlock went unnoticed.
 * Creates and drops its own `quarry_session` schema.
 */
import { Session } from '../src/main/session.ts'
import { saveConnection } from '../src/main/store/connections.ts'
import { testConnection } from './fixture.ts'
import type { QueryResult } from '@shared/ipc'

type QueryResultLike = Pick<QueryResult, 'fields' | 'rows'>
import { emptyEdits } from '@shared/ipc'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, extra = ''): void => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? '\n       ' + extra : ''}`) }
}

/** Fails loudly instead of hanging forever, which is what a deadlock does. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_r, rej) => setTimeout(() => rej(new Error(`TIMEOUT after ${ms}ms: ${what}`)), ms))
  ])
}

const { cfg, password } = testConnection('session-test')

const session = new Session()

async function main(): Promise<void> {
  saveConnection(cfg, password)
  await session.connect(cfg)
  await session.catalog(cfg.id, true)

  const run = (sql: string) => session.run({ connectionId: cfg.id, sql }, 'test')

  await run('DROP SCHEMA IF EXISTS quarry_session CASCADE')
  await run('CREATE SCHEMA quarry_session')
  await run('CREATE TABLE quarry_session.big (id serial PRIMARY KEY, v text, note text DEFAULT (chr(100)))')
  await run(`INSERT INTO quarry_session.big (v) SELECT 'row-' || g FROM generate_series(1, 3000) g`)
  await run('CREATE TABLE quarry_session.nopk (v text)')
  await run(`INSERT INTO quarry_session.nopk SELECT 'x-' || g FROM generate_series(1, 3000) g`)

  console.log('deadlock: an open cursor must not wedge the connection')
  {
    // A result with no resolvable edit target is the ordinary trigger: it sends
    // the catalog refresh down the same connection the cursor is holding.
    const r = await withTimeout(run('SELECT v FROM quarry_session.nopk ORDER BY v'), 8000,
      'SELECT from a table with no primary key')
    ok('a >500-row result with no PK returns', !r.error, r.error?.message)
    ok('  it is read-only', r.editable === null)
    ok('  first chunk only', r.rows.length === 500, String(r.rows.length))

    const after = await withTimeout(run('SELECT 1 AS ok'), 8000, 'statement issued after an open cursor')
    ok('a following statement is not blocked', after.rows[0]?.[0] === '1', JSON.stringify(after.rows))
  }
  {
    const r = await withTimeout(run('SELECT * FROM quarry_session.big ORDER BY id'), 8000, 'big select')
    ok('editable big result returns', r.editable !== null)
    const more = await withTimeout(session.fetchMore(r.queryId, 500), 8000, 'fetchMore')
    ok('  fetchMore works while the cursor is ours', more.rows.length === 1000, String(more.rows.length))

    // Commit/export/submit all used to hang here.
    await withTimeout(session.setTxMode(cfg.id, 'manual'), 8000, 'setTxMode with open cursor')
    await withTimeout(run('SELECT 1'), 8000, 'statement after mode switch')
    await withTimeout(session.commit(cfg.id), 8000, 'commit with open cursor')
    await withTimeout(session.setTxMode(cfg.id, 'auto'), 8000, 'back to auto')
    ok('commit/setTxMode do not deadlock', true)

    const big = await withTimeout(run('SELECT * FROM quarry_session.big ORDER BY id'), 8000, 'big select 2')
    await withTimeout(session.catalog(cfg.id, true), 8000, 'catalog refresh with open cursor')
    ok('catalog refresh does not deadlock', true)
    void big
  }

  console.log('\nrunScript')
  {
    const results = await withTimeout(
      session.runScript(
        { connectionId: cfg.id, sql: `SELECT * FROM quarry_session.big ORDER BY id;\nSELECT count(*) FROM quarry_session.big;` },
        'test'
      ),
      15000,
      'script whose first statement returns >500 rows'
    )
    ok('both statements ran', results.length === 2, String(results.length))
    ok('  the second is not blocked by the first', results[1]?.rows[0]?.[0] === '3000',
       JSON.stringify(results[1]?.rows ?? results[1]?.error))
  }
  {
    const results = await withTimeout(
      session.runScript({ connectionId: cfg.id, sql: 'SELECT 1; SELECT * FROM nope.nope; SELECT 3' }, 'test'),
      8000, 'script with a failure'
    )
    ok('stops at the first failure', results.length === 2 && !!results[1].error)
  }

  console.log('\nexport must not re-execute the statement')
  {
    const before = await run('SELECT count(*) FROM quarry_session.big')
    const r = await run(`INSERT INTO quarry_session.big (v) VALUES ('exported') RETURNING id, v`)
    ok('RETURNING gives rows', r.rows.length === 1, JSON.stringify(r.rows))

    const file = join(tmpdir(), 'quarry-export-test.csv')
    await withTimeout(session.exportCsv(r.queryId, file), 8000, 'exportCsv')
    const after = await run('SELECT count(*) FROM quarry_session.big')
    ok('exporting a RETURNING result does not insert again',
       Number(after.rows[0][0]) === Number(before.rows[0][0]) + 1,
       `${before.rows[0][0]} -> ${after.rows[0][0]}`)
    const csv = readFileSync(file, 'utf8').trim().split('\n')
    ok('  csv has a header and one row', csv.length === 2, JSON.stringify(csv))
    rmSync(file, { force: true })
  }
  {
    const r = await run('SELECT * FROM quarry_session.big ORDER BY id')
    const file = join(tmpdir(), 'quarry-export-all.csv')
    const res = await withTimeout(session.exportCsv(r.queryId, file), 15000, 'export full result')
    ok('export drains the whole cursor, not just the first chunk', res.rows === 3001, String(res.rows))
    rmSync(file, { force: true })
  }

  console.log('\nsubmit')
  {
    const r = await run('SELECT id, v FROM quarry_session.big ORDER BY id LIMIT 5')
    const target = r.editable
    ok('result is editable', !!target)

    // The addressed row disappears before submit.
    const victim = r.rows[0][0]
    await run(`DELETE FROM quarry_session.big WHERE id = ${victim}`)
    const res = await session.submit(r.queryId, {
      ...emptyEdits(),
      updates: [{ rowIndex: 0, columnIndex: 1, oldValue: r.rows[0][1], newValue: 'ghost' }]
    })
    ok('an update matching no rows is reported as a failure', res.ok === false, JSON.stringify(res))
    ok('  and says why', /no longer exists/i.test(res.error ?? ''), res.error)
  }
  {
    const r = await run('SELECT id, v, note FROM quarry_session.big ORDER BY id LIMIT 3')
    const res = await session.submit(r.queryId, {
      ...emptyEdits(),
      inserts: [{ id: 'n1', values: { 1: 'inserted', 2: null } }]
    })
    ok('insert with an explicit NULL succeeds', res.ok, res.error)
    const check = await run(`SELECT note FROM quarry_session.big WHERE v = 'inserted'`)
    ok('  the NULL is stored, not the column default', check.rows[0][0] === null, JSON.stringify(check.rows))
  }

  console.log('\nexplain')
  {
    // explainPlan is the only shipped path; testing a textual explain that the
    // UI never calls is what let a transaction bug through unnoticed.
    const p = await withTimeout(
      session.explainPlan(cfg.id, 'SELECT * FROM quarry_session.big', false), 8000, 'explain'
    )
    ok('explain returns a plan tree', /Scan/i.test(p.nodeType), p.nodeType)
  }

  console.log('\ndata-modifying CTE')
  {
    const r = await run(`WITH moved AS (
      UPDATE quarry_session.big SET v = 'cte' WHERE v = 'inserted' RETURNING id
    ) SELECT count(*) FROM moved`)
    ok('a WITH ... UPDATE runs and returns its rows', !r.error, r.error?.message)
    ok('  and reports the count', r.rows[0]?.[0] === '1', JSON.stringify(r.rows))
  }

  console.log('\nDBA diagnostics')
  {
    const list = session.dbaQueries()
    ok('diagnostics are listed', list.length >= 10, String(list.length))
    let bad: string[] = []
    for (const q of list) {
      const r = await withTimeout(session.dba(cfg.id, q.key, 'test'), 10000, `dba:${q.key}`)
      // A missing extension is reported as a clean error, not a crash.
      if (r.error && !q.requires) bad.push(`${q.key}: ${r.error.message}`)
      if (r.error && q.requires) {
        ok(`  ${q.key} degrades cleanly without ${q.requires}`,
           /extension/i.test(r.error.message) && /CREATE EXTENSION/i.test(r.error.hint ?? ''),
           r.error.message)
      }
    }
    ok('every diagnostic without a dependency runs', bad.length === 0, bad.join(' | '))
  }
  {
    let threw = false
    try { await session.dba(cfg.id, 'nope', 'test') } catch { threw = true }
    ok('an unknown diagnostic is rejected', threw)
  }

  console.log('\nexplain plan tree')
  {
    const p = await withTimeout(
      session.explainPlan(cfg.id, 'SELECT * FROM quarry_session.big WHERE v = $$x$$', false),
      8000, 'explainPlan'
    )
    ok('plan parses', !!p.nodeType, JSON.stringify(p).slice(0, 80))
    ok('  costs present', p.totalCost > 0)
    const a = await withTimeout(
      session.explainPlan(cfg.id, 'SELECT count(*) FROM quarry_session.big', true),
      8000, 'explainPlan analyze'
    )
    ok('analyze adds timings', a.elapsedMs !== undefined, String(a.elapsedMs))
    ok('  self time computed', a.selfMs !== undefined && a.selfMs >= 0, String(a.selfMs))
  }

  console.log('\nEXPLAIN ANALYZE respects manual commit')
  {
    // ANALYZE really runs the statement. Routing it through a non-transactional
    // path made the write durable in manual mode, with nothing to roll back.
    await run('CREATE TABLE quarry_session.tx (id int PRIMARY KEY, v text)')
    await run(`INSERT INTO quarry_session.tx VALUES (1, 'original')`)
    await session.setTxMode(cfg.id, 'manual')
    await withTimeout(
      session.explainPlan(cfg.id, `UPDATE quarry_session.tx SET v = 'changed' WHERE id = 1`, true),
      8000, 'explain analyze of DML'
    )
    ok('a DML explain opens the transaction', session.openTransactions().length === 1,
       JSON.stringify(session.state(cfg.id)))
    await session.rollback(cfg.id)
    const after = await run('SELECT v FROM quarry_session.tx WHERE id = 1')
    ok('  and rollback undoes it', after.rows[0][0] === 'original', JSON.stringify(after.rows))

    // A plain EXPLAIN executes nothing and must not open a transaction on its
    // own. Roll back first: the SELECT above already opened one.
    await session.rollback(cfg.id)
    await withTimeout(session.explainPlan(cfg.id, 'SELECT * FROM quarry_session.tx', false), 8000, 'plain explain')
    ok('a plain explain opens no transaction', session.openTransactions().length === 0,
       JSON.stringify(session.state(cfg.id)))
    await session.setTxMode(cfg.id, 'auto')
  }

  console.log('\nDBA query correctness')
  {
    await run('CREATE EXTENSION IF NOT EXISTS btree_gist')
    await run(`CREATE TABLE quarry_session.rooms (id int PRIMARY KEY, room int, during tsrange,
                 EXCLUDE USING gist (room WITH =, during WITH &&))`)
    await run('CREATE TABLE quarry_session.part (id int, d date) PARTITION BY RANGE (d)')
    await run(`CREATE TABLE quarry_session.part_2020 PARTITION OF quarry_session.part
                 FOR VALUES FROM ('2020-01-01') TO ('2021-01-01')`)
    await run('CREATE INDEX part_d_idx ON quarry_session.part (d)')
    await run('CREATE TABLE quarry_session.expr (a text, b text)')
    await run('CREATE INDEX expr_lower_a ON quarry_session.expr (lower(a))')
    await run('CREATE INDEX expr_upper_b ON quarry_session.expr (upper(b))')
    await run('CREATE TABLE quarry_session.partial (id int PRIMARY KEY, uid int, prim bool)')
    await run('CREATE INDEX partial_uid ON quarry_session.partial (uid)')
    await run('CREATE UNIQUE INDEX partial_uid_primary ON quarry_session.partial (uid) WHERE prim')
    await run('CREATE TABLE quarry_session.dupe (id int PRIMARY KEY, x int)')
    await run('CREATE INDEX dupe_x_a ON quarry_session.dupe (x)')
    await run('CREATE INDEX dupe_x_b ON quarry_session.dupe (x)')

    const col = (r: QueryResultLike, name: string): number =>
      r.fields.findIndex((f) => f.name === name)
    const mine = (r: QueryResultLike): string[][] =>
      r.rows.filter((row) => row[col(r, 'schema')] === 'quarry_session') as string[][]

    const unused = await session.dba(cfg.id, 'unused_indexes', 'test')
    const offered = mine(unused).map((row) => row[col(unused, 'index')])
    // DROP INDEX is refused for both of these; offering it hands the user a
    // statement that cannot run.
    ok('unused_indexes excludes exclusion-constraint indexes',
       !offered.some((n) => String(n).includes('excl')), JSON.stringify(offered))
    ok('unused_indexes excludes attached partition indexes',
       !offered.some((n) => String(n).startsWith('part_2020')), JSON.stringify(offered))
    ok('  but still offers a genuinely droppable index', offered.includes('dupe_x_a'), JSON.stringify(offered))

    const dup = await session.dba(cfg.id, 'duplicate_indexes', 'test')
    const groups = mine(dup).map((row) => String(row[col(dup, 'indexes')]))
    // indkey ignores predicates, opclasses and expressions.
    ok('different expression indexes are not called duplicates',
       !groups.some((g) => g.includes('expr_lower_a')), JSON.stringify(groups))
    ok('a unique partial index is not called a duplicate',
       !groups.some((g) => g.includes('partial_uid_primary')), JSON.stringify(groups))
    ok('a genuine duplicate is still reported',
       groups.some((g) => g === 'dupe_x_a, dupe_x_b'), JSON.stringify(groups))
    const dupeRow = mine(dup).find((row) => String(row[col(dup, 'indexes')]) === 'dupe_x_a, dupe_x_b')
    // One index is kept, so only the other is recoverable.
    ok('  recoverable space counts only the droppable copy',
       Number(dupeRow?.[col(dup, 'recoverable_bytes')]) > 0 &&
       Number(dupeRow?.[col(dup, 'recoverable_bytes')]) <= 16384,
       String(dupeRow?.[col(dup, 'recoverable_bytes')]))

    const vac = await session.dba(cfg.id, 'vacuum', 'test')
    const parent = mine(vac).find((row) => row[col(vac, 'table')] === 'part')
    // relfrozenxid is 0 on a partitioned parent; age(0) is the maximum and would
    // sort it to the top looking like imminent wraparound.
    ok('a partitioned parent reports no xid age',
       parent !== undefined && parent[col(vac, 'xid_age')] === null,
       JSON.stringify(parent?.[col(vac, 'xid_age')]))
    ok('  and TOAST age is reported alongside', col(vac, 'toast_xid_age') >= 0)

    const sessions = await session.dba(cfg.id, 'sessions', 'test')
    ok('sessions runs', !sessions.error, sessions.error?.message)
    const locks = await session.dba(cfg.id, 'locks', 'test')
    ok('locks distinguishes locktype from relation',
       col(locks, 'locktype') >= 0 && col(locks, 'relation') >= 0)
  }

  console.log('\nopen transaction tracking')
  {
    await session.setTxMode(cfg.id, 'manual')
    await run('SELECT 1')
    ok('an open transaction is visible to the quit guard', session.openTransactions().length === 1)
    await session.rollback(cfg.id)
    ok('  and clears on rollback', session.openTransactions().length === 0)

    // Commit on an aborted transaction must not claim success.
    await run('SELECT 1')
    await run('SELECT 1/0')
    let threw = ''
    try { await session.commit(cfg.id) } catch (e) { threw = (e as Error).message }
    ok('commit after a failed statement reports the rollback', /rolled back/i.test(threw), threw)
    await session.setTxMode(cfg.id, 'auto')
  }
}

main()
  .catch((e) => { fail++; console.error('\nUNCAUGHT:', (e as Error).message) })
  .finally(async () => {
    try {
      await session.run({ connectionId: cfg.id, sql: 'DROP SCHEMA IF EXISTS quarry_session CASCADE' }, 'cleanup')
    } catch { /* best effort */ }
    await session.shutdown()
    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
  })
