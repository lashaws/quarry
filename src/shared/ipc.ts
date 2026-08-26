/** Shared contract between main and renderer. The single source of truth. */

export type Engine = 'postgres' | 'sqlite'

export interface ConnectionConfig {
  id: string
  name: string
  engine: Engine
  /** postgres */
  host?: string
  port?: number
  database?: string
  user?: string
  ssl?: boolean
  /** sqlite */
  file?: string
  /** UI accent, DataGrip-style colour coding per environment */
  color?: string
}

export interface ColumnMeta {
  name: string
  dataType: string
  nullable: boolean
  defaultValue: string | null
  isPrimaryKey: boolean
  ordinal: number
  comment: string | null
}

export interface ForeignKey {
  name: string
  columns: string[]
  refSchema: string
  refTable: string
  refColumns: string[]
}

export interface IndexMeta {
  name: string
  columns: string[]
  unique: boolean
  primary: boolean
}

export type TableKind = 'table' | 'view' | 'matview' | 'foreign' | 'partitioned'

export interface TableMeta {
  schema: string
  name: string
  kind: TableKind
  comment: string | null
  columns: ColumnMeta[]
  primaryKey: string[]
  foreignKeys: ForeignKey[]
  indexes: IndexMeta[]
  rowEstimate: number | null
}

export interface SchemaMeta {
  name: string
  tables: TableMeta[]
}

export interface Catalog {
  connectionId: string
  database: string
  schemas: SchemaMeta[]
  fetchedAt: number
}

export interface QueryField {
  name: string
  dataType: string
  /** numeric | boolean | temporal | json | text — drives grid alignment & editors */
  affinity: 'numeric' | 'boolean' | 'temporal' | 'json' | 'binary' | 'text'
}

/** A cell is a display string, or null for SQL NULL (rendered distinctly). */
export type Cell = string | null

/**
 * Present only when the result set maps to exactly one table with a resolvable
 * primary key — DataGrip's own rule for when a grid may be edited.
 */
export interface EditTarget {
  schema: string
  table: string
  pkColumns: string[]
  /** result column index -> table column name */
  columnMap: Record<number, string>
}

export interface QueryResult {
  queryId: string
  fields: QueryField[]
  rows: Cell[][]
  /** rows affected, for INSERT/UPDATE/DELETE */
  rowCount: number | null
  /** false when more chunks remain on the server cursor */
  complete: boolean
  durationMs: number
  command: string
  notices: string[]
  editable: EditTarget | null
  error?: QueryError
}

export interface QueryError {
  message: string
  /** 1-based character offset into the statement, from Postgres */
  position?: number
  detail?: string
  hint?: string
  code?: string
}

export type TxMode = 'auto' | 'manual'
export type TxStatus = 'idle' | 'active' | 'failed'

export interface ConnectionState {
  id: string
  connected: boolean
  txMode: TxMode
  txStatus: TxStatus
  serverVersion?: string
  error?: string
}

/** One staged cell edit, before submit. */
export interface CellEdit {
  rowIndex: number
  columnIndex: number
  oldValue: Cell
  newValue: Cell
}

/** A row staged for INSERT; values are keyed by result column index. */
export interface NewRow {
  id: string
  values: Record<number, Cell>
}

/** Everything staged against one result set, submitted as a single transaction. */
export interface GridEdits {
  updates: CellEdit[]
  inserts: NewRow[]
  /** rowIndex values from the result set */
  deletes: number[]
}

export const emptyEdits = (): GridEdits => ({ updates: [], inserts: [], deletes: [] })

export const editCount = (e: GridEdits): number =>
  e.updates.length + e.inserts.length + e.deletes.length

export interface PendingChange {
  sql: string
  params: Cell[]
  kind: 'update' | 'insert' | 'delete'
  rowIndex: number
}

export interface HistoryEntry {
  id: number
  connectionId: string
  connectionName: string
  sql: string
  startedAt: number
  durationMs: number
  rowCount: number | null
  error: string | null
}

export interface QueryRequest {
  connectionId: string
  sql: string
  /** rows in the first chunk; further chunks come from fetchMore */
  chunkSize?: number
}

