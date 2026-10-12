import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { once } from 'node:events'
import type Cursor from 'pg-cursor'
import { splitStatements } from '@shared/sql'
import type {
  Catalog, Cell, ConnectionConfig, ConnectionState, EditTarget,
  GridEdits, PendingChange, PlanNode, QueryRequest, QueryResult, SourceTarget, TestResult, TunnelStatus, TxMode
} from '@shared/ipc'
import { AwsCliError, fetchSecretPassword, withRotatedSecret } from './aws/cli'
import { TunnelManager, type TunnelLease } from './aws/tunnel'
import { PgConnection, toQueryError, type RawChunk } from './drivers/postgres'
import { introspect, sourceOf } from './introspect/postgres'
import { readCachedCatalog, writeCachedCatalog } from './store/catalogs'
import { buildChanges } from './query/dml'
import { renderDdl } from './query/ddl'
import { parsePlan } from './query/plan'
import { DBA_QUERIES, findDbaQuery, type DbaQuery } from './dba/queries'
import { resolveEditTarget } from './query/editable'
import { getSecret, secretIsUnreadable } from './store/secrets'
import { record } from './store/history'

interface ActiveQuery {
  id: string
  connectionId: string
  sql: string
  cursor: Cursor | null
  fields: QueryResult['fields']
  rows: Cell[][]
  editable: EditTarget | null
  complete: boolean
}

const DEFAULT_CHUNK = 500

export class Session {
  private connections = new Map<string, PgConnection>()
  private catalogs = new Map<string, Catalog>()
  private queries = new Map<string, ActiveQuery>()
  private tunnels = new TunnelManager()
  /** The SSM tunnel each connection holds a lease on; released when it disconnects. */
  private leases = new Map<string, TunnelLease>()
  /** The saved config behind each live connection: PgConnection only sees the dialled one. */
  private configs = new Map<string, ConnectionConfig>()

  constructor() {
    this.tunnels.onChange = (list) => this.onTunnelsChange?.(list)
  }

  /** Pushed to the renderer whenever an SSM tunnel opens, closes or gains a user. */
  onTunnelsChange?: (tunnels: TunnelStatus[]) => void

  tunnelStatus(): TunnelStatus[] {
    return this.tunnels.list()
  }

  /** Pushed to the renderer whenever a connection's state changes underneath it. */
  onStateChange?: (state: ConnectionState) => void

  /**
   * The live connection for `id`, re-established when the server or the
   * network dropped it.
   *
   * A dropped socket used to leave the sidebar reading "connected" while every
   * statement failed with "Not connected" until the app was restarted: nothing
   * told the renderer, and nothing reconnected. Now the drop is reported the
   * moment it happens and the next statement dials again. The one thing that
   * cannot be replayed is an open transaction, so that is reported instead of
   * silently running the statement outside it.
   */
  private async conn(id: string): Promise<PgConnection> {
    const c = this.connections.get(id)
    if (!c) throw new Error('Not connected')
    if (c.connected) return c
    try {
      await this.refreshAws(id, c)
      await c.connect()
    } catch (err) {
      throw new Error(
        `The connection to ${c.config.name} was lost and could not be re-established: ${(err as Error).message}`
      )
    }
    this.onStateChange?.(this.state(id))
    if (c.takeLostTransaction()) {
      throw new Error(
        `The connection to ${c.config.name} dropped while a transaction was open, so the server rolled back its uncommitted changes. ` +
          'It has been re-established; run the statement again.'
      )
    }
    return c
  }

  private track(cfg: ConnectionConfig, conn: PgConnection): void {
    this.connections.set(cfg.id, conn)
    this.configs.set(cfg.id, cfg)
    conn.onLost = () => {
      // Only if this is still the connection the session knows by that id.
      if (this.connections.get(cfg.id) === conn) this.onStateChange?.(this.state(cfg.id))
    }
  }

  state(id: string): ConnectionState {
    const c = this.connections.get(id)
    if (!c) return { id, connected: false, txMode: 'auto', txStatus: 'idle' }
    return {
      id,
      connected: c.connected,
      txMode: c.txMode,
      txStatus: c.txStatus,
      serverVersion: c.serverVersion,
      sslWarning: c.sslWarning
    }
  }

