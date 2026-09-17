import pg from 'pg'
import Cursor from 'pg-cursor'
import { maskLiterals } from '@shared/sql'
import { lookup } from 'node:dns/promises'
import { buildSslOptions, needsAddressDial } from './ssl'
import { readCaBundle } from './caBundle'
import type { Cell, ConnectionConfig, QueryField, QueryError, TxMode, TxStatus } from '@shared/ipc'

const { Client } = pg

/** Statements that stream rows and are therefore worth running through a cursor. */
const CURSOR_KEYWORDS = /^\s*(select|with|table|values|show|explain)\b/i

/** `WITH ... INSERT/UPDATE/DELETE` modifies data despite starting like a SELECT. */
const DATA_MODIFYING = /\b(insert\s+into|update|delete\s+from|merge)\b/i

function streamable(sql: string, masked: string): boolean {
  if (!CURSOR_KEYWORDS.test(sql)) return false
  if (/^\s*with\b/i.test(sql) && DATA_MODIFYING.test(masked)) return false
  return true
}

export interface RawChunk {
  fields: QueryField[]
  rows: Cell[][]
  complete: boolean
  command: string
  rowCount: number | null
  /** oid of the single source table, when every real column came from one table */
  sourceTableOid: number | null
  /** result column index -> source column attnum */
  columnAttnums: Record<number, number>
}

export class PgConnection {
  readonly config: ConnectionConfig
  private client: pg.Client | null = null
  private password?: string
  private typeNames = new Map<number, string>()
  private tableNames = new Map<number, { schema: string; table: string }>()
  private backendPid: number | null = null
  private queue: Promise<unknown> = Promise.resolve()
  /** The one open result cursor, if any. It owns the connection's protocol state. */
  private activeCursor: Cursor | null = null

  /** Non-fatal TLS note (verify-full downgraded, say). Set when options are built. */
  sslWarning?: string

  /**
   * Fires when the server or the network drops the connection out from under
   * us: an SSM tunnel restarted, an idle timeout, a laptop that changed
   * networks. The session forwards it to the renderer, whose sidebar otherwise
   * keeps reading "connected" against a socket that is gone.
   */
  onLost?: (lostTransaction: boolean) => void
  /** True when the drop took an open transaction with it; see takeLostTransaction. */
  private lostTransaction = false
  /** Address the live socket was dialled to. The cancel side-connection reuses it. */
  private dialledHost?: string

  txMode: TxMode = 'auto'
  txStatus: TxStatus = 'idle'
  serverVersion?: string
  /** notices raised by the statement currently running */
  private notices: string[] = []

  constructor(config: ConnectionConfig, password?: string) {
    this.config = config
    this.password = password
  }

  get connected(): boolean {
    return this.client !== null
  }

  private clientOptions(): pg.ClientConfig {
    const { ssl, warning } = buildSslOptions(this.config, readCaBundle)
    this.sslWarning = warning
    return {
      host: this.config.host,
      port: this.config.port ?? 5432,
      database: this.config.database,
      user: this.config.user,
      password: this.password,
      ssl,
      application_name: 'Quarry',
      // A dead tunnel leaves a half-open socket that no packet ever reports on.
      // Keepalives turn that into an error event on their own, instead of the
      // first statement hanging until the TCP stack gives up on the write.
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000
    }
  }

  /**
   * Where the socket goes. With an SNI override this is the resolved address,
   * not the name, or pg would verify the certificate against the name we dial
   * (see needsAddressDial). IPv4 first: the SSM port-forward and most local
   * tunnels listen on 127.0.0.1 only, and "localhost" resolves to ::1 first on
   * a default macOS setup.
   */
  private async dialHost(): Promise<string> {
    const host = this.config.host.trim()
    if (!needsAddressDial(this.config)) return host
    try {
      return (await lookup(host, { family: 4 })).address
    } catch {
      return (await lookup(host)).address
    }
  }

