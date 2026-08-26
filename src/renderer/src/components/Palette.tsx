import { useEffect, useMemo, useRef, useState } from 'react'

export interface PaletteItem {
  id: string
  label: string
  /** secondary text, right-aligned */
  sub?: string
  /** monospace detail line, e.g. the SQL of a history entry */
  mono?: string
}

interface Props {
  placeholder: string
  items: PaletteItem[]
  onPick: (item: PaletteItem) => void
  onClose: () => void
  /** when set, the parent re-queries instead of filtering locally */
  onQueryChange?: (q: string) => void
}

/** Shared ⌘O / ⌘⌃E surface: type to filter, arrows to move, Enter to pick. */
export function Palette({ placeholder, items, onPick, onClose, onQueryChange }: Props) {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    onQueryChange?.(q)
  }, [q, onQueryChange])

  const shown = useMemo(() => {
    if (onQueryChange) return items.slice(0, 300)
    const needle = q.trim().toLowerCase()
    if (!needle) return items.slice(0, 300)
    return items
      .filter((i) => i.label.toLowerCase().includes(needle) || i.sub?.toLowerCase().includes(needle))
      .slice(0, 300)
  }, [items, q, onQueryChange])

  useEffect(() => setActive(0), [shown.length])

  useEffect(() => {
    listRef.current
      ?.querySelector('.palette-item.active')
      ?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    <div className="q-overlay" onMouseDown={onClose}>
      <div className="q-modal wide palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          spellCheck={false}
          placeholder={placeholder}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(a + 1, shown.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(a - 1, 0))
            } else if (e.key === 'Enter' && shown[active]) {
              onPick(shown[active])
            }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {shown.map((item, i) => (
            <div
              key={item.id}
              className={`palette-item${i === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => onPick(item)}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div>{item.label}</div>
                {item.mono && <div className="mono">{item.mono}</div>}
              </div>
              {item.sub && <span className="sub">{item.sub}</span>}
            </div>
          ))}
          {shown.length === 0 && <div className="q-empty" style={{ padding: 24 }}>Nothing found.</div>}
        </div>
      </div>
    </div>
  )
}
