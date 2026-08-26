import { useEffect, useMemo, useState } from 'react'
import type { Catalog, ConnectionConfig, TableMeta } from '@shared/ipc'

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
  onEditConnection: (cfg: ConnectionConfig) => void
}

type NodeKey = string

export function SchemaTree(props: Props) {
  const { connections, activeConnectionId, connectedIds, catalog } = props
  const [expanded, setExpanded] = useState<Set<NodeKey>>(new Set())
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<NodeKey | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; table: TableMeta } | null>(null)

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
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

  const needle = filter.trim().toLowerCase()

  // Filtering matches tables and columns; a schema survives if anything under it does.
  const filtered = useMemo(() => {
    if (!catalog) return null
    if (!needle) return catalog.schemas
    return catalog.schemas
      .map((s) => ({
        ...s,
        tables: s.tables.filter(
          (t) =>
            t.name.toLowerCase().includes(needle) ||
            `${t.schema}.${t.name}`.toLowerCase().includes(needle) ||
            t.columns.some((c) => c.name.toLowerCase().includes(needle))
        )
      }))
      .filter((s) => s.tables.length > 0)
  }, [catalog, needle])

  const totalTables = catalog?.schemas.reduce((n, s) => n + s.tables.length, 0) ?? 0
  const shownTables = filtered?.reduce((n, s) => n + s.tables.length, 0) ?? 0

  return (
    <>
      <div className="sidebar-header">
        <input
          placeholder="Filter tables…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
        />
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
          const key = `conn:${c.id}`
          const open = expanded.has(key) && isConnected
          return (
            <div key={c.id}>
              <Row
                depth={0}
                twisty={isConnected ? (open ? '▼' : '▶') : ''}
                selected={isActive}
                onClick={() => {
                  props.onSelectConnection(c.id)
                  setSelected(key)
                  // Expand on the first click even while still offline: selecting
                  // connects, and the node should be open when the catalog lands.
                  if (isConnected) toggle(key)
                  else setExpanded((prev) => new Set(prev).add(key))
                }}
                onDoubleClick={() => props.onToggleConnection(c.id)}
              >
                <span
                  className="q-dot"
                  style={{
                    background: isConnected ? 'var(--success)' : 'var(--text-muted)',
                    boxShadow: c.color ? `0 0 0 2px ${c.color}` : undefined
                  }}
                />
                <span className="q-label">{c.name}</span>
                <span className="meta">
                  {isConnected ? `${totalTables || ''}` : 'offline'}
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

              {open &&
                isActive &&
                filtered?.map((s) => {
                  const sk = `schema:${c.id}:${s.name}`
                  const sopen = expanded.has(sk) || (!!needle && shownTables < 60)
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
                      >
                        <span style={{ color: 'var(--kind-schema)' }}>◈</span>
                        <span className="q-label">{s.name}</span>
                        <span className="meta">{s.tables.length}</span>
                      </Row>
                      {sopen &&
                        s.tables.map((t) => {
                          const tk = `table:${c.id}:${s.name}.${t.name}`
                          const topen = expanded.has(tk)
                          return (
                            <div key={tk}>
                              <Row
                                depth={2}
                                twisty={topen ? '▼' : '▶'}
                                selected={selected === tk}
                                onClick={() => {
                                  setSelected(tk)
                                  props.onSelectTable(t)
                                  toggle(tk)
                                }}
                                onDoubleClick={() => props.onOpenTable(t)}
                                onContextMenu={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  setSelected(tk)
                                  props.onSelectTable(t)
                                  setMenu({ x: e.clientX, y: e.clientY, table: t })
                                }}
                                title={t.comment ?? undefined}
                              >
                                <span
                                  style={{
                                    color:
                                      t.kind === 'view' || t.kind === 'matview'
                                        ? 'var(--kind-view)'
                                        : 'var(--kind-table)'
                                  }}
                                >
                                  {t.kind === 'view' || t.kind === 'matview' ? '◇' : '▦'}
                                </span>
                                <span className="q-label">{t.name}</span>
                                {t.rowEstimate !== null && (
                                  <span className="meta">{formatCount(t.rowEstimate)}</span>
                                )}
                              </Row>
                              {topen && <Columns table={t} />}
                            </div>
                          )
                        })}
                    </div>
                  )
                })}
            </div>
          )
        })}

        {menu && (
          <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
            <div onClick={() => { props.onOpenTable(menu.table); setMenu(null) }}>Open Data</div>
            <div onClick={() => { props.onShowDdl(menu.table); setMenu(null) }}>Show DDL</div>
            <div
              onClick={() => {
                void navigator.clipboard.writeText(`${menu.table.schema}.${menu.table.name}`)
                setMenu(null)
              }}
            >
              Copy Qualified Name
            </div>
          </div>
        )}

        {needle && filtered && shownTables === 0 && (
          <div className="q-empty" style={{ height: 'auto', padding: 20 }}>
            No tables match “{needle}”.
          </div>
        )}
      </div>
    </>
  )
}

function Columns({ table }: { table: TableMeta }) {
  const fkCols = new Set(table.foreignKeys.flatMap((f) => f.columns))
  const indexed = new Set(table.indexes.flatMap((i) => i.columns))
  return (
    <>
      {table.columns.map((col) => (
        <Row key={col.name} depth={3} twisty="" selected={false} title={col.comment ?? undefined}>
          <span
            style={{
              color: 'var(--kind-column)',
              opacity: indexed.has(col.name) ? 1 : 0.5,
              fontSize: 10
            }}
          >
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
      ))}
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

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
