import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GridEdits, ConnectionConfig, QueryRequest, TxMode, WorkspaceState } from '@shared/ipc'
import { IPC } from '@shared/ipc'
import { Session } from './session'
import { importFromDBeaver, listConnections, removeConnection, saveConnection } from './store/connections'
import { search as searchHistory } from './store/history'
import { readJson, writeJson } from './store/json'

const dirname = fileURLToPath(new URL('.', import.meta.url))
const session = new Session()
let mainWindow: BrowserWindow | null = null
/** Set once the user has answered the uncommitted-transaction prompt. */
let transactionsResolved = false

/**
 * Closing or quitting with work sitting in an uncommitted transaction would
 * silently roll it back. Make the choice explicit.
 *
 * Returns true when the caller should cancel its close/quit; `proceed` runs
 * once the user has decided.
 */
function guardTransactions(proceed: () => void): boolean {
  const open = session.openTransactions()
  if (!open.length || !mainWindow) return false

  void (async () => {
    const { response } = await dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      buttons: ['Commit and Close', 'Roll Back and Close', 'Cancel'],
      defaultId: 2,
      cancelId: 2,
      message: 'An open transaction has uncommitted changes',
      detail: `${open.map((c) => c.name).join(', ')} — closing now would discard them.`
    })
    if (response === 2) return
    for (const c of open) {
      if (response === 0) await session.commit(c.id).catch(() => undefined)
      else await session.rollback(c.id).catch(() => undefined)
    }
    transactionsResolved = true
    proceed()
  })()
  return true
}

function nameOf(id: string): string {
  return listConnections().find((c) => c.id === id)?.name ?? 'unknown'
}