export interface Api {
  connections: {
    list(): Promise<ConnectionConfig[]>
    save(cfg: ConnectionConfig, password?: string): Promise<ConnectionConfig>
    remove(id: string): Promise<void>
    test(cfg: ConnectionConfig, password?: string): Promise<{ ok: boolean; message: string }>
    connect(id: string): Promise<ConnectionState>
    disconnect(id: string): Promise<void>
    state(id: string): Promise<ConnectionState>
    importFromDBeaver(): Promise<ConnectionConfig[]>
  }
  catalog: {
    get(connectionId: string, refresh?: boolean): Promise<Catalog>
  }
  query: {
    run(req: QueryRequest): Promise<QueryResult>
    fetchMore(queryId: string, count: number): Promise<QueryResult>
    cancel(queryId: string): Promise<void>
    close(queryId: string): Promise<void>
    /** stage grid edits -> preview generated DML */
    preview(queryId: string, edits: GridEdits): Promise<PendingChange[]>
    /** execute staged DML in one transaction */
    submit(queryId: string, edits: GridEdits): Promise<{ ok: boolean; applied: number; error?: string }>
    /** run every statement in the buffer, in order */
    runScript(req: QueryRequest): Promise<QueryResult[]>
    /** regenerate CREATE TABLE DDL for a relation */
    ddl(connectionId: string, schema: string, table: string): Promise<string>
    /** parsed EXPLAIN plan for the plan tree */
    explainPlan(connectionId: string, sql: string, analyze: boolean): Promise<PlanNode>
  }
  tx: {
    setMode(connectionId: string, mode: TxMode): Promise<ConnectionState>
    commit(connectionId: string): Promise<ConnectionState>
    rollback(connectionId: string): Promise<ConnectionState>
  }
  history: {
    search(term: string, limit?: number): Promise<HistoryEntry[]>
  }
  dba: {
    list(): Promise<DbaQueryInfo[]>
    run(connectionId: string, key: string): Promise<QueryResult>
  }
  workspace: {
    load(): Promise<WorkspaceState>
    save(state: WorkspaceState): Promise<void>
  }
  export: {
    csv(queryId: string, path: string): Promise<{ rows: number }>
    chooseSavePath(defaultName: string): Promise<string | null>
  }
}

/** One node of an EXPLAIN (FORMAT JSON) plan. */
export interface PlanNode {
  nodeType: string
  /** "Outer", "Inner", "InitPlan", "SubPlan" — how it hangs off its parent */
  relationship?: string
  subplanName?: string
  cteName?: string
  relation?: string
  alias?: string
  indexName?: string
  startupCost: number
  totalCost: number
  /** per-loop, exactly like actualRows — compare or scale them together */
  planRows: number
  planWidth: number
  /** per-loop average, as Postgres reports it */
  actualRows?: number
  loops: number
  workers?: number
  parallelAware?: boolean
  /** wall-clock for this node and its inputs, workers divided out */
  elapsedMs?: number
  /** elapsed minus its inputs: what this node itself cost */
  selfMs?: number
  filter?: string
  joinType?: string
  children: PlanNode[]
}

export interface DbaQueryInfo {
  key: string
  label: string
  group: string
  description: string
  requires?: string
}

export interface EditorTab {
  id: string
  title: string
  connectionId: string | null
  sql: string
}

export interface WorkspaceState {
  tabs: EditorTab[]
  activeTabId: string | null
  sidebarWidth: number
  resultsHeight: number
}

export const IPC = {
  connectionsList: 'connections:list',
  connectionsSave: 'connections:save',
  connectionsRemove: 'connections:remove',
  connectionsTest: 'connections:test',
  connectionsConnect: 'connections:connect',
  connectionsDisconnect: 'connections:disconnect',
  connectionsState: 'connections:state',
  connectionsImportDBeaver: 'connections:importDBeaver',
  catalogGet: 'catalog:get',
  queryRun: 'query:run',
  queryRunScript: 'query:runScript',
  queryDdl: 'query:ddl',
  queryExplainPlan: 'query:explainPlan',
  dbaList: 'dba:list',
  dbaRun: 'dba:run',
  queryFetchMore: 'query:fetchMore',
  queryCancel: 'query:cancel',
  queryClose: 'query:close',
  queryPreview: 'query:preview',
  querySubmit: 'query:submit',
  txSetMode: 'tx:setMode',
  txCommit: 'tx:commit',
  txRollback: 'tx:rollback',
  historySearch: 'history:search',
  workspaceLoad: 'workspace:load',
  workspaceSave: 'workspace:save',
  exportCsv: 'export:csv',
  exportChoosePath: 'export:choosePath'
} as const
