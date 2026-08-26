/**
 * A self-contained schema the live tests build for themselves.
 *
 * The suites used to assert against whatever database happened to be on the
 * developer's machine, which made them unrunnable by anyone else and leaked the
 * shape of a private schema into the repository. Everything they need is
 * created here and dropped afterwards.
 */
import type { ConnectionConfig } from '@shared/ipc'
import { PgConnection } from '../src/main/drivers/postgres.ts'

export const SCHEMA = 'quarry_fixture'
export const SCHEMA_B = 'quarry_fixture_b'

/** Connection settings come from the standard PG* variables. */
export function testConnection(id = 'test'): { cfg: ConnectionConfig; password: string } {
  const env = process.env
  return {
    cfg: {
      id,
      name: 'Quarry test',
      engine: 'postgres',
      host: env.PGHOST ?? 'localhost',
      port: Number(env.PGPORT ?? 5432),
      database: env.PGDATABASE ?? 'postgres',
      user: env.PGUSER ?? 'postgres'
    },
    password: env.PGPASSWORD ?? 'postgres'
  }
}

export function connect(): Promise<PgConnection> {
  const { cfg, password } = testConnection()
  const conn = new PgConnection(cfg, password)
  return conn.connect().then(() => conn)
}

/** What the fixture contains, so the tests assert against it rather than a total. */
export const EXPECTED = {
  schemas: 2,
  /** every relation created in SCHEMA, views included */
  relationsInMain: ['link', 'link_view', 'nopk', 'owner', 'wide'],
  relationsInB: ['vendor'],
  rowsInWide: 2000
}

export async function createFixture(conn: PgConnection): Promise<void> {
  await dropFixture(conn)
  await conn.execute(`CREATE SCHEMA ${SCHEMA}`, [])
  await conn.execute(`CREATE SCHEMA ${SCHEMA_B}`, [])

  // Referenced from another schema, to prove cross-schema FK introspection.
  await conn.execute(
    `CREATE TABLE ${SCHEMA_B}.vendor (
       vendor_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       vendor_name text NOT NULL
     )`, [])
  await conn.execute(`COMMENT ON TABLE ${SCHEMA_B}.vendor IS 'Fixture vendor table'`, [])

  await conn.execute(
    `CREATE TABLE ${SCHEMA}.owner (
       owner_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       label text NOT NULL,
       created_at timestamptz NOT NULL DEFAULT now()
     )`, [])

  // The editability workhorse: a PK, two FKs, a NOT NULL and a few indexes.
  await conn.execute(
    `CREATE TABLE ${SCHEMA}.link (
       link_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       owner_id uuid NOT NULL,
       vendor_id uuid NOT NULL,
       is_primary boolean NOT NULL DEFAULT false,
       note text,
       CONSTRAINT fk_link_owner  FOREIGN KEY (owner_id)  REFERENCES ${SCHEMA}.owner (owner_id),
       CONSTRAINT fk_link_vendor FOREIGN KEY (vendor_id) REFERENCES ${SCHEMA_B}.vendor (vendor_id)
     )`, [])
  await conn.execute(`CREATE INDEX idx_link_owner ON ${SCHEMA}.link (owner_id)`, [])
  await conn.execute(`CREATE INDEX idx_link_vendor ON ${SCHEMA}.link (vendor_id)`, [])
  await conn.execute(
    `CREATE UNIQUE INDEX uq_link_owner_vendor ON ${SCHEMA}.link (owner_id, vendor_id)`, [])
  await conn.execute(
    `COMMENT ON TABLE ${SCHEMA}.link IS 'Joins an owner to a vendor'`, [])
  await conn.execute(
    `COMMENT ON COLUMN ${SCHEMA}.link.owner_id IS 'FK to owner'`, [])

  // A table with no primary key, for the read-only path.
  await conn.execute(`CREATE TABLE ${SCHEMA}.nopk (v text)`, [])

  // Wide enough to exercise cursor chunking.
  await conn.execute(
    `CREATE TABLE ${SCHEMA}.wide (id serial PRIMARY KEY, label text, n int)`, [])
  await conn.execute(
    `INSERT INTO ${SCHEMA}.wide (label, n)
     SELECT 'row-' || g, g * 2 FROM generate_series(1, ${EXPECTED.rowsInWide}) g`, [])
  await conn.execute(
    `INSERT INTO ${SCHEMA}.nopk SELECT 'x-' || g FROM generate_series(1, 1200) g`, [])

  await conn.execute(`CREATE VIEW ${SCHEMA}.link_view AS SELECT * FROM ${SCHEMA}.link`, [])

  // Two owners and two vendors, so joins and self-joins have something to chew on.
  await conn.execute(
    `INSERT INTO ${SCHEMA}.owner (label) VALUES ('alpha'), ('beta')`, [])
  await conn.execute(
    `INSERT INTO ${SCHEMA_B}.vendor (vendor_name) VALUES ('vendor one'), ('vendor two')`, [])
  await conn.execute(
    `INSERT INTO ${SCHEMA}.link (owner_id, vendor_id, is_primary)
     SELECT o.owner_id, v.vendor_id, true
       FROM ${SCHEMA}.owner o CROSS JOIN ${SCHEMA_B}.vendor v`, [])

  await conn.execute(`ANALYZE ${SCHEMA}.wide`, [])

  // The driver caches oid -> relation at connect time; without this the tables
  // just created are unknown and every result looks read-only.
  await conn.refreshTableNames()
}

export async function dropFixture(conn: PgConnection): Promise<void> {
  await conn.execute(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`, [])
  await conn.execute(`DROP SCHEMA IF EXISTS ${SCHEMA_B} CASCADE`, [])
}