function requireConfig(id: string): ConnectionConfig {
  const cfg = listConnections().find((c) => c.id === id)
  if (!cfg) throw new Error('No such connection')
  return cfg
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1e1f22',
    webPreferences: {
      preload: join(dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.on('close', (event) => {
    if (transactionsResolved) return
    if (guardTransactions(() => mainWindow?.close())) event.preventDefault()
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    // Surface renderer logs in the terminal; the signature changed across
    // Electron majors, so accept either shape.
    mainWindow.webContents.on(
      'console-message',
      (...args: unknown[]) => {
        const d = args[1] as { message?: string } | number
        const msg = typeof d === 'object' && d?.message ? d.message : String(args[2] ?? '')
        console.log('[renderer]', msg)
      }
    )
  }
  if (devUrl) void mainWindow.loadURL(devUrl)
  else void mainWindow.loadFile(join(dirname, '../renderer/index.html'))
}

/** Renderer-triggered actions, surfaced in the app menu with IntelliJ bindings. */
function send(channel: string): void {
  mainWindow?.webContents.send(channel)
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Console', accelerator: 'CmdOrCtrl+N', click: () => send('menu:newTab') },
        { label: 'Close Console', accelerator: 'CmdOrCtrl+W', click: () => send('menu:closeTab') },
        { type: 'separator' },
        { label: 'New Connection…', accelerator: 'CmdOrCtrl+Shift+N', click: () => send('menu:newConnection') },
        { label: 'Export Result to CSV…', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('menu:exportCsv') },
        { type: 'separator' },
        isMac ? { role: 'close' as const } : { role: 'quit' as const }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'Query',
      submenu: [
        { label: 'Execute Statement', accelerator: 'CmdOrCtrl+Return', click: () => send('menu:execute') },
        { label: 'Execute Script', accelerator: 'CmdOrCtrl+Shift+Return', click: () => send('menu:runScript') },
        { label: 'Cancel Running', accelerator: 'CmdOrCtrl+Escape', click: () => send('menu:cancel') },
        { type: 'separator' },
        { label: 'Explain Plan', accelerator: 'CmdOrCtrl+Shift+P', click: () => send('menu:explain') },
        { label: 'Explain Analyze', accelerator: 'CmdOrCtrl+Alt+Shift+P', click: () => send('menu:explainAnalyze') },
        { type: 'separator' },
        { label: 'Commit', accelerator: 'CmdOrCtrl+Alt+Return', click: () => send('menu:commit') },
        { label: 'Rollback', accelerator: 'CmdOrCtrl+Alt+Z', click: () => send('menu:rollback') },
        { type: 'separator' },
        { label: 'Format Statement', accelerator: 'CmdOrCtrl+Alt+L', click: () => send('menu:format') },
        { label: 'Refresh Catalog', accelerator: 'CmdOrCtrl+R', click: () => send('menu:refresh') }
      ]
    },
    {
      label: 'Data',
      submenu: [
        { label: 'Add Row', accelerator: 'CmdOrCtrl+Alt+N', click: () => send('menu:addRow') },
        { label: 'Delete Row', accelerator: 'CmdOrCtrl+Alt+Backspace', click: () => send('menu:deleteRow') },
        { label: 'Set NULL', accelerator: 'CmdOrCtrl+Alt+0', click: () => send('menu:setNull') },
        { type: 'separator' },
        { label: 'Show DDL', accelerator: 'CmdOrCtrl+Shift+D', click: () => send('menu:ddl') }
      ]
    },
    {
      label: 'Navigate',
      submenu: [
        { label: 'Go to Table…', accelerator: 'CmdOrCtrl+O', click: () => send('menu:goToTable') },
        { label: 'Query History…', accelerator: 'CmdOrCtrl+Ctrl+E', click: () => send('menu:history') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' as const },
        { type: 'separator' as const },
        { role: 'resetZoom' as const },
        { role: 'zoomIn' as const },
        { role: 'zoomOut' as const },
        { type: 'separator' as const },
        // Deliberately no ⌘R reload: that accelerator belongs to Refresh Catalog.
        { label: 'Reload Window', accelerator: 'CmdOrCtrl+Alt+R', role: 'forceReload' as const },
        { role: 'toggleDevTools' as const }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerIpc(): void {
  const h = ipcMain.handle.bind(ipcMain)

  h(IPC.connectionsList, () => listConnections())
  h(IPC.connectionsSave, (_e, cfg: ConnectionConfig, password?: string) => saveConnection(cfg, password))
  h(IPC.connectionsRemove, async (_e, id: string) => {
    await session.disconnect(id)
    removeConnection(id)
  })
  h(IPC.connectionsTest, (_e, cfg: ConnectionConfig, password?: string) => session.test(cfg, password))
  h(IPC.connectionsConnect, (_e, id: string) => session.connect(requireConfig(id)))
  h(IPC.connectionsDisconnect, (_e, id: string) => session.disconnect(id))
  h(IPC.connectionsState, (_e, id: string) => session.state(id))
  h(IPC.connectionsImportDBeaver, () => importFromDBeaver())

  h(IPC.catalogGet, (_e, id: string, refresh?: boolean) => session.catalog(id, refresh))

  h(IPC.queryRun, (_e, req: QueryRequest) => session.run(req, nameOf(req.connectionId)))
  h(IPC.queryFetchMore, (_e, queryId: string, count: number) => session.fetchMore(queryId, count))
  h(IPC.queryCancel, (_e, queryId: string) => session.cancel(queryId))
  h(IPC.queryClose, (_e, queryId: string) => session.closeQuery(queryId))
  h(IPC.queryPreview, (_e, queryId: string, edits: GridEdits) => session.preview(queryId, edits))
  h(IPC.querySubmit, (_e, queryId: string, edits: GridEdits) => session.submit(queryId, edits))
  h(IPC.queryRunScript, (_e, req: QueryRequest) => session.runScript(req, nameOf(req.connectionId)))
  h(IPC.queryDdl, (_e, id: string, schema: string, table: string) => session.ddl(id, schema, table))
  h(IPC.queryExplainPlan, (_e, id: string, sql: string, analyze: boolean) =>
    session.explainPlan(id, sql, analyze)
  )
  h(IPC.dbaList, () => session.dbaQueries())
  h(IPC.dbaRun, (_e, id: string, key: string) => session.dba(id, key, nameOf(id)))

  h(IPC.txSetMode, (_e, id: string, mode: TxMode) => session.setTxMode(id, mode))
  h(IPC.txCommit, (_e, id: string) => session.commit(id))
  h(IPC.txRollback, (_e, id: string) => session.rollback(id))

  h(IPC.historySearch, (_e, term: string, limit?: number) => searchHistory(term, limit))

  h(IPC.workspaceLoad, () =>
    readJson<WorkspaceState>('workspace.json', {
      tabs: [],
      activeTabId: null,
      sidebarWidth: 280,
      resultsHeight: 320
    })
  )
  h(IPC.workspaceSave, (_e, state: WorkspaceState) => writeJson('workspace.json', state))

  h(IPC.exportCsv, (_e, queryId: string, path: string) => session.exportCsv(queryId, path))
  h(IPC.exportChoosePath, async (_e, defaultName: string) => {
    if (!mainWindow) return null
    const res = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    return res.canceled ? null : res.filePath
  })
}

/**
 * A database driver can reject after its caller has moved on — a cancelled
 * statement is the common case. Without this the main process would die and
 * take the window with it.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[quarry] unhandled rejection in main:', reason)
})

// Dev-only: lets a driver script attach over CDP to exercise the real UI.
if (process.env['ELECTRON_RENDERER_URL']) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

// Before whenReady: the app menu's About/Hide/Quit items and the userData path
// are all derived from this, and in dev the bundle is stock Electron.app.
app.setName('Quarry')

void app.whenReady().then(() => {
  registerIpc()
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (transactionsResolved) {
    session.shutdown().catch(() => undefined)
    return
  }
  // ⌘Q used to skip the prompt entirely and discard the transaction.
  if (guardTransactions(() => app.quit())) {
    event.preventDefault()
    return
  }
  session.shutdown().catch(() => undefined)
})
