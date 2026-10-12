import { useEffect, useMemo, useState } from 'react'
import type {
  Catalog, ConnectionConfig, RoutineMeta, SchemaMeta, SequenceMeta, SourceTarget, TableMeta, TypeMeta
} from '@shared/ipc'

interface Props {
  connections: ConnectionConfig[]
  activeConnectionId: string | null
  connectedIds: Set<string>
  catalog: Catalog | null
  onSelectConnection: (id: string) => void
  onToggleConnection: (id: string) => void
  onOpenTable: (table: TableMeta) => void
  /** single-click selection, so ⌘⇧D can target any table */
  onSelectTable: (table: TableMeta | null) => void
  onShowDdl: (table: TableMeta) => void
  /** opens a routine's, view's or trigger's CREATE statement in a new console */
  onOpenSource: (target: SourceTarget, title: string) => void
  /** drops text into the current console at the caret */
  onInsertText: (text: string) => void
  onRefresh: () => void
  onEditConnection: (cfg: ConnectionConfig) => void
}

type NodeKey = string

interface MenuItem {
  label: string
  run: () => void
}

/** DataGrip's per-schema folders, in DataGrip's order. */
type FolderKind = 'tables' | 'views' | 'matviews' | 'foreign' | 'routines' | 'sequences' | 'types'

const FOLDER_LABEL: Record<FolderKind, string> = {
  tables: 'tables',
  views: 'views',
  matviews: 'materialized views',
  foreign: 'foreign tables',
  routines: 'routines',
  sequences: 'sequences',
  types: 'types'
}

const EXPANDED_KEY = 'quarry.tree.expanded'

