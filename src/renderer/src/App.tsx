import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { format } from 'sql-formatter'
import { statementAt } from '@shared/sql'
import type {
  Catalog, Cell, CellEdit, ConnectionConfig, ConnectionState, DbaQueryInfo, EditorTab,
  GridEdits, HistoryEntry, PlanNode, QueryResult, TableMeta, TxMode, WorkspaceState
} from '@shared/ipc'
import { editCount, emptyEdits } from '@shared/ipc'
import { setCatalog as setEditorCatalog } from './editor/monaco'
import { SqlEditor, disposeModel, type EditorApi } from './components/SqlEditor'
import { SchemaTree } from './components/SchemaTree'
import { ResultGrid } from './components/ResultGrid'
import { ConnectionDialog } from './components/ConnectionDialog'
import { StatusBar } from './components/StatusBar'
import { Palette, type PaletteItem } from './components/Palette'
import { PlanTree } from './components/PlanTree'
import { useSplitter } from './hooks/useSplitter'
import { renderCopy, type CopyFormat } from './copy'
import type { GridApi } from 'ag-grid-community'

/** Commands whose success invalidates the cached catalog. */
const DDL_COMMANDS = /^(CREATE|ALTER|DROP|TRUNCATE|COMMENT|GRANT|REVOKE|REFRESH)$/i

const newTab = (connectionId: string | null): EditorTab => ({
  id: crypto.randomUUID(),
  title: 'Console',
  connectionId,
  sql: ''
})

type Modal =
  | { kind: 'none' }
  | { kind: 'connection'; cfg: ConnectionConfig | null }
  | { kind: 'goToTable' }
  | { kind: 'history' }

// Mirror of the main-process net: a rejected IPC call must not blank the UI.
window.addEventListener('unhandledrejection', (e) => {
  console.error('[quarry] unhandled rejection in renderer:', e.reason)
  e.preventDefault()
})