  async connect(): Promise<void> {
    if (this.client) return
    const options = this.clientOptions()
    options.host = this.dialledHost = await this.dialHost()
    const client = new Client(options)
    await client.connect()
    this.client = client
    this.activeCursor = null
    this.notices = []
    client.on('error', () => {
      // pg reports one drop twice (the FATAL, then the socket closing), and a
      // late report from a client we have already replaced must not kill the
      // new one.
      if (this.client !== client) return
      this.lostTransaction = this.txStatus !== 'idle'
      this.client = null
      this.activeCursor = null
      this.txStatus = 'idle'
      this.onLost?.(this.lostTransaction)
    })
    // RAISE NOTICE output is invisible unless we collect it.
    client.on('notice', (n: { severity?: string; message?: string }) => {
      this.notices.push(`${n.severity ?? 'NOTICE'}: ${n.message ?? ''}`)
    })

    const [{ rows: verRows }, { rows: pidRows }, { rows: typeRows }] = await Promise.all([
      client.query('SHOW server_version'),
      client.query('SELECT pg_backend_pid() AS pid'),
      client.query('SELECT oid, typname FROM pg_type')
    ])
    this.serverVersion = verRows[0]?.server_version
    this.backendPid = Number(pidRows[0]?.pid)
    for (const r of typeRows) this.typeNames.set(Number(r.oid), String(r.typname))
    await this.refreshTableNames()
  }

  /**
   * oid -> schema.table, used to decide whether a result set is editable.
   *
   * Routed through run() deliberately: issuing this straight at the client
   * while a result cursor is suspended wedges the connection permanently.
   */
  async refreshTableNames(): Promise<void> {
    if (!this.client) return
    const rows = await this.query(
      `SELECT c.oid, n.nspname, c.relname
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','p','v','m','f')`
    )
    this.tableNames.clear()
    for (const r of rows) {
      this.tableNames.set(Number(r.oid), { schema: String(r.nspname), table: String(r.relname) })
    }
  }

  tableFor(oid: number): { schema: string; table: string } | undefined {
    return this.tableNames.get(oid)
  }

  async disconnect(): Promise<void> {
    const c = this.client
    this.activeCursor = null
    this.client = null
    // txStatus is deliberately left as-is: clearing it here made the quit guard
    // read every connection as idle and discard open transactions silently.
    if (c) await c.end().catch(() => undefined)
  }

