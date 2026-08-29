import { useEffect, useRef } from 'react'
import { statementAt } from '@shared/sql'
import { describeAt } from '../sql/describe'
import { expandStar } from '../sql/expand'
import type { Catalog } from '@shared/ipc'
import { defineTheme, LANGUAGE, monaco, registerCompletion, THEME } from '../editor/monaco'

/** What App needs from the live editor, without reaching through `window`. */
export interface EditorApi {
  /** the selection when there is one, else the statement under the caret */
  currentStatement(): string
}

interface Props {
  /** one Monaco model per tab, so undo history survives tab switches */
  tabId: string
  value: string
  catalog: Catalog | null
  onChange: (value: string) => void
  onExecute: (sql: string) => void
  /** run every statement in the buffer */
  onRunScript: () => void
  /** explain the statement under the caret */
  onExplain: (analyze: boolean) => void
  onFormat: () => void
  /** ⌘B on a table name */
  onGoToDefinition: (schema: string, table: string) => void
  /** receives the editor handle; null on unmount */
  onReady: (api: EditorApi | null) => void
  /** 1-based character offset of a server-reported syntax error */
  errorPosition?: number
  errorMessage?: string
}

/** Models outlive the component so switching tabs keeps each buffer's history. */
const models = new Map<string, monaco.editor.ITextModel>()

function modelFor(tabId: string, value: string): monaco.editor.ITextModel {
  const existing = models.get(tabId)
  if (existing && !existing.isDisposed()) return existing
  const model = monaco.editor.createModel(value, LANGUAGE)
  models.set(tabId, model)
  return model
}

export function disposeModel(tabId: string): void {
  models.get(tabId)?.dispose()
  models.delete(tabId)
}

/**
 * True while a completion snippet's placeholder is active. Accepting a table
 * completion leaves its generated alias selected (`${1:alias}`), and treating
 * that selection as "run the selection" sent the bare alias to Postgres —
 * `syntax error at or near "u"`.
 */
function inSnippet(ed: monaco.editor.IStandaloneCodeEditor): boolean {
  const c = ed.getContribution('snippetController2') as { isInSnippet?: () => boolean } | null
  try {
    return !!c?.isInSnippet?.()
  } catch {
    return false
  }
}

/** The user's own selection, ignoring snippet placeholders. */
function userSelection(ed: monaco.editor.IStandaloneCodeEditor): string {
  const model = ed.getModel()
  const selection = ed.getSelection()
  if (!model || !selection || selection.isEmpty() || inSnippet(ed)) return ''
  return model.getValueInRange(selection)
}