  async connect(cfg: ConnectionConfig): Promise<ConnectionState> {
    const existing = this.connections.get(cfg.id)
    if (existing?.connected) return this.state(cfg.id)

    // A password pulled from Secrets Manager replaces the keychain one entirely.
    const keychain = cfg.passwordSource ? undefined : getSecret(cfg.id)
    if (!cfg.passwordSource && keychain === undefined && secretIsUnreadable(cfg.id)) {
      throw new Error(
        `The saved password for ${cfg.name} is in the keychain but this build cannot read it. ` +
          'That happens after installing or re-signing the app. Open the connection and enter the password once to store it again.'
      )
    }

    const { conn, lease } = await this.dial(cfg, keychain)
    if (lease) this.leases.set(cfg.id, lease)
    this.track(cfg, conn)
    return this.state(cfg.id)
  }

  /**
   * Opens a connection, bringing up its SSM tunnel and reading its password
   * from Secrets Manager first when the config asks for either. The tunnel
   * lease is released if anything after it fails.
   *
   * An authentication failure re-reads the secret once (see withRotatedSecret).
   */
  private async dial(
    cfg: ConnectionConfig, password: string | undefined
  ): Promise<{ conn: PgConnection; lease?: TunnelLease }> {
    let lease: TunnelLease | undefined
    try {
      if (cfg.ssmTunnel) lease = await this.tunnels.acquire(cfg.ssmTunnel)
      const target = lease ? { ...cfg, host: '127.0.0.1', port: lease.port } : cfg
      if (cfg.passwordSource) password = await fetchSecretPassword(cfg.passwordSource)

      const open = async (pw: string | undefined): Promise<PgConnection> => {
        const c = new PgConnection(target, pw)
        await c.connect()
        return c
      }
      const conn = cfg.passwordSource
        ? await withRotatedSecret(cfg.passwordSource, password ?? '', open)
        : await open(password)
      return { conn, lease }
    } catch (err) {
      await lease?.release()
      throw err
    }
  }

  /**
   * Before redialling a dropped connection: reopen its tunnel if the forward
   * died (SSM ends idle sessions) on the same local port, and pick up a rotated
   * password. Both are no-ops for a connection with neither feature.
   */
  private async refreshAws(id: string, c: PgConnection): Promise<void> {
    const cfg = this.configs.get(id)
    if (!cfg) return
    const lease = this.leases.get(id)
    if (cfg.ssmTunnel && lease && !lease.alive) {
      await lease.release()
      this.leases.set(id, await this.tunnels.acquire({ ...cfg.ssmTunnel, localPort: lease.port }))
    }
    if (cfg.passwordSource) c.setPassword(await fetchSecretPassword(cfg.passwordSource))
  }

  async disconnect(id: string): Promise<void> {
    for (const [qid, q] of this.queries) if (q.connectionId === id) this.queries.delete(qid)
    const c = this.connections.get(id)
    this.connections.delete(id)
    this.catalogs.delete(id)
    this.configs.delete(id)
    if (c) await c.disconnect()
    await this.leases.get(id)?.release()
    this.leases.delete(id)
  }

  async test(cfg: ConnectionConfig, password?: string): Promise<TestResult> {
    let session: { conn: PgConnection; lease?: TunnelLease } | undefined
    try {
      session = await this.dial(cfg, cfg.passwordSource ? undefined : (password ?? getSecret(cfg.id)))
      const { conn } = session
      const message = `Connected to PostgreSQL ${conn.serverVersion ?? ''}`.trim()
      return { ok: true, message: conn.sslWarning ? `${message}. ${conn.sslWarning}` : message }
    } catch (err) {
      const sso = err instanceof AwsCliError && err.kind === 'sso' ? err.profile : undefined
      return { ok: false, message: (err as Error).message, ssoLoginProfile: sso }
    } finally {
      await session?.conn.disconnect()
      await session?.lease?.release()
    }
  }

  async catalog(id: string, refresh = false): Promise<Catalog> {
    const cached = this.catalogs.get(id)
    if (cached && !refresh) return cached
    const conn = await this.conn(id)
    if (refresh) await conn.refreshTableNames()
    const cat = await introspect(conn)
    this.catalogs.set(id, cat)
    writeCachedCatalog(cat)
    return cat
  }