  /**
   * Serialise work: one session per data source keeps transaction state coherent.
   *
   * An open cursor still owns the connection, so anything issued while one is
   * live would queue behind a statement that never completes — a permanent hang
   * on Commit, Export, Submit or a catalog refresh. Release the cursor first
   * unless the caller is the one reading from it.
   */
  private run<T>(fn: () => Promise<T>, keepCursor = false): Promise<T> {
    const task = async (): Promise<T> => {
      if (!keepCursor) await this.releaseCursor()
      return fn()
    }
    const next = this.queue.then(task, task)
    this.queue = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  /**
   * Whether the connection dropped while a transaction was open, cleared on
   * read. The server rolled that work back, so the next statement must not run
   * as if nothing happened.
   */
  takeLostTransaction(): boolean {
    const lost = this.lostTransaction
    this.lostTransaction = false
    return lost
  }

  /** Closes the open cursor, if any. Called from inside the queue only. */
  private async releaseCursor(): Promise<void> {
    const cursor = this.activeCursor
    if (!cursor) return
    this.activeCursor = null
    const client = this.client
    await new Promise<void>((resolve) => {
      // pg-cursor's close callback waits for ReadyForQuery, which a dead
      // connection never sends; the client's 'end' is what arrives instead.
      const done = (): void => {
        client?.removeListener('end', done)
        resolve()
      }
      client?.once('end', done)
      try {
        cursor.close(done)
      } catch {
        done()
      }
    })
  }

  /** False once the cursor has been closed to let another statement through. */
  isCursorActive(cursor: Cursor): boolean {
    return this.activeCursor === cursor
  }

  private require(): pg.Client {
    if (!this.client) throw new Error('Not connected')
    return this.client
  }

  /** Cancel the in-flight statement from a side connection, as psql's Ctrl-C does. */
  async cancelRunning(): Promise<void> {
    if (this.backendPid == null) return
    const side = new Client({ ...this.clientOptions(), host: this.dialledHost ?? this.config.host })
    try {
      await side.connect()
      await side.query('SELECT pg_cancel_backend($1)', [this.backendPid])
    } catch {
      /* best effort */
    } finally {
      await side.end().catch(() => undefined)
    }
  }

  async setTxMode(mode: TxMode): Promise<void> {
    if (mode === this.txMode) return
    if (this.txMode === 'manual' && this.txStatus !== 'idle') {
      await this.rollback()
    }
    this.txMode = mode
  }

  /** In manual mode, open a transaction lazily on first statement. */
  private async ensureTx(): Promise<void> {
    if (this.txMode !== 'manual' || this.txStatus !== 'idle') return
    await this.require().query('BEGIN')
    this.txStatus = 'active'
  }

  /** Explicit transaction control that bypasses ensureTx, for batch submits. */
  async begin(): Promise<void> {
    return this.run(async () => {
      await this.require().query('BEGIN')
      // Recorded so the quit guard sees an in-flight batch as a live transaction.
      this.txStatus = 'active'
    })
  }

  async commitRaw(): Promise<void> {
    return this.run(async () => {
      await this.require().query('COMMIT')
      this.txStatus = 'idle'
    })
  }

  async rollbackRaw(): Promise<void> {
    return this.run(async () => {
      await this.require().query('ROLLBACK')
      this.txStatus = 'idle'
    })
  }

  async commit(): Promise<void> {
    return this.run(async () => {
      if (this.txStatus === 'idle') return
      // Postgres executes COMMIT on an aborted transaction as ROLLBACK. Reporting
      // that as a successful commit would tell the user their work was saved
      // when every change had in fact been discarded.
      const aborted = this.txStatus === 'failed'
      await this.require().query(aborted ? 'ROLLBACK' : 'COMMIT')
      this.txStatus = 'idle'
      if (aborted) {
        throw new Error(
          'The transaction was aborted by an earlier error, so nothing could be committed. It has been rolled back.'
        )
      }
    })
  }

  async rollback(): Promise<void> {
    return this.run(async () => {
      if (this.txStatus === 'idle') return
      await this.require().query('ROLLBACK')
      this.txStatus = 'idle'
    })
  }

  /** True while a result cursor holds the connection. */
  get hasOpenCursor(): boolean {
    return this.activeCursor !== null
  }

  /** Drains notices collected since the last call. */
  takeNotices(): string[] {
    const out = this.notices
    this.notices = []
    return out
  }

  /** Start a statement. Returns the first chunk plus a live cursor when streaming. */
  async start(sql: string, chunkSize: number): Promise<{ chunk: RawChunk; cursor: Cursor | null }> {
    return this.run(async () => {
      const client = this.require()
      await this.ensureTx()
      this.notices = []
      try {
        if (streamable(sql, maskLiterals(sql))) {
          const cursor = client.query(new Cursor(sql, undefined, { rowMode: 'array' }))
          const chunk = await this.readCursor(cursor, chunkSize)
          if (chunk.complete) {
            await new Promise<void>((resolve) => cursor.close(() => resolve()))
            return { chunk, cursor: null }
          }
          this.activeCursor = cursor
          return { chunk, cursor }
        }
        const res = await client.query({ text: sql, rowMode: 'array' })
        return { chunk: this.fromResult(res), cursor: null }
      } catch (err) {
        if (this.txStatus === 'active') this.txStatus = 'failed'
        throw err
      }
    })
  }

  async readCursor(cursor: Cursor, count: number): Promise<RawChunk> {
    return new Promise((resolve, reject) => {
      cursor.read(count, (err: Error | null, rows: unknown[][], result: pg.Result) => {
        if (err) return reject(err)
        const fields = this.mapFields(result?.fields ?? [])
        const { sourceTableOid, columnAttnums } = this.sourceInfo(result?.fields ?? [])
        resolve({
          fields,
          rows: rows.map((r) => r.map(normalize)),
          complete: rows.length < count,
          command: 'SELECT',
          rowCount: null,
          sourceTableOid,
          columnAttnums
        })
      })
    })
  }

  async readMore(cursor: Cursor, count: number): Promise<RawChunk> {
    return this.run(async () => {
      if (this.activeCursor !== cursor) {
        throw new Error('The result cursor was closed by another statement')
      }
      const chunk = await this.readCursor(cursor, count)
      if (chunk.complete) await this.releaseCursor()
      return chunk
    }, true)
  }

  async closeCursor(cursor: Cursor): Promise<void> {
    if (this.activeCursor === cursor) {
      this.activeCursor = null
    }
    await new Promise<void>((resolve) => {
      try {
        cursor.close(() => resolve())
      } catch {
        resolve()
      }
    })
  }

  /** Parameterised execution used by grid edits — never string interpolation. */
  async execute(sql: string, params: Cell[]): Promise<number> {
    return this.run(async () => {
      // Must open the manual transaction like start() does. Without this, grid
      // edits submitted in manual-commit mode run in autocommit and are durable
      // before the user ever presses Commit — Rollback would have nothing to undo.
      await this.ensureTx()
      try {
        const res = await this.require().query(sql, params)
        return res.rowCount ?? 0
      } catch (err) {
        if (this.txStatus === 'active') this.txStatus = 'failed'
        throw err
      }
    })
  }

  /** Metadata reads. Deliberately not transactional: introspecting on connect
   *  must not open a transaction the user never asked for. */
  async query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    return this.run(async () => (await this.require().query(sql, params)).rows)
  }

