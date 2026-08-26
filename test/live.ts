/**
 * Driver and introspection checks against a live Postgres.
 *
 * Everything is asserted against a fixture this suite builds for itself, so it
 * runs on whatever database the PG* environment variables point at and touches
 * nothing that was already there.
 */
import { introspect } from '../src/main/introspect/postgres.ts'
import { resolveEditTarget } from '../src/main/query/editable.ts'
import { buildChanges, renderPreview } from '../src/main/query/dml.ts'
import { renderDdl } from '../src/main/query/ddl.ts'
import { connect, createFixture, dropFixture, EXPECTED, SCHEMA, SCHEMA_B } from './fixture.ts'
import type { PgConnection } from '../src/main/drivers/postgres.ts'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, extra = ''): void => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? '\n       ' + extra : ''}`) }
}

let conn: PgConnection

async function main(): Promise<void> {
  console.log('connect')
  conn = await connect()
  ok('connected', conn.connected)
  ok('server version reported', !!conn.serverVersion, conn.serverVersion)
  await createFixture(conn)

  const cmd = async (sql: string) => {
    const { chunk, cursor } = await conn.start(sql, 100)
    if (cursor) await conn.closeCursor(cursor)
    return chunk
  }

  console.log('\nintrospection')
  const catalog = await introspect(conn)
  const main_ = catalog.schemas.find((s) => s.name === SCHEMA)
  const other = catalog.schemas.find((s) => s.name === SCHEMA_B)
  ok('fixture schemas are introspected', !!main_ && !!other)
  ok('exactly the fixture relations are introspected',
     JSON.stringify(main_?.tables.map((t) => t.name).sort()) === JSON.stringify(EXPECTED.relationsInMain),
     JSON.stringify(main_?.tables.map((t) => t.name).sort()))
  ok('the second schema holds its one table',
     JSON.stringify(other?.tables.map((t) => t.name)) === JSON.stringify(EXPECTED.relationsInB))

  const link = main_!.tables.find((t) => t.name === 'link')!
  ok('primary key introspected', JSON.stringify(link.primaryKey) === '["link_id"]', JSON.stringify(link.primaryKey))
  ok('foreign keys introspected', link.foreignKeys.length === 2, String(link.foreignKeys.length))
  ok('FK resolves across schemas',
     link.foreignKeys.some((f) => f.refSchema === SCHEMA_B && f.refTable === 'vendor' && f.refColumns[0] === 'vendor_id'),
     JSON.stringify(link.foreignKeys.map((f) => `${f.columns}->${f.refSchema}.${f.refTable}`)))
  ok('indexes introspected', link.indexes.length >= 3, String(link.indexes.length))
  ok('column types resolved', link.columns.find((c) => c.name === 'link_id')?.dataType === 'uuid')
  ok('NOT NULL captured', link.columns.find((c) => c.name === 'is_primary')?.nullable === false)
  ok('nullable column captured', link.columns.find((c) => c.name === 'note')?.nullable === true)
  ok('table comment captured', link.comment === 'Joins an owner to a vendor', String(link.comment))
  ok('column comment captured', link.columns.find((c) => c.name === 'owner_id')?.comment === 'FK to owner')
  ok('views are introspected', main_!.tables.some((t) => t.name === 'link_view' && t.kind === 'view'))

  console.log('\neditability (the DataGrip rule)')
  const target = (sql: string) =>
    conn.start(sql, 10).then(async ({ chunk, cursor }) => {
      if (cursor) await conn.closeCursor(cursor)
      return resolveEditTarget(catalog, (oid) => conn.tableFor(oid), chunk, sql)
    })

  const single = await target(`SELECT * FROM ${SCHEMA}.link LIMIT 5`)
  ok('single-table select is editable', single !== null)
  ok('  correct table', single?.table === 'link', single?.table)
  ok('  correct PK', JSON.stringify(single?.pkColumns) === '["link_id"]')

  ok('join result is read-only',
     (await target(`SELECT l.*, v.vendor_id AS vid FROM ${SCHEMA}.link l
                    JOIN ${SCHEMA_B}.vendor v ON v.vendor_id = l.vendor_id LIMIT 5`)) === null)
  ok('aggregate is read-only', (await target(`SELECT count(*) FROM ${SCHEMA}.link`)) === null)
  ok('select without the PK is read-only', (await target(`SELECT owner_id FROM ${SCHEMA}.link LIMIT 5`)) === null)
  ok('a table with no primary key is read-only', (await target(`SELECT v FROM ${SCHEMA}.nopk LIMIT 5`)) === null)
  ok('a view is read-only', (await target(`SELECT * FROM ${SCHEMA}.link_view LIMIT 5`)) === null)
  ok('expression column does not break detection',
     (await target(`SELECT *, 1 AS extra FROM ${SCHEMA}.link LIMIT 5`)) !== null)

  // A self-join reports ONE relation oid for both aliases, so the oid check
  // alone marks it editable — and an UPDATE keyed on one alias's primary key
  // would silently write to the wrong row.
  ok('self-join is read-only',
     (await target(`SELECT a.*, b.link_id AS other FROM ${SCHEMA}.link a
                      JOIN ${SCHEMA}.link b ON b.link_id <> a.link_id LIMIT 3`)) === null)
  ok('comma self-join is read-only',
     (await target(`SELECT a.link_id, b.note FROM ${SCHEMA}.link a, ${SCHEMA}.link b
                     WHERE a.link_id <> b.link_id LIMIT 3`)) === null)
  ok('the same column selected twice is read-only',
     (await target(`SELECT link_id, link_id AS again, note FROM ${SCHEMA}.link LIMIT 3`)) === null)
  ok('UNION is read-only',
     (await target(`SELECT link_id, note FROM ${SCHEMA}.link
                    UNION ALL SELECT link_id, note FROM ${SCHEMA}.link LIMIT 3`)) === null)
  // These collapse nothing when the primary key is present: each row still maps
  // 1:1 to a source row, so they stay editable.
  ok('DISTINCT with the PK present stays editable',
     (await target(`SELECT DISTINCT link_id, note FROM ${SCHEMA}.link LIMIT 3`)) !== null)
  ok('GROUP BY the PK stays editable',
     (await target(`SELECT link_id, note FROM ${SCHEMA}.link GROUP BY link_id, note LIMIT 3`)) !== null)

  console.log('\nchunked reads')
  {
    const { chunk, cursor } = await conn.start(`SELECT * FROM ${SCHEMA}.wide ORDER BY id`, 500)
    ok('first chunk is 500 rows', chunk.rows.length === 500, String(chunk.rows.length))
    ok('not complete', chunk.complete === false)
    ok('cursor held open', cursor !== null)
    const second = await conn.readMore(cursor!, 500)
    ok('second chunk is 500 rows', second.rows.length === 500, String(second.rows.length))
    const third = await conn.readMore(cursor!, 1200)
    ok('final chunk drains the remainder', third.rows.length === EXPECTED.rowsInWide - 1000, String(third.rows.length))
    ok('marked complete', third.complete === true)
    await conn.closeCursor(cursor!)
  }
  {
    const nulls = await conn.start(`SELECT NULL::text AS a, ''::text AS b`, 10)
    ok('NULL crosses IPC as null', nulls.chunk.rows[0][0] === null)
    ok('empty string stays a string', nulls.chunk.rows[0][1] === '')
    if (nulls.cursor) await conn.closeCursor(nulls.cursor)
  }

  console.log('\ngrid edits and rollback')
  {
    await conn.setTxMode('manual')
    const sel = await conn.start(`SELECT id, label, n FROM ${SCHEMA}.wide ORDER BY id LIMIT 3`, 10)
    if (sel.cursor) await conn.closeCursor(sel.cursor)
    ok('transaction opened lazily', conn.txStatus === 'active', conn.txStatus)

    const et = resolveEditTarget(await introspect(conn), (oid) => conn.tableFor(oid), sel.chunk,
      `SELECT id, label, n FROM ${SCHEMA}.wide ORDER BY id LIMIT 3`)
    ok('the fixture select is editable', et !== null)

    const changes = buildChanges(et!, sel.chunk.rows, {
      updates: [
        { rowIndex: 0, columnIndex: 1, oldValue: 'row-1', newValue: "o'brien" },
        { rowIndex: 0, columnIndex: 2, oldValue: '2', newValue: '99' },
        { rowIndex: 2, columnIndex: 1, oldValue: 'row-3', newValue: 'third' }
      ],
      inserts: [],
      deletes: []
    })
    ok('one UPDATE per touched row', changes.length === 2, String(changes.length))
    ok('combines two SETs for one row', (changes[0].sql.match(/=/g) ?? []).length === 3, changes[0].sql)
    ok('addresses the row by primary key', changes[0].sql.includes('WHERE "id" = $3'), changes[0].sql)
    ok('preview escapes quotes', renderPreview(changes[0]).includes("'o''brien'"), renderPreview(changes[0]))

    for (const c of changes) await conn.execute(c.sql, c.params)
    const after = await conn.query(`SELECT label, n FROM ${SCHEMA}.wide WHERE id = 1`)
    ok('update applied in the transaction', after[0].label === "o'brien" && Number(after[0].n) === 99,
       JSON.stringify(after[0]))

    await conn.rollback()
    ok('transaction closed', conn.txStatus === 'idle', conn.txStatus)
    const reverted = await conn.query(`SELECT label, n FROM ${SCHEMA}.wide WHERE id = 1`)
    ok('ROLLBACK reverted the row', reverted[0].label === 'row-1' && Number(reverted[0].n) === 2,
       JSON.stringify(reverted[0]))
    await conn.setTxMode('auto')
  }

  // Regression: grid submits in manual mode must join the user's transaction.
  // They previously ran in autocommit, so Rollback had nothing to undo.
  console.log('\nmanual-commit isolation')
  {
    await conn.setTxMode('manual')
    await conn.execute(`UPDATE ${SCHEMA}.wide SET label = 'staged' WHERE id = 2`, [])
    ok('execute() opens the transaction', conn.txStatus === 'active', conn.txStatus)

    const observer = await connect()
    const seen = await observer.query(`SELECT label FROM ${SCHEMA}.wide WHERE id = 2`)
    ok('another session cannot see it before commit', seen[0].label === 'row-2', String(seen[0].label))

    await conn.rollback()
    const undone = await conn.query(`SELECT label FROM ${SCHEMA}.wide WHERE id = 2`)
    ok('rollback undoes the grid submit', undone[0].label === 'row-2', String(undone[0].label))

    await conn.execute(`UPDATE ${SCHEMA}.wide SET label = 'kept' WHERE id = 2`, [])
    await conn.commit()
    const committed = await observer.query(`SELECT label FROM ${SCHEMA}.wide WHERE id = 2`)
    ok('commit makes it visible elsewhere', committed[0].label === 'kept', String(committed[0].label))
    await observer.disconnect()
    await conn.setTxMode('auto')
  }

  console.log('\nDDL / DML surface')
  ok('CREATE TABLE reports CREATE',
     (await cmd(`CREATE TABLE ${SCHEMA}.g (id serial PRIMARY KEY, name text, qty int)`)).command === 'CREATE')
  ok('ALTER TABLE reports ALTER',
     (await cmd(`ALTER TABLE ${SCHEMA}.g ADD COLUMN note text`)).command === 'ALTER')
  ok('CREATE INDEX reports CREATE',
     (await cmd(`CREATE INDEX idx_g_name ON ${SCHEMA}.g (name)`)).command === 'CREATE')

  const ins = await cmd(`INSERT INTO ${SCHEMA}.g (name, qty) VALUES ('a', 1), ('b', 2), ('c', 3)`)
  ok('INSERT reports affected rows', ins.command === 'INSERT' && ins.rowCount === 3, `${ins.command}/${ins.rowCount}`)

  const ret = await cmd(`INSERT INTO ${SCHEMA}.g (name, qty) VALUES ('d', 4) RETURNING id, name`)
  ok('INSERT ... RETURNING yields rows', ret.rows.length === 1 && ret.rows[0][1] === 'd', JSON.stringify(ret.rows))

  const upd = await cmd(`UPDATE ${SCHEMA}.g SET qty = qty * 10 WHERE name IN ('a','b')`)
  ok('UPDATE reports affected rows', upd.command === 'UPDATE' && upd.rowCount === 2, `${upd.command}/${upd.rowCount}`)

  const del = await cmd(`DELETE FROM ${SCHEMA}.g WHERE name = 'c'`)
  ok('DELETE reports affected rows', del.command === 'DELETE' && del.rowCount === 1, `${del.command}/${del.rowCount}`)

  console.log('\ncomplex queries')
  {
    const cte = await cmd(`
      WITH ranked AS (
        SELECT name, qty, row_number() OVER (ORDER BY qty DESC) AS rn,
               sum(qty) OVER () AS total
          FROM ${SCHEMA}.g
      )
      SELECT name, qty, rn, total FROM ranked WHERE rn <= 2 ORDER BY rn`)
    ok('CTE + window functions run', cte.rows.length === 2, JSON.stringify(cte.rows))
    ok('  window ordering correct', cte.rows[0][2] === '1')

    const sub = await cmd(`SELECT name FROM ${SCHEMA}.g
                            WHERE qty > (SELECT avg(qty) FROM ${SCHEMA}.g) ORDER BY name`)
    ok('scalar subquery runs', sub.rows.length >= 1, JSON.stringify(sub.rows))

    const agg = await cmd(`SELECT count(*) AS n, coalesce(sum(qty),0) AS s FROM ${SCHEMA}.g`)
    ok('aggregates run', agg.rows[0][0] === '3', JSON.stringify(agg.rows))
  }

  console.log('\nnotices')
  await cmd(`DO $$ BEGIN RAISE NOTICE 'hello from plpgsql'; END $$`)
  {
    const notices = conn.takeNotices()
    ok('RAISE NOTICE is captured', notices.some((n) => n.includes('hello from plpgsql')), JSON.stringify(notices))
  }

  console.log('\nDDL round-trip')
  {
    const cat = await introspect(conn)
    const meta = cat.schemas.find((s) => s.name === SCHEMA)!.tables.find((t) => t.name === 'g')!
    const ddl = renderDdl(meta)
    ok('DDL mentions every column', meta.columns.every((c) => ddl.includes(c.name)), ddl)
    // A serial column introspects as `integer DEFAULT nextval(...)`; emitting
    // that verbatim yields DDL that cannot be replayed.
    ok('serial columns collapse', ddl.includes('id serial') && !ddl.includes('nextval'), ddl)

    await cmd('CREATE SCHEMA IF NOT EXISTS quarry_roundtrip')
    const moved = ddl.replace(new RegExp(SCHEMA, 'g'), 'quarry_roundtrip').replace(/idx_g_name/g, 'idx_g_name_rt')
    for (const stmt of moved.split(';\n').map((x) => x.trim()).filter(Boolean)) {
      await conn.execute(stmt.replace(/;$/, ''), [])
    }
    const rt = await introspect(conn)
    const copy = rt.schemas.find((s) => s.name === 'quarry_roundtrip')?.tables.find((t) => t.name === 'g')
    ok('generated DDL executes against Postgres', !!copy)
    ok('  same column count', copy?.columns.length === meta.columns.length, `${copy?.columns.length} vs ${meta.columns.length}`)
    ok('  primary key preserved', JSON.stringify(copy?.primaryKey) === JSON.stringify(meta.primaryKey))
    await conn.execute('DROP SCHEMA IF EXISTS quarry_roundtrip CASCADE', [])
  }

  console.log('\nTRUNCATE / DROP')
  ok('TRUNCATE reports TRUNCATE', (await cmd(`TRUNCATE ${SCHEMA}.g`)).command === 'TRUNCATE')
  ok('  table is empty', (await cmd(`SELECT count(*) FROM ${SCHEMA}.g`)).rows[0][0] === '0')
  ok('DROP TABLE reports DROP', (await cmd(`DROP TABLE ${SCHEMA}.g`)).command === 'DROP')

  console.log('\ncancellation')
  {
    let message = ''
    // Attach the handler at creation, as every real caller does via await.
    const slow = conn.start('SELECT pg_sleep(10)', 10).catch((e: Error) => { message = e.message })
    await new Promise((r) => setTimeout(r, 400))
    await conn.cancelRunning()
    await slow
    ok('a long query cancels', /cancel/i.test(message), message)
  }

  console.log('\nerror reporting')
  try {
    await conn.start(`SELECT * FROM ${SCHEMA}.link WHERE zzz = 1`, 10)
    ok('error surfaced', false)
  } catch (e) {
    const err = e as { message: string; position?: string }
    ok('error surfaced', true)
    ok('error carries a character position', !!err.position, JSON.stringify(err.position))
  }
}

main()
  .catch((e) => { fail++; console.error('\nUNCAUGHT:', e) })
  .finally(async () => {
    if (conn?.connected) {
      await conn.setTxMode('auto').catch(() => undefined)
      await conn.execute('DROP SCHEMA IF EXISTS quarry_roundtrip CASCADE', []).catch(() => undefined)
      await dropFixture(conn).catch(() => undefined)
      await conn.disconnect()
    }
    console.log('\n(fixture dropped)')
    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
  })