export function App() {
  const [connections, setConnections] = useState<ConnectionConfig[]>([])
  const [states, setStates] = useState<Record<string, ConnectionState>>({})
  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<Catalog | null>(null)

  const [tabs, setTabs] = useState<EditorTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)

  const [results, setResults] = useState<QueryResult[]>([])
  const [activeResult, setActiveResult] = useState(0)
  const [edits, setEdits] = useState<GridEdits>(emptyEdits())
  const [preview, setPreview] = useState<string[]>([])
  const [filterText, setFilterText] = useState('')
  const [transposed, setTransposed] = useState(false)
  const [focus, setFocus] = useState<{ row: number | null; col: number | null }>({ row: null, col: null })
  const [ddlText, setDdlText] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [plan, setPlan] = useState<{ node: PlanNode; analyzed: boolean } | null>(null)
  const [dbaQueries, setDbaQueries] = useState<DbaQueryInfo[]>([])
  const [dbaOpen, setDbaOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [modal, setModal] = useState<Modal>({ kind: 'none' })
  const [history, setHistory] = useState<HistoryEntry[]>([])

  // connect() is defined below; the bootstrap effect reaches it through this ref.
  const connectRef = useRef<((id: string) => Promise<void>) | null>(null)
  /** SQL of the statement behind the active result, so submit can re-read it. */
  const lastRunSql = useRef<string | null>(null)
  const gridApi = useRef<GridApi | null>(null)
  const editorApi = useRef<EditorApi | null>(null)

  const sidebar = useSplitter(280, 'x')
  const resultsPane = useSplitter(320, 'y', true)

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  const result = results[activeResult] ?? null
  const pendingCount = editCount(edits)
  const activeState = activeConnectionId ? states[activeConnectionId] ?? null : null
  const txMode = activeState?.txMode ?? 'auto'
  const txStatus = activeState?.txStatus ?? 'idle'
  const connectedIds = useMemo(
    () => new Set(Object.values(states).filter((s) => s.connected).map((s) => s.id)),
    [states]
  )

  /* ---------- bootstrap ---------- */
  useEffect(() => {
    void (async () => {
      const [conns, ws] = await Promise.all([
        window.api.connections.list(),
        window.api.workspace.load()
      ])
      setConnections(conns)
      void window.api.dba.list().then(setDbaQueries)
      const restored = ws.tabs.length ? ws.tabs : [newTab(conns[0]?.id ?? null)]
      setTabs(restored)
      setActiveTabId(ws.activeTabId && restored.some((t) => t.id === ws.activeTabId) ? ws.activeTabId : restored[0].id)
      sidebar.setSize(ws.sidebarWidth || 280)
      resultsPane.setSize(ws.resultsHeight || 320)
      // A restored tab can name a connection that has since been deleted, so
      // fall back rather than trying to open one that no longer exists.
      const known = new Set(conns.map((c) => c.id))
      const remembered = restored.find((t) => t.connectionId && known.has(t.connectionId))?.connectionId
      const initial = remembered ?? conns[0]?.id ?? null

      if (initial) {
        // Repoint any tab left pointing at a connection that is gone.
        setTabs((ts) =>
          ts.map((t) => (t.connectionId && known.has(t.connectionId) ? t : { ...t, connectionId: initial }))
        )
      }
      setActiveConnectionId(initial)
      // Reopen the last session automatically, so the tree is usable on launch.
      if (initial) void connectRef.current?.(initial)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ---------- persist workspace (debounced) ---------- */
  const saveTimer = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!tabs.length) return
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      const state: WorkspaceState = {
        tabs,
        activeTabId,
        sidebarWidth: sidebar.size,
        resultsHeight: resultsPane.size
      }
      void window.api.workspace.save(state)
    }, 400)
  }, [tabs, activeTabId, sidebar.size, resultsPane.size])

  /* ---------- catalog follows the active connection ---------- */
  useEffect(() => {
    setEditorCatalog(catalog)
  }, [catalog])

  const loadCatalog = useCallback(async (id: string, refresh = false) => {
    try {
      const cat = await window.api.catalog.get(id, refresh)
      setCatalog(cat)
    } catch {
      setCatalog(null)
    }
  }, [])

  const refreshState = useCallback(async (id: string) => {
    const st = await window.api.connections.state(id)
    setStates((s) => ({ ...s, [id]: st }))
    return st
  }, [])

  const connect = useCallback(
    async (id: string) => {
      setBusy(true)
      try {
        const st = await window.api.connections.connect(id)
        setStates((s) => ({ ...s, [id]: st }))
        await loadCatalog(id)
      } catch (err) {
        setResults([errorResult((err as Error).message)])
      } finally {
        setBusy(false)
      }
    },
    [loadCatalog]
  )

  connectRef.current = connect

  const toggleConnection = useCallback(
    async (id: string) => {
      if (connectedIds.has(id)) {
        await window.api.connections.disconnect(id)
        setStates((s) => ({ ...s, [id]: { ...s[id], connected: false, txStatus: 'idle' } }))
        if (id === activeConnectionId) setCatalog(null)
      } else {
        await connect(id)
      }
    },
    [connectedIds, activeConnectionId, connect]
  )

  const selectConnection = useCallback(
    async (id: string) => {
      setActiveConnectionId(id)
      setTabs((ts) => ts.map((t) => (t.id === activeTabId ? { ...t, connectionId: id } : t)))
      if (!connectedIds.has(id)) await connect(id)
      else await loadCatalog(id)
    },
    [activeTabId, connectedIds, connect, loadCatalog]
  )

  /* ---------- query execution ---------- */
  /** Releases server cursors for results we are about to replace. */
  const releaseResults = useCallback((list: QueryResult[]) => {
    for (const r of list) {
      if (r.queryId) window.api.query.close(r.queryId).catch(() => undefined)
    }
  }, [])

  const afterRun = useCallback(
    async (next: QueryResult[], connectionId: string) => {
      setResults(next)
      // Focus the first result that actually returned rows, then any failure,
      // rather than parking on a bare "CREATE" at the top of a script.
      const withRows = next.findIndex((r) => !r.error && r.fields.length > 0)
      const failed = next.findIndex((r) => r.error)
      setActiveResult(withRows >= 0 ? withRows : failed >= 0 ? failed : 0)
      setEdits(emptyEdits())
      setPreview([])
      setFilterText('')
      setTransposed(false)
      await refreshState(connectionId)
      // DDL changes the catalog underneath us; reload so the tree and
      // completion do not go stale after a CREATE/ALTER/DROP.
      if (next.some((r) => !r.error && DDL_COMMANDS.test(r.command))) {
        await loadCatalog(connectionId, true)
      }
    },
    [refreshState, loadCatalog]
  )

  const runOn = useCallback(
    async (sql: string, mode: 'statement' | 'script' | 'explain' | 'explainAnalyze') => {
      const connectionId = activeTab?.connectionId ?? activeConnectionId
      if (!connectionId || !sql.trim()) return
      if (!connectedIds.has(connectionId)) await connect(connectionId)

      setBusy(true)
      releaseResults(results)
      try {
        lastRunSql.current = mode === 'statement' ? sql : null
        if (mode === 'explain' || mode === 'explainAnalyze') {
          const analyzed = mode === 'explainAnalyze'
          // The previous result set is gone either way; leaving its staged edits
          // on screen left Submit buttons that silently did nothing.
          setResults([])
          setEdits(emptyEdits())
          setPreview([])
          setFilterText('')
          const node = await window.api.query.explainPlan(connectionId, sql, analyzed)
          setPlan({ node, analyzed })
          await refreshState(connectionId)
          return
        }
        setPlan(null)
        const next =
          mode === 'script'
            ? await window.api.query.runScript({ connectionId, sql })
            : [await window.api.query.run({ connectionId, sql })]
        await afterRun(next, connectionId)
      } catch (err) {
        // Without clearing the plan, a failed EXPLAIN kept the previous query's
        // tree on screen and the error was never rendered at all.
        setPlan(null)
        setResults([errorResult((err as Error).message)])
        setActiveResult(0)
      } finally {
        setBusy(false)
      }
    },
    [activeTab, activeConnectionId, connectedIds, connect, results, releaseResults, afterRun, refreshState]
  )

  const execute = useCallback((sql: string) => void runOn(sql, 'statement'), [runOn])

  const runDba = useCallback(
    async (key: string) => {
      const connectionId = activeTab?.connectionId ?? activeConnectionId
      if (!connectionId) return
      if (!connectedIds.has(connectionId)) await connect(connectionId)
      setBusy(true)
      setPlan(null)
      releaseResults(results)
      try {
        const res = await window.api.dba.run(connectionId, key)
        lastRunSql.current = null
        await afterRun([res], connectionId)
      } catch (err) {
        setResults([errorResult((err as Error).message)])
        setActiveResult(0)
      } finally {
        setBusy(false)
      }
    },
    [activeTab, activeConnectionId, connectedIds, connect, results, releaseResults, afterRun]
  )

  /** The statement under the caret, or the selection when there is one. */
  const currentStatement = useCallback((): string => {
    const api = editorApi.current
    if (api) return api.currentStatement()
    // No editor mounted: fall back to the statement at the end of the buffer
    // rather than the whole buffer, which would run every statement at once.
    const sql = activeTab?.sql ?? ''
    return statementAt(sql, sql.length)?.text ?? sql
  }, [activeTab])

  const fetchMore = useCallback(async () => {
    if (!result || result.complete) return
    const more = await window.api.query.fetchMore(result.queryId, 500)
    setResults((rs) => rs.map((r, i) => (i === activeResult ? more : r)))
  }, [result, activeResult])

  const cancel = useCallback(async () => {
    if (result?.queryId) await window.api.query.cancel(result.queryId)
  }, [result])

  /**
   * The table ⌘⇧D acts on when the result set is not editable: the tree
   * selection first, then whatever was last opened.
   */
  const lastOpenedTable = useRef<{ schema: string; table: string } | null>(null)
  const selectedTable = useRef<{ schema: string; table: string } | null>(null)

  /* ---------- staged edits ---------- */
  const addEdit = useCallback((edit: CellEdit) => {
    setEdits((prev) => {
      const key = `${edit.rowIndex}:${edit.columnIndex}`
      const existing = prev.updates.find((e) => `${e.rowIndex}:${e.columnIndex}` === key)
      const rest = prev.updates.filter((e) => `${e.rowIndex}:${e.columnIndex}` !== key)
      // Editing a cell back to its original value un-stages it entirely.
      const original = existing?.oldValue ?? edit.oldValue
      if (edit.newValue === original) return { ...prev, updates: rest }
      return { ...prev, updates: [...rest, { ...edit, oldValue: original }] }
    })
  }, [])

  const editInsert = useCallback((rowId: string, columnIndex: number, value: Cell) => {
    setEdits((prev) => ({
      ...prev,
      inserts: prev.inserts.map((r) =>
        r.id === rowId ? { ...r, values: { ...r.values, [columnIndex]: value } } : r
      )
    }))
  }, [])

  const addRow = useCallback(() => {
    if (!result?.editable) return
    setEdits((prev) => ({ ...prev, inserts: [...prev.inserts, { id: crypto.randomUUID(), values: {} }] }))
  }, [result])

  const deleteRow = useCallback(() => {
    if (!result?.editable || focus.row === null) return
    if (focus.row < 0) {
      // A staged insert is discarded outright rather than turned into a DELETE.
      const i = -focus.row - 1
      setEdits((prev) => ({ ...prev, inserts: prev.inserts.filter((_r, k) => k !== i) }))
      return
    }
    const rowIndex = focus.row
    setEdits((prev) => ({
      ...prev,
      deletes: prev.deletes.includes(rowIndex)
        ? prev.deletes.filter((d) => d !== rowIndex)
        : [...prev.deletes, rowIndex]
    }))
  }, [result, focus])

  const setNull = useCallback(() => {
    if (!result?.editable || focus.row === null || focus.col === null) return
    if (focus.row < 0) {
      const row = edits.inserts[-focus.row - 1]
      if (row) editInsert(row.id, focus.col, null)
      return
    }
    const current = result.rows[focus.row]?.[focus.col] ?? null
    if (current === null) return
    addEdit({ rowIndex: focus.row, columnIndex: focus.col, oldValue: current, newValue: null })
  }, [result, focus, edits.inserts, editInsert, addEdit])

  const revertEdits = useCallback(() => {
    setEdits(emptyEdits())
    setPreview([])
  }, [])

  useEffect(() => {
    if (!result || pendingCount === 0) {
      setPreview([])
      return
    }
    let cancelled = false
    void window.api.query
      .preview(result.queryId, edits)
      .then((changes) => {
        if (!cancelled) setPreview(changes.map((c) => renderPreview(c.sql, c.params)))
      })
      .catch((e: Error) => setPreview([`-- ${e.message}`]))
    return () => {
      cancelled = true
    }
  }, [edits, result, pendingCount])

  const submit = useCallback(async () => {
    if (!result || pendingCount === 0) return
    setBusy(true)
    try {
      const res = await window.api.query.submit(result.queryId, edits)
      if (res.ok) {
        // Re-run the statement so inserts and deletes are reflected honestly
        // rather than patched into a stale client-side copy.
        setEdits(emptyEdits())
        setPreview([])
        const sql = lastRunSql.current
        if (sql && activeConnectionId) {
          const fresh = await window.api.query.run({ connectionId: activeConnectionId, sql })
          setResults((rs) => rs.map((r, i) => (i === activeResult ? fresh : r)))
        }
      } else {
        setResults((rs) =>
          rs.map((r, i) => (i === activeResult ? { ...r, error: { message: res.error ?? 'Submit failed' } } : r))
        )
      }
      if (activeConnectionId) await refreshState(activeConnectionId)
    } finally {
      setBusy(false)
    }
  }, [result, edits, pendingCount, activeConnectionId, activeResult, refreshState])

  /* ---------- transactions ---------- */
  const setTxMode = useCallback(
    async (mode: TxMode) => {
      if (!activeConnectionId) return
      // Leaving manual mode rolls the open transaction back — never silently.
      if (
        mode === 'auto' &&
        states[activeConnectionId]?.txStatus === 'active' &&
        !window.confirm(
          'Switching to auto-commit will ROLL BACK the open transaction and discard its uncommitted changes.\n\nContinue?'
        )
      ) {
        return
      }
      const st = await window.api.tx.setMode(activeConnectionId, mode)
      setStates((s) => ({ ...s, [activeConnectionId]: st }))
    },
    [activeConnectionId, states]
  )
  const commit = useCallback(async () => {
    if (!activeConnectionId) return
    const st = await window.api.tx.commit(activeConnectionId)
    setStates((s) => ({ ...s, [activeConnectionId]: st }))
  }, [activeConnectionId])
  const rollback = useCallback(async () => {
    if (!activeConnectionId) return
    const st = await window.api.tx.rollback(activeConnectionId)
    setStates((s) => ({ ...s, [activeConnectionId]: st }))
    setEdits(emptyEdits())
  }, [activeConnectionId])

  /* ---------- tabs ---------- */
  const addTab = useCallback(() => {
    const t = newTab(activeConnectionId)
    setTabs((ts) => [...ts, t])
    setActiveTabId(t.id)
  }, [activeConnectionId])

  const closeTab = useCallback(
    (id: string) => {
      setTabs((ts) => {
        const next = ts.filter((t) => t.id !== id)
        disposeModel(id)
        if (!next.length) {
          const fresh = newTab(activeConnectionId)
          setActiveTabId(fresh.id)
          return [fresh]
        }
        if (id === activeTabId) setActiveTabId(next[next.length - 1].id)
        return next
      })
    },
    [activeTabId, activeConnectionId]
  )

  const setTabSql = useCallback((sql: string) => {
    setTabs((ts) => ts.map((t) => (t.id === activeTabIdRef.current ? { ...t, sql, title: titleFor(sql) } : t)))
  }, [])
  const activeTabIdRef = useRef<string | null>(null)
  activeTabIdRef.current = activeTabId

  /* ---------- Ctrl+Tab toggles back to the previously active tab ---------- */
  const prevTabId = useRef<string | null>(null)
  const lastSeenTabId = useRef<string | null>(null)
  useEffect(() => {
    if (lastSeenTabId.current && lastSeenTabId.current !== activeTabId) {
      prevTabId.current = lastSeenTabId.current
    }
    lastSeenTabId.current = activeTabId
  }, [activeTabId])

  const tabsRef = useRef<EditorTab[]>([])
  tabsRef.current = tabs
  const modalKindRef = useRef<Modal['kind']>('none')
  modalKindRef.current = modal.kind

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.key !== 'Tab' || e.metaKey || e.altKey || e.shiftKey) return
      if (modalKindRef.current !== 'none') return
      e.preventDefault()
      e.stopPropagation()
      const ts = tabsRef.current
      if (ts.length < 2) return
      const current = activeTabIdRef.current
      const prev = prevTabId.current
      // MRU toggle, the way ⌃Tab flips between two consoles in an IDE. When
      // the previous tab is gone (closed, or never existed), fall back to the
      // next tab in strip order so the key still does something useful.
      const target =
        prev && prev !== current && ts.some((t) => t.id === prev)
          ? prev
          : ts[(ts.findIndex((t) => t.id === current) + 1) % ts.length].id
      setActiveTabId(target)
    }
    // Capture phase so Monaco and the grid never see the keystroke.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const formatSql = useCallback(() => {
    if (!activeTab?.sql.trim()) return
    try {
      const pretty = format(activeTab.sql, { language: 'postgresql', keywordCase: 'upper' })
      setTabs((ts) => ts.map((t) => (t.id === activeTabId ? { ...t, sql: pretty } : t)))
    } catch {
      /* leave unformatted if the statement is too broken to parse */
    }
  }, [activeTab, activeTabId])

  const openTable = useCallback(
    (t: TableMeta) => {
      lastOpenedTable.current = { schema: t.schema, table: t.name }
      const sql = `SELECT *\nFROM ${t.schema}.${t.name}\nLIMIT 500;`
      const tab = { ...newTab(activeConnectionId), sql, title: t.name }
      setTabs((ts) => [...ts, tab])
      setActiveTabId(tab.id)
      void runOn(sql.replace(/;\s*$/, ''), 'statement')
    },
    [activeConnectionId, runOn]
  )

  const notify = useCallback((label: string) => {
    setCopied(label)
    window.setTimeout(() => setCopied(null), 1800)
  }, [])

  /**
   * Copies the selection, or everything left after the filter when nothing is
   * selected — the same rule DataGrip's grid copy follows.
   */
  const copyAs = useCallback(
    async (format: CopyFormat) => {
      const api = gridApi.current
      if (!result || !api) return
      const rows: Cell[][] = []

      if (transposed) {
        // The grid's rows are result columns here; selection there does not
        // name data rows, so copy the whole result instead.
        rows.push(...result.rows)
      } else {
        const nodes = api.getSelectedNodes()
        const collect = (data: Record<string, unknown> | undefined): void => {
          if (!data) return
          rows.push(result.fields.map((_f, i) => (data[`c${i}`] ?? null) as Cell))
        }
        if (nodes.length) nodes.forEach((n) => collect(n.data as Record<string, unknown>))
        else api.forEachNodeAfterFilterAndSort((n) => collect(n.data as Record<string, unknown>))
      }

      if (!rows.length) return
      await navigator.clipboard.writeText(renderCopy(result, rows, format))
      notify(`${rows.length} row${rows.length === 1 ? '' : 's'} as ${format.toUpperCase()}`)
    },
    [result, transposed, notify]
  )

  const exportCsv = useCallback(async () => {
    if (!result || result.error) return
    const path = await window.api.export.chooseSavePath(`${activeTab?.title ?? 'result'}.csv`)
    if (!path) return
    setBusy(true)
    try {
      await window.api.export.csv(result.queryId, path)
    } finally {
      setBusy(false)
    }
  }, [result, activeTab])

  /* ---------- menu wiring ---------- */
  const showDdl = useCallback(async (explicit?: { schema: string; table: string }) => {
    const t =
      explicit ??
      selectedTable.current ??
      (result?.editable
        ? { schema: result.editable.schema, table: result.editable.table }
        : lastOpenedTable.current)
    if (!activeConnectionId) return
    if (!t) {
      setDdlText('-- Select a table in the tree first, or run a query against one.')
      return
    }
    try {
      setDdlText(await window.api.query.ddl(activeConnectionId, t.schema, t.table))
    } catch (err) {
      setDdlText(`-- ${(err as Error).message}`)
    }
  }, [result, activeConnectionId])

  const actions = useRef<Record<string, () => void>>({})
  actions.current = {
    'menu:newTab': addTab,
    'menu:closeTab': () => activeTabId && closeTab(activeTabId),
    'menu:newConnection': () => setModal({ kind: 'connection', cfg: null }),
    // Cmd+Enter lands here (the native menu owns the accelerator): first press
    // highlights the statement, Enter or a second Cmd+Enter runs it.
    'menu:execute': () => {
      if (!editorApi.current?.armOrRun()) void runOn(currentStatement(), 'statement')
    },
    'menu:runScript': () => activeTab?.sql && void runOn(activeTab.sql, 'script'),
    'menu:explain': () => void runOn(currentStatement(), 'explain'),
    'menu:explainAnalyze': () => void runOn(currentStatement(), 'explainAnalyze'),
    'menu:cancel': () => void cancel(),
    'menu:commit': () => void commit(),
    'menu:rollback': () => void rollback(),
    'menu:format': formatSql,
    'menu:refresh': () => activeConnectionId && void loadCatalog(activeConnectionId, true),
    'menu:goToTable': () => setModal({ kind: 'goToTable' }),
    'menu:history': () => {
      void window.api.history.search('').then(setHistory)
      setModal({ kind: 'history' })
    },
    'menu:exportCsv': () => void exportCsv(),
    'menu:addRow': addRow,
    'menu:deleteRow': deleteRow,
    'menu:setNull': setNull,
    'menu:ddl': () => void showDdl()
  }

  useEffect(() => {
    const offs = Object.keys(actions.current).map((ch) =>
      window.menu.on(ch, () => actions.current[ch]?.())
    )
    return () => offs.forEach((off) => off())
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && modal.kind !== 'none') setModal({ kind: 'none' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modal])

  /* ---------- render ---------- */
  const tableItems: PaletteItem[] = useMemo(
    () =>
      catalog?.schemas.flatMap((s) =>
        s.tables.map((t) => ({
          id: `${s.name}.${t.name}`,
          label: t.name,
          sub: `${s.name} · ${t.columns.length} cols`
        }))
      ) ?? [],
    [catalog]
  )

  return (
    <div className="app">
      <div className="titlebar">
        <span className="brand">QUARRY</span>
        <span className="spacer" />
        <span className="dba-menu">
          <button className="ghost" onClick={() => setDbaOpen((v) => !v)} title="Database diagnostics">
            DBA ▾
          </button>
          {dbaOpen && (
            <div className="dba-list" onMouseLeave={() => setDbaOpen(false)}>
              {[...new Set(dbaQueries.map((q) => q.group))].map((group) => (
                <div key={group}>
                  <div className="q-group">{group}</div>
                  {dbaQueries
                    .filter((q) => q.group === group)
                    .map((q) => (
                      <div
                        key={q.key}
                        className="q-item"
                        onClick={() => {
                          setDbaOpen(false)
                          void runDba(q.key)
                        }}
                      >
                        {q.label}
                        {q.requires && <span className="sub">needs {q.requires}</span>}
                        <span className="sub">{q.description}</span>
                      </div>
                    ))}
                </div>
              ))}
            </div>
          )}
        </span>
        <button className="ghost" onClick={() => setModal({ kind: 'goToTable' })} title="Go to table (⌘O)">
          Go to Table
        </button>
        <button
          className="ghost"
          onClick={() => {
            void window.api.history.search('').then(setHistory)
            setModal({ kind: 'history' })
          }}
          title="Query history (⌘⌃E)"
        >
          History
        </button>
        {activeState?.connected && (
          <button
            className={txMode === 'manual' ? 'tx-mode manual' : 'ghost tx-mode'}
            onClick={() => void setTxMode(txMode === 'manual' ? 'auto' : 'manual')}
            title={
              txMode === 'manual'
                ? 'Manual commit: statements run inside a transaction you can inspect, then Commit or Rollback. Click to switch back to auto-commit.'
                : 'Auto-commit: every statement is permanent immediately. Click to run statements in a reviewable transaction instead.'
            }
          >
            {txMode === 'manual' ? '⏸ Manual commit' : 'Auto-commit'}
          </button>
        )}
        {txMode === 'manual' && txStatus !== 'idle' && (
          <>
            <span className={`q-pill ${txStatus === 'failed' ? 'tx-failed' : 'tx-active'}`}>
              {txStatus === 'failed' ? 'TX failed' : 'TX open'}
            </span>
            {/* An aborted transaction can only be rolled back; Postgres would
                turn COMMIT into ROLLBACK anyway. */}
            <button onClick={() => void commit()} disabled={busy || txStatus === 'failed'} title="Commit the open transaction (⌘⌥⏎)">
              Commit
            </button>
            <button onClick={() => void rollback()} disabled={busy} title="Discard the open transaction (⌘⌥Z)">
              Rollback
            </button>
          </>
        )}
        <button
          className="primary"
          onClick={() => void runOn(currentStatement(), 'statement')}
          disabled={busy}
          title="Run the statement under the caret (⌘⏎)"
        >
          ▶ Run
        </button>
        <button
          onClick={() => activeTab?.sql && void runOn(activeTab.sql, 'script')}
          disabled={busy}
          title="Run every statement in this console (⌘⇧⏎)"
        >
          ⏩ Run Script
        </button>
        <button
          className="ghost"
          onClick={() => void runOn(currentStatement(), 'explain')}
          disabled={busy}
          title="Explain plan (⌘⇧P)"
        >
          Explain
        </button>
      </div>

      <div className="app-body">
        <div className="sidebar" style={{ width: sidebar.size }}>
          <SchemaTree
            connections={connections}
            activeConnectionId={activeConnectionId}
            connectedIds={connectedIds}
            catalog={catalog}
            onSelectConnection={(id) => void selectConnection(id)}
            onToggleConnection={(id) => void toggleConnection(id)}
            onOpenTable={openTable}
            onSelectTable={(t) => {
              selectedTable.current = t ? { schema: t.schema, table: t.name } : null
            }}
            onShowDdl={(t) => void showDdl({ schema: t.schema, table: t.name })}
            onEditConnection={(cfg) => setModal({ kind: 'connection', cfg })}
          />
        </div>
        <div
          className={`split-v${sidebar.dragging ? ' active' : ''}`}
          onMouseDown={sidebar.onMouseDown}
        />

        <div className="q-main">
          <div className="tabstrip">
            {tabs.map((t) => (
              <div
                key={t.id}
                className={`q-tab${t.id === activeTabId ? ' active' : ''}`}
                onClick={() => setActiveTabId(t.id)}
              >
                <span>{t.title}</span>
                <span
                  className="q-close"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(t.id)
                  }}
                >
                  ×
                </span>
              </div>
            ))}
            <div className="q-tab" onClick={addTab} title="New console (⌘N)">
              +
            </div>
          </div>

          <div className="editor-pane">
            {activeTab && (
              <SqlEditor
                tabId={activeTab.id}
                value={activeTab.sql}
                catalog={catalog}
                onGoToDefinition={(schema, name) => {
                  const t = catalog?.schemas.find((s) => s.name === schema)?.tables.find((x) => x.name === name)
                  if (t) openTable(t)
                }}
                onChange={setTabSql}
                onReady={(api) => {
                  editorApi.current = api
                }}
                onRunScript={() => activeTab.sql && void runOn(activeTab.sql, 'script')}
                onExplain={(analyze) => void runOn(currentStatement(), analyze ? 'explainAnalyze' : 'explain')}
                onExecute={(sql) => void execute(sql)}
                onFormat={formatSql}
                errorPosition={result?.error?.position}
                errorMessage={result?.error?.message}
              />
            )}
          </div>

          <div
            className={`split-h${resultsPane.dragging ? ' active' : ''}`}
            onMouseDown={resultsPane.onMouseDown}
          />

          <div className="results-pane" style={{ height: resultsPane.size }}>
            {results.length > 1 && (
              <div className="result-tabs">
                {results.map((r, i) => (
                  <div
                    key={i}
                    className={`result-tab${i === activeResult ? ' active' : ''}${r.error ? ' failed' : ''}`}
                    onClick={() => setActiveResult(i)}
                    title={r.error?.message ?? r.command}
                  >
                    {r.error ? '✕ ' : ''}
                    {i + 1}. {r.command || 'stmt'}
                    {r.rowCount !== null ? ` (${r.rowCount})` : ''}
                    {/* Notices are easy to miss on a tab that is not focused. */}
                    {r.notices.length > 0 && <span className="tab-notice" title="has notices">●</span>}
                  </div>
                ))}
              </div>
            )}

            <div className="results-toolbar">
              <span style={{ color: 'var(--text-dim)' }}>
                {result?.error
                  ? 'failed'
                  : plan
                    ? `query plan · ${plan.analyzed ? 'analyzed' : 'estimated'}`
                    : result?.editable
                      ? `${result.editable.schema}.${result.editable.table} · editable`
                      : result && !result.error
                        ? 'read-only result'
                        : 'Results'}
              </span>

              {result?.editable && (
                <>
                  <button className="ghost" onClick={addRow} title="Add row (⌘⌥N)">+ Row</button>
                  <button
                    className="ghost"
                    onClick={deleteRow}
                    disabled={focus.row === null}
                    title="Delete row (⌘⌫)"
                  >
                    − Row
                  </button>
                  <button
                    className="ghost"
                    onClick={setNull}
                    disabled={focus.row === null || focus.col === null}
                    title="Set NULL (⌘⌥0)"
                  >
                    NULL
                  </button>
                </>
              )}

              <span className="spacer" />

              {result && result.fields.length > 0 && (
                <>
                  <button
                    className={transposed ? 'primary' : 'ghost'}
                    onClick={() => setTransposed((v) => !v)}
                    title="Swap rows and columns"
                  >
                    ⇄ Transpose
                  </button>
                  <input
                    className="filter-box"
                    placeholder="Filter rows…"
                    value={filterText}
                    onChange={(e) => setFilterText(e.target.value)}
                    spellCheck={false}
                  />
                </>
              )}
              {result && !result.complete && (
                <button className="ghost" onClick={() => void fetchMore()}>Load more</button>
              )}
              {busy && <button className="ghost" onClick={() => void cancel()}>Cancel</button>}
              {pendingCount > 0 && (
                <>
                  <button onClick={revertEdits}>Revert</button>
                  <button className="primary" onClick={() => void submit()}>Submit {pendingCount}</button>
                </>
              )}
              <button className="ghost" onClick={() => void showDdl()} title="Show DDL (⌘⇧D)">DDL</button>
              <select
                className="copy-as"
                value=""
                onChange={(e) => {
                  const f = e.target.value as CopyFormat
                  e.target.value = ''
                  if (f) void copyAs(f)
                }}
                title="Copy selected rows, or all rows when nothing is selected"
                disabled={!result || !!result.error || result.fields.length === 0}
              >
                <option value="">Copy as…</option>
                <option value="csv">CSV</option>
                <option value="json">JSON</option>
                <option value="insert">INSERT</option>
              </select>
              <button className="ghost" onClick={() => void exportCsv()} disabled={!result || !!result.error}>
                Export CSV
              </button>
            </div>

            <div className="results-body">
              {result?.error ? (
                <div className="error-panel">
                  {result.error.message}
                  {result.error.detail && `\n\n${result.error.detail}`}
                  {result.error.hint && <div className="hint">Hint: {result.error.hint}</div>}
                </div>
              ) : plan ? (
                <PlanTree plan={plan.node} analyzed={plan.analyzed} />
              ) : result?.error ? (
                <div className="error-panel">
                  {result.error.message}
                  {result.error.detail && `\n\n${result.error.detail}`}
                  {result.error.hint && <div className="hint">Hint: {result.error.hint}</div>}
                </div>
              ) : result && result.fields.length > 0 ? (
                <ResultGrid
                  result={result}
                  edits={edits}
                  filterText={filterText}
                  transposed={transposed}
                  onEdit={addEdit}
                  onInsertEdit={editInsert}
                  onFocusRow={(row, col) => setFocus({ row, col })}
                  onApiReady={(api) => {
                    gridApi.current = api
                  }}
                  onNeedMore={() => void fetchMore()}
                  onCopied={notify}
                />
              ) : result ? (
                <div className="q-empty">
                  {result.command || 'Statement'} completed
                  {result.rowCount !== null ? ` · ${result.rowCount} rows affected` : ''}
                </div>
              ) : (
                <div className="q-empty">Press ⌘⏎ to run the statement under the caret.</div>
              )}
            </div>

            {!!result?.notices.length && (
              <div className="notices">
                {result.notices.map((n, i) => (
                  <div className="q-item" key={i}>{n}</div>
                ))}
              </div>
            )}

            {preview.length > 0 && (
              <div className="changes">
                {preview.map((sql, i) => (
                  <div className="q-item" key={i}>{sql}</div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <StatusBar
        connectionName={connections.find((c) => c.id === activeConnectionId)?.name ?? null}
        state={activeState}
        result={result}
        pendingEdits={pendingCount}
        notice={copied}
        busy={busy}
        onSetTxMode={(m) => void setTxMode(m)}
        onCommit={() => void commit()}
        onRollback={() => void rollback()}
      />

      {modal.kind === 'connection' && (
        <ConnectionDialog
          initial={modal.cfg}
          onCancel={() => setModal({ kind: 'none' })}
          onSaved={(cfg) => {
            setModal({ kind: 'none' })
            void window.api.connections.list().then((list) => {
              setConnections(list)
              void selectConnection(cfg.id)
            })
          }}
          onDeleted={(id) => {
            setModal({ kind: 'none' })
            void window.api.connections.remove(id).then(async () => {
              const list = await window.api.connections.list()
              setConnections(list)
              const fallback = list[0]?.id ?? null
              setTabs((ts) => ts.map((t) => (t.connectionId === id ? { ...t, connectionId: fallback } : t)))
              if (id === activeConnectionId) {
                setActiveConnectionId(fallback)
                setCatalog(null)
              }
            })
          }}
        />
      )}

      {ddlText !== null && (
        <div className="q-overlay" onMouseDown={() => setDdlText(null)}>
          <div className="q-modal wide" onMouseDown={(e) => e.stopPropagation()}>
            <h2>DDL</h2>
            <div className="q-body" style={{ padding: 0 }}>
              <pre className="ddl">{ddlText}</pre>
            </div>
            <div className="q-footer">
              <div className="spacer" />
              <button onClick={() => void navigator.clipboard.writeText(ddlText)}>Copy</button>
              <button className="primary" onClick={() => setDdlText(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {modal.kind === 'goToTable' && (
        <Palette
          placeholder="Go to table…"
          items={tableItems}
          onClose={() => setModal({ kind: 'none' })}
          onPick={(item) => {
            const [schema, name] = item.id.split('.')
            const t = catalog?.schemas.find((s) => s.name === schema)?.tables.find((x) => x.name === name)
            setModal({ kind: 'none' })
            if (t) openTable(t)
          }}
        />
      )}

      {modal.kind === 'history' && (
        <Palette
          placeholder="Search query history…"
          items={history.map((h) => ({
            id: String(h.id),
            label: new Date(h.startedAt).toLocaleString(),
            sub: h.error ? 'error' : `${h.rowCount ?? 0} rows · ${h.durationMs} ms`,
            mono: h.sql.replace(/\s+/g, ' ').slice(0, 160)
          }))}
          onQueryChange={(q) => void window.api.history.search(q).then(setHistory)}
          onClose={() => setModal({ kind: 'none' })}
          onPick={(item) => {
            const entry = history.find((h) => String(h.id) === item.id)
            setModal({ kind: 'none' })
            if (!entry) return
            const tab = { ...newTab(activeConnectionId), sql: entry.sql, title: titleFor(entry.sql) }
            setTabs((ts) => [...ts, tab])
            setActiveTabId(tab.id)
          }}
        />
      )}
    </div>
  )
}

function titleFor(sql: string): string {
  const first = sql.trim().split(/\s+/).slice(0, 3).join(' ')
  return first ? first.slice(0, 24) : 'Console'
}

function renderPreview(sql: string, params: (string | null)[]): string {
  return sql.replace(/\$(\d+)/g, (_m, n: string) => {
    const p = params[Number(n) - 1]
    return p === null || p === undefined ? 'NULL' : `'${String(p).replace(/'/g, "''")}'`
  })
}

/**
 * Electron wraps a rejected handler as
 * `Error invoking remote method 'query:run': error: <the real message>`.
 * Users should see the database's words, not the IPC plumbing.
 */
function cleanError(message: string): string {
  return message
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(Error|error):\s*/, '')
}

function errorResult(message: string): QueryResult {
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
    error: { message: cleanError(message) }
  }
}