export function SqlEditor({
  tabId, value, catalog, onChange, onExecute, onRunScript, onExplain, onFormat,
  onGoToDefinition, onReady, errorPosition, errorMessage
}: Props) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  // Keep callbacks in refs so Monaco commands never capture stale closures.
  const handlers = useRef({ onExecute, onRunScript, onExplain, onFormat, onChange, onGoToDefinition, catalog })
  handlers.current = { onExecute, onRunScript, onExplain, onFormat, onChange, onGoToDefinition, catalog }
  const ready = useRef(onReady)
  ready.current = onReady

  useEffect(() => {
    if (!host.current) return
    defineTheme()
    registerCompletion()

    const ed = monaco.editor.create(host.current, {
      model: modelFor(tabId, value),
      theme: THEME,
      fontFamily: 'JetBrains Mono, SF Mono, ui-monospace, Menlo, monospace',
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      automaticLayout: true,
      padding: { top: 10, bottom: 10 },
      suggestOnTriggerCharacters: true,
      quickSuggestions: { other: true, comments: false, strings: false },
      wordBasedSuggestions: 'off',
      tabSize: 2,
      smoothScrolling: true,
      cursorBlinking: 'smooth'
    })
    editor.current = ed

    // Exposed through a prop, not `window`: a dev-only global would leave the
    // packaged build silently running the whole buffer instead of one statement.
    ready.current({
      currentStatement(): string {
        const model = ed.getModel()
        const pos = ed.getPosition()
        if (!model) return ''
        const selected = userSelection(ed)
        if (selected.trim()) return selected
        if (!pos) return model.getValue()
        return statementAt(model.getValue(), model.getOffsetAt(pos))?.text ?? model.getValue()
      }
    })

    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__editor = ed

    ed.onDidChangeModelContent(() => handlers.current.onChange(ed.getValue()))

    // Cmd+Enter is a two-step run: the first press selects the statement under
    // the caret so what will execute is visible; plain Enter (or Cmd+Enter
    // again) then runs exactly the highlighted text. Any other keystroke,
    // click, or edit cancels the armed run and Enter goes back to newline.
    let armed: string | null = null
    let arming = false
    const disarm = (): void => {
      armed = null
    }

    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      const model = ed.getModel()
      const pos = ed.getPosition()
      if (!model || !pos) return
      // A selection the user made (or the previous Cmd+Enter armed) runs as-is.
      const selected = userSelection(ed).trim()
      if (selected) {
        disarm()
        handlers.current.onExecute(selected)
        return
      }
      const stmt = statementAt(model.getValue(), model.getOffsetAt(pos))
      if (!stmt?.text || stmt.start >= stmt.end) return
      const from = model.getPositionAt(stmt.start)
      const to = model.getPositionAt(stmt.end)
      arming = true
      ed.setSelection(new monaco.Selection(from.lineNumber, from.column, to.lineNumber, to.column))
      arming = false
      armed = stmt.text
    })

    ed.onKeyDown((e) => {
      if (!armed) return
      if (
        e.keyCode === monaco.KeyCode.Enter &&
        !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
      ) {
        e.preventDefault()
        e.stopPropagation()
        const sql = armed
        disarm()
        // Collapse the selection so the next keystroke types instead of
        // replacing the statement that just ran.
        const sel = ed.getSelection()
        if (sel) ed.setSelection(new monaco.Selection(sel.endLineNumber, sel.endColumn, sel.endLineNumber, sel.endColumn))
        handlers.current.onExecute(sql)
      } else if (e.keyCode === monaco.KeyCode.Escape) {
        disarm()
      }
    })
    // Moving the caret, editing, clicking, or leaving the editor all cancel the
    // pending run; only the arming setSelection above is exempt.
    ed.onDidChangeCursorSelection(() => {
      if (!arming) disarm()
    })
    ed.onDidChangeModelContent(disarm)
    ed.onMouseDown(disarm)
    ed.onDidBlurEditorWidget(disarm)

    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyL, () =>
      handlers.current.onFormat()
    )

    // Bound here as well as in the app menu: a menu accelerator only fires when
    // the native menu is reachable, while an editor command always works.
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () =>
      handlers.current.onRunScript()
    )
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP, () =>
      handlers.current.onExplain(false)
    )
    ed.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyP,
      () => handlers.current.onExplain(true)
    )

    // ⌘B — jump to the table under the caret, opening its data in a new tab.
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => {
      const model = ed.getModel()
      const pos = ed.getPosition()
      if (!model || !pos) return
      const hit = describeAt(model.getValue(), model.getOffsetAt(pos), handlers.current.catalog)
      if (hit?.table) handlers.current.onGoToDefinition(hit.table.schema, hit.table.name)
    })

    // Replace "*" with the real column list, the way DataGrip expands it.
    ed.addAction({
      id: 'quarry.expandStar',
      label: 'Expand * to Column List',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1.5,
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyX],
      run: (editor) => {
        const model = editor.getModel()
        const pos = editor.getPosition()
        if (!model || !pos) return
        const res = expandStar(model.getValue(), model.getOffsetAt(pos), handlers.current.catalog)
        if (!res) return
        const start = model.getPositionAt(res.start)
        const end = model.getPositionAt(res.end)
        editor.executeEdits('quarry.expandStar', [
          {
            range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
            text: res.text
          }
        ])
      }
    })

    return () => {
      // Models are cached per tab and disposed with the tab, not the editor.
      ready.current(null)
      ed.dispose()
      editor.current = null
    }
    // Created once; value is synchronised below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Highlight the exact statement ⌘⏎ will run, so what executes is never a guess.
  useEffect(() => {
    const ed = editor.current
    if (!ed) return
    // A decorations collection owns its own lifecycle; hand-managed id arrays
    // strand stale decorations when the model is replaced underneath them.
    const collection = ed.createDecorationsCollection([])

    const paint = (): void => {
      const model = ed.getModel()
      const pos = ed.getPosition()
      if (!model || !pos) {
        collection.clear()
        return
      }
      const stmt = statementAt(model.getValue(), model.getOffsetAt(pos))
      if (!stmt || stmt.start >= stmt.end) {
        collection.clear()
        return
      }
      const from = model.getPositionAt(stmt.start)
      const to = model.getPositionAt(stmt.end)
      collection.set([
        {
          range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column),
          options: {
            // inlineClassName styles the text itself; className would only paint
            // the decoration layer and leave the statement visually unmarked.
            inlineClassName: 'active-statement',
            linesDecorationsClassName: 'active-statement-gutter'
          }
        }
      ])
    }

    // Painting straight from a model-change event re-enters Monaco's decoration
    // API ("Invoking deltaDecorations recursively"). Defer to the next frame,
    // which also coalesces repaints while typing.
    let frame = 0
    const schedule = (): void => {
      if (frame) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = 0
        paint()
      })
    }

    schedule()
    const a = ed.onDidChangeCursorPosition(schedule)
    const b = ed.onDidChangeModelContent(schedule)
    const c = ed.onDidChangeModel(schedule)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      a.dispose()
      b.dispose()
      c.dispose()
      collection.clear()
    }
  }, [tabId])

  // Swap models on tab change; each keeps its own undo stack and view state.
  useEffect(() => {
    const ed = editor.current
    if (!ed) return
    const model = modelFor(tabId, value)
    if (ed.getModel() !== model) {
      ed.setModel(model)
      ed.focus()
    }
    // Only write back when the buffer genuinely differs, or we'd fight the caret.
    if (model.getValue() !== value) model.setValue(value)
  }, [tabId, value])

  // Surface Postgres' reported error offset as a squiggle on the real line.
  useEffect(() => {
    const ed = editor.current
    const model = ed?.getModel()
    if (!model) return
    if (!errorPosition || !errorMessage) {
      monaco.editor.setModelMarkers(model, 'quarry', [])
      return
    }
    const pos = model.getPositionAt(Math.max(0, errorPosition - 1))
    monaco.editor.setModelMarkers(model, 'quarry', [
      {
        severity: monaco.MarkerSeverity.Error,
        message: errorMessage,
        startLineNumber: pos.lineNumber,
        startColumn: pos.column,
        endLineNumber: pos.lineNumber,
        endColumn: pos.column + 1
      }
    ])
  }, [errorPosition, errorMessage])

  return <div ref={host} style={{ position: 'absolute', inset: 0 }} />
}
