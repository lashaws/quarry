import { useCallback, useEffect, useMemo, useRef } from 'react'
import { AgGridReact } from 'ag-grid-react'
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type CellValueChangedEvent,
  type ColDef,
  type GridReadyEvent,
  type CellFocusedEvent,
  type GridApi,
  type BodyScrollEndEvent
} from 'ag-grid-community'
import type { Cell, CellEdit, GridEdits, QueryResult } from '@shared/ipc'

ModuleRegistry.registerModules([AllCommunityModule])

const token = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim()

/** AG Grid's theming API, pointed at the same tokens the rest of the app uses. */
function gridTheme() {
  return themeQuartz.withParams({
    backgroundColor: token('--bg-app'),
    foregroundColor: token('--text'),
    headerBackgroundColor: token('--bg-panel'),
    headerTextColor: token('--text-dim'),
    borderColor: token('--border'),
    oddRowBackgroundColor: token('--bg-app'),
    rowHoverColor: token('--bg-hover'),
    selectedRowBackgroundColor: token('--bg-selected'),
    accentColor: token('--accent'),
    fontFamily: token('--font-mono') || 'monospace',
    fontSize: '12px',
    headerFontSize: '12px',
    rowHeight: 24,
    headerHeight: 28,
    cellHorizontalPadding: 10,
    wrapperBorder: false,
    headerRowBorder: { color: token('--border') }
  })
}

interface Props {
  result: QueryResult
  edits: GridEdits
  filterText: string
  /** rows become columns: one grid row per result column, read-only */
  transposed: boolean
  onEdit: (edit: CellEdit) => void
  onInsertEdit: (rowId: string, columnIndex: number, value: Cell) => void
  onFocusRow: (rowIndex: number | null, columnIndex: number | null) => void
  onApiReady: (api: GridApi | null) => void
  onNeedMore: () => void
  /** a cell was copied to the clipboard; the label feeds the status bar */
  onCopied: (label: string) => void
}

/** `__i` >= 0 indexes result rows; negative values address staged inserts. */
interface RowData {
  __i: number
  __newId?: string
  [key: string]: unknown
}

const insertIndex = (i: number): number => -(i + 1)