  /**
   * A read that participates in the user's transaction.
   *
   * EXPLAIN ANALYZE really executes the statement, so explaining a DML statement
   * through the plain `query` path ran it in autocommit — the write was durable
   * and Rollback had nothing to undo.
   */
  async queryInTx(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    return this.run(async () => {
      await this.ensureTx()
      try {
        return (await this.require().query(sql, params)).rows
      } catch (err) {
        if (this.txStatus === 'active') this.txStatus = 'failed'
        throw err
      }
    })
  }

  private fromResult(res: pg.Result): RawChunk {
    const { sourceTableOid, columnAttnums } = this.sourceInfo(res.fields ?? [])
    return {
      fields: this.mapFields(res.fields ?? []),
      rows: (res.rows as unknown[][]).map((r) => r.map(normalize)),
      complete: true,
      command: res.command ?? '',
      rowCount: res.rowCount,
      sourceTableOid,
      columnAttnums
    }
  }

  private mapFields(fields: pg.FieldDef[]): QueryField[] {
    return fields.map((f) => {
      const dataType = this.typeNames.get(f.dataTypeID) ?? String(f.dataTypeID)
      return { name: f.name, dataType, affinity: affinityOf(dataType) }
    })
  }

  /**
   * Postgres reports, per result column, which table and attribute it came from.
   * That is exactly the editability signal DataGrip derives from parsing — here
   * the wire protocol hands it to us, so no SQL parsing is needed.
   */
  private sourceInfo(fields: pg.FieldDef[]): {
    sourceTableOid: number | null
    columnAttnums: Record<number, number>
  } {
    const columnAttnums: Record<number, number> = {}
    const oids = new Set<number>()
    fields.forEach((f, i) => {
      const oid = Number(f.tableID ?? 0)
      if (oid > 0) {
        oids.add(oid)
        columnAttnums[i] = Number(f.columnID ?? 0)
      }
    })
    return { sourceTableOid: oids.size === 1 ? [...oids][0] : null, columnAttnums }
  }
}

const NUMERIC = new Set([
  'int2', 'int4', 'int8', 'float4', 'float8', 'numeric', 'money', 'oid'
])
const TEMPORAL = new Set([
  'date', 'time', 'timetz', 'timestamp', 'timestamptz', 'interval'
])

function affinityOf(typname: string): QueryField['affinity'] {
  const base = typname.replace(/^_/, '')
  if (NUMERIC.has(base)) return 'numeric'
  if (base === 'bool') return 'boolean'
  if (TEMPORAL.has(base)) return 'temporal'
  if (base === 'json' || base === 'jsonb') return 'json'
  if (base === 'bytea') return 'binary'
  return 'text'
}

/** Everything crosses IPC as a display string, with NULL preserved as null. */
function normalize(v: unknown): Cell {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v instanceof Date) return v.toISOString()
  if (Buffer.isBuffer(v)) return '\\x' + v.toString('hex')
  return JSON.stringify(v)
}

export function toQueryError(err: unknown): QueryError {
  const e = err as { message?: string; position?: string; detail?: string; hint?: string; code?: string }
  return {
    message: e?.message ?? String(err),
    position: e?.position ? Number(e.position) : undefined,
    detail: e?.detail,
    hint: e?.hint,
    code: e?.code
  }
}