  cachedCatalog(id: string): Catalog | null {
    const cat = this.catalogs.get(id) ?? readCachedCatalog(id)
    return cat && !this.connections.has(id) ? { ...cat, offline: true } : cat
  }

  async source(id: string, target: SourceTarget): Promise<string> {
    return sourceOf(await this.conn(id), target)
  }

  private resolveEditTarget(id: string, chunk: RawChunk, sql: string): EditTarget | null {
    const conn = this.connections.get(id)
    return resolveEditTarget(this.catalogs.get(id) ?? null, (oid) => conn?.tableFor(oid), chunk, sql)
  }

  /**
   * A table created moments ago — by the script currently running, or by another
   * session — is absent from the cached catalog, which would wrongly mark its
   * rows read-only. Re-introspect once when the source oid is unknown.
   *
   * Joins and aggregates report no source oid at all, so they never pay for this.
   */
  private async editTargetFor(id: string, chunk: RawChunk, sql: string): Promise<EditTarget | null> {
    const direct = this.resolveEditTarget(id, chunk, sql)
    if (direct || chunk.sourceTableOid == null) return direct

    const conn = this.connections.get(id)
    if (!conn) return null
    await conn.refreshTableNames()
    await this.catalog(id, true)
    return this.resolveEditTarget(id, chunk, sql)
  }

  async run(req: QueryRequest, connectionName: string): Promise<QueryResult> {
    const conn = await this.conn(req.connectionId)
    const chunkSize = req.chunkSize ?? DEFAULT_CHUNK
    const queryId = randomUUID()
    const startedAt = Date.now()

    try {
      const { chunk, cursor } = await conn.start(req.sql, chunkSize)
      const durationMs = Date.now() - startedAt
      const editable = await this.editTargetFor(req.connectionId, chunk, req.sql)

      const active: ActiveQuery = {
        id: queryId,
        connectionId: req.connectionId,
        sql: req.sql,
        cursor,
        fields: chunk.fields,
        rows: chunk.rows,
        editable,
        complete: chunk.complete
      }
      this.queries.set(queryId, active)

      record({
        connectionId: req.connectionId,
        connectionName,
        sql: req.sql,
        startedAt,
        durationMs,
        rowCount: chunk.rowCount ?? chunk.rows.length,
        error: null
      })

      return {
        queryId,
        fields: chunk.fields,
        rows: chunk.rows,
        rowCount: chunk.rowCount,
        complete: chunk.complete,
        durationMs,
        command: chunk.command,
        notices: conn.takeNotices(),
        editable
      }
    } catch (err) {
      const durationMs = Date.now() - startedAt
      record({
        connectionId: req.connectionId,
        connectionName,
        sql: req.sql,
        startedAt,
        durationMs,
        rowCount: null,
        error: (err as Error).message
      })
      return {
        queryId,
        fields: [],
        rows: [],
        rowCount: null,
        complete: true,
        durationMs,
        command: '',
        notices: [],
        editable: null,
        error: toQueryError(err)
      }
    }
  }

  async fetchMore(queryId: string, count: number): Promise<QueryResult> {
    const q = this.queries.get(queryId)
    if (!q) throw new Error('Query is no longer active')
    if (!q.cursor || q.complete) {
      return this.snapshot(q, 0)
    }
    const conn = await this.conn(q.connectionId)
    const started = Date.now()
    // Another statement may have closed the cursor to get at the connection.
    if (!conn.isCursorActive(q.cursor)) {
      q.cursor = null
      q.complete = true
      return this.snapshot(q, 0, [
        'Result truncated: the cursor was closed by another statement. Re-run to see the rest.'
      ])
    }
    const chunk = await conn.readMore(q.cursor, count)
    q.rows.push(...chunk.rows)
    q.complete = chunk.complete
    if (chunk.complete) q.cursor = null
    return this.snapshot(q, Date.now() - started, conn.takeNotices())
  }

  private snapshot(q: ActiveQuery, durationMs: number, notices: string[] = []): QueryResult {
    return {
      queryId: q.id,
      fields: q.fields,
      rows: q.rows,
      rowCount: null,
      complete: q.complete,
      durationMs,
      command: 'SELECT',
      notices,
      editable: q.editable
    }
  }