export function ResultGrid({
  result, edits, filterText, transposed, onEdit, onInsertEdit, onFocusRow, onApiReady, onNeedMore, onCopied
}: Props) {
  const loading = useRef(false)
  const api = useRef<GridApi | null>(null)

  const editedKeys = useMemo(
    () => new Set(edits.updates.map((e) => `${e.rowIndex}:${e.columnIndex}`)),
    [edits.updates]
  )
  const deleted = useMemo(() => new Set(edits.deletes), [edits.deletes])

  const rowData = useMemo<RowData[]>(() => {
    // Staged updates are layered over the fetched values so the grid shows what
    // will be written — including edits applied from outside the grid, like
    // Set NULL, which never pass through a cell editor.
    const pendingCells = new Map<string, Cell>(
      edits.updates.map((e) => [`${e.rowIndex}:${e.columnIndex}`, e.newValue])
    )
    if (transposed) {
      // One grid row per result column; result rows fan out as r0..rN. Staged
      // inserts are grid-born and stay out of the read-only transposed view.
      return result.fields.map((f, c) => {
        const o: RowData = { __i: c, col: f.name }
        result.rows.forEach((row, i) => {
          const pending = pendingCells.get(`${i}:${c}`)
          o[`r${i}`] = pending !== undefined ? pending : row[c]
        })
        return o
      })
    }
    const existing = result.rows.map((row, i) => {
      const o: RowData = { __i: i }
      row.forEach((cell, c) => {
        const pending = pendingCells.get(`${i}:${c}`)
        o[`c${c}`] = pending !== undefined ? pending : cell
      })
      return o
    })
    const staged = edits.inserts.map((ins, i) => {
      const o: RowData = { __i: insertIndex(i), __newId: ins.id }
      result.fields.forEach((_f, c) => {
        o[`c${c}`] = ins.values[c] ?? null
      })
      return o
    })
    return [...existing, ...staged]
  }, [result.rows, result.fields, edits.inserts, edits.updates, transposed])

  const editableColumns = useMemo(() => {
    if (!result.editable) return new Set<number>()
    // Primary keys stay read-only on existing rows: changing one would move the row.
    const pk = new Set(result.editable.pkColumns)
    return new Set(
      Object.entries(result.editable.columnMap)
        .filter(([, name]) => !pk.has(name))
        .map(([idx]) => Number(idx))
    )
  }, [result.editable])

  /** New rows may set any mapped column, primary keys included. */
  const insertableColumns = useMemo(() => {
    if (!result.editable) return new Set<number>()
    return new Set(Object.keys(result.editable.columnMap).map(Number))
  }, [result.editable])

  const columnDefs = useMemo<ColDef<RowData>[]>(() => {
    if (transposed) {
      const header: ColDef<RowData> = {
        field: 'col',
        headerName: 'Column',
        pinned: 'left',
        sortable: false,
        resizable: true,
        minWidth: 90,
        cellClass: 'row-number'
      }
      const perRow: ColDef<RowData>[] = result.rows.map((_row, i) => ({
        field: `r${i}`,
        headerName: String(i + 1),
        sortable: false,
        resizable: true,
        minWidth: 60,
        valueFormatter: (p) => (p.value === null || p.value === undefined ? 'NULL' : String(p.value)),
        cellClassRules: {
          'cell-null': (p) => p.value === null || p.value === undefined
        }
      }))
      return [header, ...perRow]
    }
    const cols: ColDef<RowData>[] = result.fields.map((f, i) => ({
      field: `c${i}`,
      headerName: f.name,
      headerTooltip: `${f.name} · ${f.dataType}`,
      editable: (p) =>
        (p.data?.__i ?? 0) < 0 ? insertableColumns.has(i) : editableColumns.has(i),
      sortable: true,
      resizable: true,
      minWidth: 60,
      type: f.affinity === 'numeric' ? 'rightAligned' : undefined,
      valueFormatter: (p) => (p.value === null || p.value === undefined ? 'NULL' : String(p.value)),
      cellClassRules: {
        'cell-null': (p) => p.value === null || p.value === undefined,
        'cell-edited': (p) => editedKeys.has(`${(p.data as RowData)?.__i}:${i}`),
        'cell-inserted': (p) => ((p.data as RowData)?.__i ?? 0) < 0,
        'cell-deleted': (p) => deleted.has((p.data as RowData)?.__i ?? -1)
      },
      // Keeps numeric columns in numeric order despite string cells.
      comparator:
        f.affinity === 'numeric'
          ? (a, b) => {
              const na = a === null ? NaN : Number(a)
              const nb = b === null ? NaN : Number(b)
              if (Number.isNaN(na) && Number.isNaN(nb)) return 0
              if (Number.isNaN(na)) return -1
              if (Number.isNaN(nb)) return 1
              return na - nb
            }
          : undefined
    }))
    cols.unshift({
      headerName: '#',
      valueGetter: (p) => {
        const i = p.data?.__i ?? 0
        return i < 0 ? '+' : i + 1
      },
      width: 62,
      pinned: 'left',
      sortable: false,
      resizable: false,
      cellClass: 'row-number',
      type: 'rightAligned'
    })
    return cols
  }, [result.fields, result.rows, editableColumns, insertableColumns, editedKeys, deleted, transposed])

  const onCellValueChanged = useCallback(
    (e: CellValueChangedEvent<RowData>) => {
      const field = e.colDef.field
      if (!field?.startsWith('c')) return
      const columnIndex = Number(field.slice(1))
      const newValue = e.newValue === '' || e.newValue === undefined ? null : String(e.newValue)

      if (e.data.__i < 0 && e.data.__newId) {
        onInsertEdit(e.data.__newId, columnIndex, newValue)
        return
      }
      const oldValue = e.oldValue === undefined ? null : (e.oldValue as Cell)
      if (newValue === oldValue) return
      onEdit({ rowIndex: e.data.__i, columnIndex, oldValue, newValue })
    },
    [onEdit, onInsertEdit]
  )

  const onCellFocused = useCallback(
    (e: CellFocusedEvent) => {
      const row = e.api.getDisplayedRowAtIndex(e.rowIndex ?? -1)
      const data = row?.data as RowData | undefined
      const field = typeof e.column === 'object' && e.column ? e.column.getColId() : null
      if (transposed) {
        // Grid rows are result columns here, so the axes swap back on the way out.
        onFocusRow(
          field?.startsWith('r') ? Number(field.slice(1)) : null,
          data ? data.__i : null
        )
        return
      }
      onFocusRow(
        data ? data.__i : null,
        field?.startsWith('c') ? Number(field.slice(1)) : null
      )
    },
    [onFocusRow, transposed]
  )

  // Fetch the next chunk when the viewport nears the end of what we have.
  const onBodyScrollEnd = useCallback(
    (e: BodyScrollEndEvent) => {
      // Transposed, more rows arrive as columns; vertical scroll means nothing.
      if (transposed || result.complete || loading.current) return
      if (e.api.getLastDisplayedRowIndex() >= rowData.length - 20) {
        loading.current = true
        Promise.resolve(onNeedMore()).finally(() => {
          loading.current = false
        })
      }
    },
    [transposed, result.complete, rowData.length, onNeedMore]
  )

  const onGridReady = useCallback(
    (e: GridReadyEvent) => {
      e.api.autoSizeAllColumns(false)
      api.current = e.api
      onApiReady(e.api)
      if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__grid = e.api
    },
    [onApiReady]
  )

  // Column widths sized for one orientation are wrong for the other. Deferred
  // a frame so AG Grid has applied the new column defs before sizing them.
  useEffect(() => {
    const frame = requestAnimationFrame(() => api.current?.autoSizeAllColumns(false))
    return () => cancelAnimationFrame(frame)
  }, [transposed])

  // Cmd/Ctrl+C on a focused cell copies just that cell. A drag-selection of
  // text keeps the browser's own copy, and an open cell editor is left alone.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'c' || e.shiftKey || e.altKey) return
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return
      if (window.getSelection()?.toString()) return
      const grid = api.current
      const cell = grid?.getFocusedCell()
      if (!grid || !cell) return
      const row = grid.getDisplayedRowAtIndex(cell.rowIndex)
      const data = row?.data as RowData | undefined
      const colId = cell.column.getColId()
      // The row-number column carries no field; there is nothing to copy there.
      if (!data || !(colId in data)) return
      e.preventDefault()
      const value = data[colId]
      void navigator.clipboard.writeText(value === null || value === undefined ? '' : String(value))
      onCopied('1 cell')
    },
    [onCopied]
  )

  return (
    <div style={{ position: 'absolute', inset: 0 }} onKeyDown={onKeyDown}>
      <AgGridReact<RowData>
        theme={gridTheme()}
        rowData={rowData}
        columnDefs={columnDefs}
        quickFilterText={filterText}
        getRowId={(p) => String(p.data.__i)}
        onCellValueChanged={onCellValueChanged}
        onCellFocused={onCellFocused}
        onBodyScrollEnd={onBodyScrollEnd}
        onGridReady={onGridReady}
        animateRows={false}
        rowSelection={{ mode: 'multiRow', checkboxes: false, headerCheckbox: false, enableClickSelection: true }}
        enableCellTextSelection
        stopEditingWhenCellsLoseFocus
        tooltipShowDelay={400}
      />
    </div>
  )
}