const ident = (s: string): string => (/^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`)
const qualified = (schema: string, name: string): string => `${ident(schema)}.${ident(name)}`

function loadExpanded(): Set<NodeKey> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

export function SchemaTree(props: Props) {
  const { connections, activeConnectionId, connectedIds, catalog } = props
  const [expanded, setExpanded] = useState<Set<NodeKey>>(loadExpanded)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<NodeKey | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)

  // Remember what was open across restarts, like an IDE's project view.
  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded]))
    } catch {
      /* storage unavailable: the tree just starts collapsed next time */
    }
  }, [expanded])

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  // Expand a connection as soon as it comes online, including on auto-connect,
  // so the schemas are visible without a second click.
  useEffect(() => {
    if (!activeConnectionId || !connectedIds.has(activeConnectionId)) return
    setExpanded((prev) => {
      const key = `conn:${activeConnectionId}`
      if (prev.has(key)) return prev
      return new Set(prev).add(key)
    })
  }, [activeConnectionId, connectedIds])

  const toggle = (key: NodeKey): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const openMenu = (e: React.MouseEvent, key: NodeKey, items: MenuItem[]): void => {
    e.preventDefault()
    e.stopPropagation()
    setSelected(key)
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  const needle = filter.trim().toLowerCase()

  // Filtering matches every object kind (and table columns); a schema survives
  // if anything under it does.
  const filtered = useMemo(() => {
    if (!catalog) return null
    if (!needle) return catalog.schemas
    const hit = (name: string, schema: string): boolean =>
      name.toLowerCase().includes(needle) || `${schema}.${name}`.toLowerCase().includes(needle)
    return catalog.schemas
      .map((s) => ({
        ...s,
        tables: s.tables.filter(
          (t) => hit(t.name, s.name) || t.columns.some((c) => c.name.toLowerCase().includes(needle))
        ),
        routines: (s.routines ?? []).filter((r) => hit(r.name, s.name)),
        sequences: (s.sequences ?? []).filter((q) => hit(q.name, s.name)),
        types: (s.types ?? []).filter((t) => hit(t.name, s.name))
      }))
      .filter((s) => objectCount(s) > 0)
  }, [catalog, needle])

  const totalTables = catalog?.schemas.reduce((n, s) => n + s.tables.length, 0) ?? 0
  const shownObjects = filtered?.reduce((n, s) => n + objectCount(s), 0) ?? 0
  // While filtering a modest result, open everything so matches are visible.
  const autoOpen = !!needle && shownObjects < 80

  const isOpen = (key: NodeKey): boolean => expanded.has(key) || autoOpen

  const renderTable = (c: ConnectionConfig, t: TableMeta, depth: number) => {
    const tk = `table:${c.id}:${t.schema}.${t.name}`
    const topen = expanded.has(tk)
    const isView = t.kind === 'view' || t.kind === 'matview'
    const q = qualified(t.schema, t.name)
    const items: MenuItem[] = [
      { label: 'Open Data', run: () => props.onOpenTable(t) },
      isView
        ? { label: 'Show Source', run: () => props.onOpenSource({ kind: 'view', schema: t.schema, name: t.name }, t.name) }
        : { label: 'Show DDL', run: () => props.onShowDdl(t) },
      { label: 'Insert SELECT into Console', run: () => props.onInsertText(`SELECT *\nFROM ${q};`) },
      { label: 'Copy Qualified Name', run: () => void navigator.clipboard.writeText(q) }
    ]
    return (
      <div key={tk}>
        <Row
          depth={depth}
          twisty={topen ? '▼' : '▶'}
          selected={selected === tk}
          onClick={() => {
            setSelected(tk)
            props.onSelectTable(t)
            toggle(tk)
          }}
          onDoubleClick={() => props.onOpenTable(t)}
          onContextMenu={(e) => {
            props.onSelectTable(t)
            openMenu(e, tk, items)
          }}
          title={t.comment ?? undefined}
        >
          <span className="tree-icon" style={{ color: isView ? 'var(--kind-view)' : 'var(--kind-table)' }}>
            {isView ? '◇' : '▦'}
          </span>
          <span className="q-label">{t.name}</span>
          {t.rowEstimate !== null && !isView && <span className="meta">{formatCount(t.rowEstimate)}</span>}
        </Row>
        {topen && <TableChildren conn={c} table={t} depth={depth + 1} expanded={expanded} toggle={toggle} {...{ selected, setSelected, openMenu }} onOpenSource={props.onOpenSource} />}
      </div>
    )
  }

  const renderRoutine = (c: ConnectionConfig, s: string, r: RoutineMeta, depth: number) => {
    const rk = `routine:${c.id}:${r.oid}`
    const sig = `${qualified(s, r.name)}(${r.args})`
    const call = r.kind === 'procedure' ? `CALL ${qualified(s, r.name)}();` : `SELECT ${qualified(s, r.name)}();`
    const open = (): void => props.onOpenSource({ kind: 'routine', oid: r.oid }, r.name)
    return (
      <Row
        key={rk}
        depth={depth}
        twisty=""
        selected={selected === rk}
        onClick={() => setSelected(rk)}
        onDoubleClick={open}
        onContextMenu={(e) =>
          openMenu(e, rk, [
            { label: 'Open Source', run: open },
            { label: `Insert ${r.kind === 'procedure' ? 'CALL' : 'SELECT'} into Console`, run: () => props.onInsertText(call) },
            { label: 'Copy Signature', run: () => void navigator.clipboard.writeText(sig) }
          ])
        }
        title={[`${r.kind} ${sig}`, r.returns && `returns ${r.returns}`, `language ${r.language}`, r.comment]
          .filter(Boolean)
          .join('\n')}
      >
        <span className="tree-icon" style={{ color: 'var(--kind-routine)' }}>{r.kind === 'procedure' ? 'ρ' : 'ƒ'}</span>
        <span className="q-label">
          {r.name}
          <span className="tree-dim">({r.args})</span>
        </span>
        {r.returns && <span className="meta">{shortType(r.returns)}</span>}
      </Row>
    )
  }

  const renderSequence = (c: ConnectionConfig, s: string, q: SequenceMeta, depth: number) => {
    const k = `seq:${c.id}:${s}.${q.name}`
    const name = qualified(s, q.name)
    return (
      <Row
        key={k}
        depth={depth}
        twisty=""
        selected={selected === k}
        onClick={() => setSelected(k)}
        onDoubleClick={() => props.onInsertText(`SELECT last_value, is_called FROM ${name};`)}
        onContextMenu={(e) =>
          openMenu(e, k, [
            { label: 'Insert Current Value Query', run: () => props.onInsertText(`SELECT last_value, is_called FROM ${name};`) },
            { label: 'Copy Qualified Name', run: () => void navigator.clipboard.writeText(name) }
          ])
        }
        title={q.ownedBy ? `owned by ${q.ownedBy}` : undefined}
      >
        <span className="tree-icon" style={{ color: 'var(--kind-sequence)' }}>#</span>
        <span className="q-label">{q.name}</span>
        <span className="meta">{q.dataType}</span>
      </Row>
    )
  }

  const renderType = (c: ConnectionConfig, s: string, t: TypeMeta, depth: number) => {
    const k = `type:${c.id}:${s}.${t.name}`
    return (
      <Row
        key={k}
        depth={depth}
        twisty=""
        selected={selected === k}
        onClick={() => setSelected(k)}
        onContextMenu={(e) =>
          openMenu(e, k, [{ label: 'Copy Qualified Name', run: () => void navigator.clipboard.writeText(qualified(s, t.name)) }])
        }
        title={t.detail ? `${t.kind}: ${t.detail}` : t.kind}
      >
        <span className="tree-icon" style={{ color: 'var(--kind-type)' }}>T</span>
        <span className="q-label">{t.name}</span>
        <span className="meta">{t.kind}</span>
      </Row>
    )
  }

  const renderSchema = (c: ConnectionConfig, s: SchemaMeta) => {
    const sk = `schema:${c.id}:${s.name}`
    const sopen = isOpen(sk)
    const groups: [FolderKind, React.ReactNode[]][] = [
      ['tables', s.tables.filter((t) => t.kind === 'table' || t.kind === 'partitioned').map((t) => renderTable(c, t, 3))],
      ['views', s.tables.filter((t) => t.kind === 'view').map((t) => renderTable(c, t, 3))],
      ['matviews', s.tables.filter((t) => t.kind === 'matview').map((t) => renderTable(c, t, 3))],
      ['foreign', s.tables.filter((t) => t.kind === 'foreign').map((t) => renderTable(c, t, 3))],
      ['routines', (s.routines ?? []).map((r) => renderRoutine(c, s.name, r, 3))],
      ['sequences', (s.sequences ?? []).map((q) => renderSequence(c, s.name, q, 3))],
      ['types', (s.types ?? []).map((t) => renderType(c, s.name, t, 3))]
    ]
    return (
      <div key={sk}>
        <Row
          depth={1}
          twisty={sopen ? '▼' : '▶'}
          selected={selected === sk}
          onClick={() => {
            setSelected(sk)
            toggle(sk)
          }}
          onContextMenu={(e) =>
            openMenu(e, sk, [
              { label: 'Copy Name', run: () => void navigator.clipboard.writeText(s.name) },
              { label: 'Refresh Catalog', run: props.onRefresh }
            ])
          }
        >
          <span className="tree-icon" style={{ color: 'var(--kind-schema)' }}>◈</span>
          <span className="q-label">{s.name}</span>
          <span className="meta">{s.tables.length || ''}</span>
        </Row>
        {sopen &&
          groups
            .filter(([, nodes]) => nodes.length > 0)
            .map(([kind, nodes]) => {
              const fk = `folder:${c.id}:${s.name}:${kind}`
              const fopen = isOpen(fk)
              return (
                <div key={fk}>
                  <Row
                    depth={2}
                    twisty={fopen ? '▼' : '▶'}
                    selected={selected === fk}
                    onClick={() => {
                      setSelected(fk)
                      toggle(fk)
                    }}
                  >
                    <span className="tree-icon tree-folder">▤</span>
                    <span className="q-label">{FOLDER_LABEL[kind]}</span>
                    <span className="meta">{nodes.length}</span>
                  </Row>
                  {fopen && nodes}
                </div>
              )
            })}
      </div>
    )
  }

  return (
    <>
      <div className="sidebar-header">
        <input
          placeholder="Filter tables, routines…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setFilter('')}
          spellCheck={false}
        />
        <button className="ghost tree-tool" onClick={props.onRefresh} title="Refresh catalog (⌘R)">
          ↻
        </button>
        <button
          className="ghost tree-tool"
          onClick={() => setExpanded((prev) => new Set([...prev].filter((k) => k.startsWith('conn:'))))}
          title="Collapse all"
        >
          ⊟
        </button>
      </div>
      <div className="q-tree">
        {connections.length === 0 && (
          <div className="q-empty" style={{ height: 'auto', padding: '24px 12px' }}>
            No connections yet.
            <br />
            Press ⌘⇧N to add one.
          </div>
        )}

        {connections.map((c) => {
          const isActive = c.id === activeConnectionId
          const isConnected = connectedIds.has(c.id)
          // An offline connection can still be browsed from its cached catalog.
          const hasCatalog = isActive && catalog?.connectionId === c.id
          const key = `conn:${c.id}`
          const open = expanded.has(key) && (isConnected || hasCatalog)
          return (
            <div key={c.id}>
              <Row
                depth={0}
                twisty={isConnected || hasCatalog ? (open ? '▼' : '▶') : ''}
                selected={isActive}
                onClick={() => {
                  props.onSelectConnection(c.id)
                  setSelected(key)
                  // Expand on the first click even while still offline: selecting
                  // connects, and the node should be open when the catalog lands.
                  if (isConnected || hasCatalog) toggle(key)
                  else setExpanded((prev) => new Set(prev).add(key))
                }}
                onDoubleClick={() => props.onToggleConnection(c.id)}
                onContextMenu={(e) =>
                  openMenu(e, key, [
                    { label: isConnected ? 'Disconnect' : 'Connect', run: () => props.onToggleConnection(c.id) },
                    { label: 'Refresh Catalog', run: () => { props.onSelectConnection(c.id); props.onRefresh() } },
                    { label: 'Edit Connection…', run: () => props.onEditConnection(c) }
                  ])
                }
              >
                <span
                  className="q-dot"
                  style={{
                    background: isConnected ? 'var(--success)' : 'var(--text-muted)',
                    boxShadow: c.color ? `0 0 0 2px ${c.color}` : undefined
                  }}
                />
                <span className="q-label">{c.name}</span>
                <span className="meta" title={hasCatalog && catalog?.offline ? 'Showing the catalog from the last time this connected' : undefined}>
                  {isConnected ? `${totalTables || ''}` : hasCatalog ? 'cached' : 'offline'}
                </span>
                <button
                  className="ghost"
                  style={{ padding: '0 4px', fontSize: 11 }}
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onEditConnection(c)
                  }}
                  title="Edit connection"
                >
                  ⋯
                </button>
              </Row>

              {open && hasCatalog && filtered?.map((s) => renderSchema(c, s))}
            </div>
          )
        })}

        {menu && (
          <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
            {menu.items.map((it) => (
              <div
                key={it.label}
                onClick={() => {
                  it.run()
                  setMenu(null)
                }}
              >
                {it.label}
              </div>
            ))}
          </div>
        )}

        {needle && filtered && shownObjects === 0 && (
          <div className="q-empty" style={{ height: 'auto', padding: 20 }}>
            Nothing matches “{needle}”.
          </div>
        )}
      </div>
    </>
  )
}

interface TableChildrenProps {
  conn: ConnectionConfig
  table: TableMeta
  depth: number
  expanded: Set<NodeKey>
  toggle: (key: NodeKey) => void
  selected: NodeKey | null
  setSelected: (key: NodeKey) => void
  openMenu: (e: React.MouseEvent, key: NodeKey, items: MenuItem[]) => void
  onOpenSource: (target: SourceTarget, title: string) => void
}

/** DataGrip's table sub-folders: columns, keys, foreign keys, indexes, triggers. */
function TableChildren({ conn, table, depth, expanded, toggle, selected, setSelected, openMenu, onOpenSource }: TableChildrenProps) {
  const base = `${conn.id}:${table.schema}.${table.name}`
  const fkCols = new Set(table.foreignKeys.flatMap((f) => f.columns))
  const indexed = new Set(table.indexes.flatMap((i) => i.columns))
  const keys = table.indexes.filter((i) => i.primary || i.unique)
  const indexes = table.indexes.filter((i) => !i.primary)
  const triggers = table.triggers ?? []

  const folder = (kind: string, label: string, count: number, body: () => React.ReactNode) => {
    if (!count) return null
    const k = `tfolder:${base}:${kind}`
    // Columns are what people expand a table for; show them without a second click.
    const open = kind === 'columns' ? !expanded.has(k) : expanded.has(k)
    return (
      <div key={k}>
        <Row depth={depth} twisty={open ? '▼' : '▶'} selected={selected === k} onClick={() => { setSelected(k); toggle(k) }}>
          <span className="tree-icon tree-folder">▤</span>
          <span className="q-label">{label}</span>
          <span className="meta">{count}</span>
        </Row>
        {open && body()}
      </div>
    )
  }

  return (
    <>
      {folder('columns', 'columns', table.columns.length, () =>
        table.columns.map((col) => (
          <Row key={col.name} depth={depth + 1} twisty="" selected={false} title={col.comment ?? undefined}>
            <span className="tree-icon" style={{ color: 'var(--kind-column)', opacity: indexed.has(col.name) ? 1 : 0.5, fontSize: 10 }}>
              ●
            </span>
            <span className="q-label">{col.name}</span>
            {col.isPrimaryKey && <span className="badge badge-pk">PK</span>}
            {fkCols.has(col.name) && <span className="badge badge-fk">FK</span>}
            <span className="meta">
              {col.dataType}
              {col.nullable ? '' : ' ·'}
            </span>
          </Row>
        ))
      )}
      {folder('keys', 'keys', keys.length, () =>
        keys.map((i) => (
          <Row key={i.name} depth={depth + 1} twisty="" selected={false}>
            <span className="tree-icon" style={{ color: 'var(--kind-key)' }}>⚿</span>
            <span className="q-label">
              {i.name}
              <span className="tree-dim">({i.columns.join(', ')})</span>
            </span>
            <span className="meta">{i.primary ? 'primary' : 'unique'}</span>
          </Row>
        ))
      )}
      {folder('fks', 'foreign keys', table.foreignKeys.length, () =>
        table.foreignKeys.map((f) => (
          <Row key={f.name} depth={depth + 1} twisty="" selected={false} title={`${f.columns.join(', ')} → ${f.refSchema}.${f.refTable}(${f.refColumns.join(', ')})`}>
            <span className="tree-icon" style={{ color: 'var(--kind-key)' }}>↗</span>
            <span className="q-label">
              {f.name}
              <span className="tree-dim">({f.columns.join(', ')})</span>
            </span>
            <span className="meta">{f.refTable}</span>
          </Row>
        ))
      )}
      {folder('indexes', 'indexes', indexes.length, () =>
        indexes.map((i) => (
          <Row key={i.name} depth={depth + 1} twisty="" selected={false}>
            <span className="tree-icon" style={{ color: 'var(--kind-column)' }}>⌗</span>
            <span className="q-label">
              {i.name}
              <span className="tree-dim">({i.columns.join(', ') || 'expression'})</span>
            </span>
            {i.unique && <span className="meta">unique</span>}
          </Row>
        ))
      )}
      {folder('triggers', 'triggers', triggers.length, () =>
        triggers.map((tg) => {
          const k = `trigger:${base}:${tg.name}`
          const open = (): void => onOpenSource({ kind: 'trigger', schema: table.schema, table: table.name, name: tg.name }, tg.name)
          return (
            <Row
              key={tg.name}
              depth={depth + 1}
              twisty=""
              selected={selected === k}
              onClick={() => setSelected(k)}
              onDoubleClick={open}
              onContextMenu={(e) => openMenu(e, k, [{ label: 'Open Source', run: open }])}
              title={tg.timing + (tg.enabled ? '' : ' (disabled)')}
            >
              <span className="tree-icon" style={{ color: 'var(--kind-routine)', opacity: tg.enabled ? 1 : 0.4 }}>⚡</span>
              <span className="q-label" style={tg.enabled ? undefined : { textDecoration: 'line-through' }}>{tg.name}</span>
              <span className="meta">{tg.timing.replace(' (statement)', '')}</span>
            </Row>
          )
        })
      )}
    </>
  )
}

interface RowProps {
  depth: number
  twisty: string
  selected: boolean
  title?: string
  children: React.ReactNode
  onClick?: () => void
  onDoubleClick?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
}

function Row({ depth, twisty, selected, children, title, onClick, onDoubleClick, onContextMenu }: RowProps) {
  return (
    <div
      className={`tree-row${selected ? ' selected' : ''}`}
      style={{ paddingLeft: 6 + depth * 14 }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      title={title}
    >
      <span className="twisty">{twisty}</span>
      {children}
    </div>
  )
}

const objectCount = (s: SchemaMeta): number =>
  s.tables.length + (s.routines?.length ?? 0) + (s.sequences?.length ?? 0) + (s.types?.length ?? 0)

/** "TABLE(id integer, …)" and "SETOF record" are too long for the meta column. */
function shortType(t: string): string {
  return t.length > 22 ? `${t.slice(0, 20)}…` : t
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