  /**
   * Cancels the statement in flight on that connection. With one session per
   * data source that is necessarily this query — there is no second statement
   * it could hit.
   */
  async cancel(queryId: string): Promise<void> {
    const q = this.queries.get(queryId)
    if (!q) return
    await this.connections.get(q.connectionId)?.cancelRunning()
  }

  async closeQuery(queryId: string): Promise<void> {
    const q = this.queries.get(queryId)
    if (!q) return
    this.queries.delete(queryId)
    if (q.cursor) {
      await this.connections.get(q.connectionId)?.closeCursor(q.cursor).catch(() => undefined)
    }
  }

  preview(queryId: string, edits: GridEdits): PendingChange[] {
    const q = this.queries.get(queryId)
    if (!q) throw new Error('Query is no longer active')
    if (!q.editable) throw new Error('This result set is not editable')
    return buildChanges(q.editable, q.rows, edits)
  }

  /** All staged edits go in one transaction: all of them land, or none do. */
  async submit(queryId: string, edits: GridEdits): Promise<{ ok: boolean; applied: number; error?: string }> {
    const q = this.queries.get(queryId)
    if (!q) throw new Error('Query is no longer active')
    if (!q.editable) throw new Error('This result set is not editable')
    const conn = await this.conn(q.connectionId)
    const changes = buildChanges(q.editable, q.rows, edits)

    // In manual mode the user's own transaction is already open and stays open,
    // so their Commit/Rollback still governs. Otherwise wrap the batch itself.
    const outerManaged = conn.txMode === 'manual'
    let applied = 0
    try {
      if (!outerManaged) await conn.begin()
      for (const c of changes) {
        const affected = await conn.execute(c.sql, c.params)
        // Zero rows means the row is gone or its key changed under us. Silently
        // reporting success discarded the user's edit without a word.
        if (affected === 0 && c.kind !== 'insert') {
          throw new Error(
            `The row this ${c.kind} targets no longer exists — it may have been changed or deleted by someone else. Refresh and try again.`
          )
        }
        applied += affected
      }
      if (!outerManaged) await conn.commitRaw()

      // Reflect the applied values in our cached rows so the grid stays truthful.
      for (const e of edits.updates) {
        const row = q.rows[e.rowIndex]
        if (row) row[e.columnIndex] = e.newValue
      }
      return { ok: true, applied }
    } catch (err) {
      if (!outerManaged) await conn.rollbackRaw().catch(() => undefined)
      else conn.txStatus = 'failed'
      return { ok: false, applied: 0, error: (err as Error).message }
    }
  }

  /** Runs every statement in the buffer in order, returning one result each. */
  async runScript(req: QueryRequest, connectionName: string): Promise<QueryResult[]> {
    const statements = splitStatements(req.sql)
    if (!statements.length) return []
    const out: QueryResult[] = []
    for (const stmt of statements) {
      const res = await this.run({ ...req, sql: stmt.text }, connectionName)
      out.push(res)
      // Stop at the first failure rather than running the rest against a broken
      // transaction — the same thing psql does with ON_ERROR_STOP.
      if (res.error) break
    }
    return out
  }

  /** EXPLAIN in JSON form, parsed into a tree for the plan viewer. */
  async explainPlan(connectionId: string, sql: string, analyze: boolean): Promise<PlanNode> {
    const prefix = analyze
      ? 'EXPLAIN (ANALYZE, BUFFERS, VERBOSE, COSTS, TIMING, FORMAT JSON) '
      : 'EXPLAIN (VERBOSE, COSTS, FORMAT JSON) '
    const conn = await this.conn(connectionId)
    // ANALYZE executes the statement for real, so it must join the transaction.
    const rows = analyze
      ? await conn.queryInTx(prefix + sql)
      : await conn.query(prefix + sql)
    const first = rows[0] as Record<string, unknown>
    const raw = Object.values(first)[0]
    return parsePlan(typeof raw === 'string' ? raw : JSON.stringify(raw))
  }

  dbaQueries(): Omit<DbaQuery, 'sql'>[] {
    return DBA_QUERIES.map(({ sql: _sql, ...rest }) => rest)
  }

