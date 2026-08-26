import { contextBridge, ipcRenderer } from 'electron'
import type { Api, GridEdits, ConnectionConfig, QueryRequest, TxMode, WorkspaceState } from '@shared/ipc'
import { IPC } from '@shared/ipc'

const invoke = ipcRenderer.invoke.bind(ipcRenderer)

/**
 * The only surface the renderer gets. contextIsolation stays on and Node stays
 * out of the renderer; every database call crosses this typed boundary.
 */
const api: Api = {
  connections: {
    list: () => invoke(IPC.connectionsList),
    save: (cfg: ConnectionConfig, password?: string) => invoke(IPC.connectionsSave, cfg, password),
    remove: (id: string) => invoke(IPC.connectionsRemove, id),
    test: (cfg: ConnectionConfig, password?: string) => invoke(IPC.connectionsTest, cfg, password),
    connect: (id: string) => invoke(IPC.connectionsConnect, id),
    disconnect: (id: string) => invoke(IPC.connectionsDisconnect, id),
    state: (id: string) => invoke(IPC.connectionsState, id),
    importFromDBeaver: () => invoke(IPC.connectionsImportDBeaver)
  },
  catalog: {
    get: (id: string, refresh?: boolean) => invoke(IPC.catalogGet, id, refresh)
  },
  query: {
    run: (req: QueryRequest) => invoke(IPC.queryRun, req),
    fetchMore: (queryId: string, count: number) => invoke(IPC.queryFetchMore, queryId, count),
    cancel: (queryId: string) => invoke(IPC.queryCancel, queryId),
    close: (queryId: string) => invoke(IPC.queryClose, queryId),
    preview: (queryId: string, edits: GridEdits) => invoke(IPC.queryPreview, queryId, edits),
    submit: (queryId: string, edits: GridEdits) => invoke(IPC.querySubmit, queryId, edits),
    runScript: (req: QueryRequest) => invoke(IPC.queryRunScript, req),
    ddl: (id: string, schema: string, table: string) => invoke(IPC.queryDdl, id, schema, table),
    explainPlan: (id: string, sql: string, analyze: boolean) => invoke(IPC.queryExplainPlan, id, sql, analyze)
  },
  tx: {
    setMode: (id: string, mode: TxMode) => invoke(IPC.txSetMode, id, mode),
    commit: (id: string) => invoke(IPC.txCommit, id),
    rollback: (id: string) => invoke(IPC.txRollback, id)
  },
  history: {
    search: (term: string, limit?: number) => invoke(IPC.historySearch, term, limit)
  },
  dba: {
    list: () => invoke(IPC.dbaList),
    run: (id: string, key: string) => invoke(IPC.dbaRun, id, key)
  },
  workspace: {
    load: () => invoke(IPC.workspaceLoad),
    save: (state: WorkspaceState) => invoke(IPC.workspaceSave, state)
  },
  export: {
    csv: (queryId: string, path: string) => invoke(IPC.exportCsv, queryId, path),
    chooseSavePath: (defaultName: string) => invoke(IPC.exportChoosePath, defaultName)
  }
}

const MENU_CHANNELS = [
  'menu:newTab', 'menu:closeTab', 'menu:newConnection', 'menu:execute', 'menu:cancel',
  'menu:commit', 'menu:rollback', 'menu:format', 'menu:refresh', 'menu:goToTable',
  'menu:history', 'menu:exportCsv', 'menu:runScript', 'menu:explain', 'menu:explainAnalyze',
  'menu:ddl', 'menu:addRow', 'menu:deleteRow', 'menu:setNull'
] as const

contextBridge.exposeInMainWorld('api', api)
contextBridge.exposeInMainWorld('menu', {
  on(channel: string, cb: () => void): () => void {
    if (!MENU_CHANNELS.includes(channel as (typeof MENU_CHANNELS)[number])) {
      throw new Error(`Unknown menu channel: ${channel}`)
    }
    const listener = (): void => cb()
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
})