  /**
   * Runs a curated diagnostic. When it needs an extension that is not installed,
   * the result carries the exact CREATE EXTENSION to run rather than the raw
   * "relation does not exist" the server would return.
   */
  async dba(connectionId: string, key: string, connectionName: string): Promise<QueryResult> {
    const q = findDbaQuery(key)
    if (!q) throw new Error(`No such diagnostic: ${key}`)

    if (q.requires) {
      const rows = await (await this.conn(connectionId)).query(
        'SELECT 1 FROM pg_extension WHERE extname = $1',
        [q.requires]
      )
      if (!rows.length) {
        return {
          queryId: '',
          fields: [],
          rows: [],
          rowCount: null,
          complete: true,
          durationMs: 0,
          command: '',
          notices: [],
          editable: null,
          error: {
            message: `${q.label} needs the ${q.requires} extension, which is not installed on this database.`,
            hint: `Run:  CREATE EXTENSION ${q.requires};\n\n${q.requires} must also be listed in shared_preload_libraries, which requires a server restart.`
          }
        }
      }
    }

    return this.run({ connectionId, sql: q.sql.trim() }, connectionName)
  }

  /** Regenerates CREATE TABLE DDL from the catalog. */
  async ddl(connectionId: string, schema: string, table: string): Promise<string> {
    const catalog = await this.catalog(connectionId)
    const meta = catalog.schemas.find((s) => s.name === schema)?.tables.find((t) => t.name === table)
    if (!meta) throw new Error(`No such relation: ${schema}.${table}`)
    return renderDdl(meta)
  }

  async setTxMode(id: string, mode: TxMode): Promise<ConnectionState> {
    await (await this.conn(id)).setTxMode(mode)
    return this.state(id)
  }

  async commit(id: string): Promise<ConnectionState> {
    await (await this.conn(id)).commit()
    return this.state(id)
  }

  async rollback(id: string): Promise<ConnectionState> {
    await (await this.conn(id)).rollback()
    return this.state(id)
  }

  /**
   * Streams the result to disk from what we already hold plus whatever remains
   * on the open cursor.
   *
   * It deliberately does not re-execute the statement: exporting the result of
   * an `INSERT ... RETURNING` performed the write a second time.
   */
  async exportCsv(queryId: string, path: string): Promise<{ rows: number }> {
    const q = this.queries.get(queryId)
    if (!q) throw new Error('Query is no longer active')
    const conn = await this.conn(q.connectionId)
    const out = createWriteStream(path, { encoding: 'utf8' })

    const write = async (chunk: string): Promise<void> => {
      if (!out.write(chunk)) await once(out, 'drain')
    }

    let rows = 0
    try {
      await write(q.fields.map((f) => csvCell(f.name)).join(',') + '\n')

      const emit = async (batch: Cell[][]): Promise<void> => {
        if (!batch.length) return
        await write(batch.map((r) => r.map(csvCell).join(',')).join('\n') + '\n')
        rows += batch.length
      }

      await emit(q.rows)

      // Drain the rest of the open cursor, keeping the cached rows in step so
      // the grid can still show what was exported.
      while (q.cursor && !q.complete && conn.isCursorActive(q.cursor)) {
        const chunk = await conn.readMore(q.cursor, 1000)
        q.rows.push(...chunk.rows)
        q.complete = chunk.complete
        await emit(chunk.rows)
        if (chunk.complete) q.cursor = null
      }
      return { rows }
    } finally {
      out.end()
      await once(out, 'close')
    }
  }

  /** Connections sitting in an uncommitted transaction. */
  openTransactions(): { id: string; name: string }[] {
    return [...this.connections.entries()]
      .filter(([, c]) => c.connected && c.txStatus !== 'idle')
      .map(([id, c]) => ({ id, name: c.config.name }))
  }

  async shutdown(): Promise<void> {
    // Signals go out synchronously, before the first await, so this also works
    // from a process 'exit' handler.
    const tunnelsClosed = this.tunnels.closeAll()
    await Promise.all([...this.connections.values()].map((c) => c.disconnect()))
    this.connections.clear()
    this.leases.clear()
    await tunnelsClosed
  }
}

/** RFC 4180: quote when the value contains a delimiter, quote or newline. */
function csvCell(v: Cell): string {
  if (v === null) return ''
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v
}
