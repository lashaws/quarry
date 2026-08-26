import * as monaco from 'monaco-editor/editor/editor.api'
// Must come before any editor is created: editor.api alone has no suggest/hover/find.
import './contributions'
// Monaco 0.56 ships a Postgres-specific definition; better keywords than generic SQL.
import 'monaco-editor/languages/definitions/pgsql/register'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import type { Catalog } from '@shared/ipc'
import { resolveContext } from '../sql/context'
import { suggest, type SuggestKind } from '../sql/complete'
import { describeAt } from '../sql/describe'

// Monaco needs a worker for tokenisation and diffing; Vite compiles it for us.
declare global {
  // eslint-disable-next-line no-var
  var MonacoEnvironment: monaco.Environment | undefined
}
self.MonacoEnvironment = { getWorker: () => new EditorWorker() }

export const THEME = 'quarry-dark'
export const LANGUAGE = 'pgsql'

/** Reads a design token so the editor never diverges from the app palette. */
const color = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim()

/** Monaco's token rules want bare hex, its colour map wants a leading "#". */
const hex = (name: string): string => color(name).replace('#', '')

let themeDefined = false
export function defineTheme(): void {
  if (themeDefined) return
  monaco.editor.defineTheme(THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: hex('--syn-keyword') },
      { token: 'operator.sql', foreground: hex('--syn-keyword') },
      { token: 'string', foreground: hex('--syn-string') },
      { token: 'string.sql', foreground: hex('--syn-string') },
      { token: 'number', foreground: hex('--syn-number') },
      { token: 'comment', foreground: hex('--syn-comment'), fontStyle: 'italic' },
      { token: 'identifier', foreground: hex('--syn-ident') },
      { token: 'predefined', foreground: hex('--syn-function') },
      { token: 'predefined.sql', foreground: hex('--syn-function') }
    ],
    colors: {
      'editor.background': color('--bg-app'),
      'editor.foreground': color('--text'),
      'editorLineNumber.foreground': color('--text-muted'),
      'editorLineNumber.activeForeground': color('--text-dim'),
      'editor.selectionBackground': color('--bg-selected'),
      'editor.lineHighlightBackground': color('--bg-selected-inactive'),
      'editorCursor.foreground': color('--text'),
      'editorWidget.background': color('--bg-elevated'),
      'editorWidget.foreground': color('--text'),
      'editorWidget.border': color('--border-strong'),

      // Monaco emits a CSS variable only for colours the theme actually names,
      // and its rules read them unconditionally. Defining the suggest widget's
      // background without its foreground left `color: var(--…-foreground)`
      // resolving to nothing, so every completion label rendered invisible —
      // the list was there, correctly populated, and simply could not be read.
      'editorSuggestWidget.background': color('--bg-elevated'),
      'editorSuggestWidget.border': color('--border-strong'),
      'editorSuggestWidget.foreground': color('--text'),
      'editorSuggestWidget.selectedBackground': color('--bg-selected'),
      'editorSuggestWidget.selectedForeground': color('--text'),
      'editorSuggestWidget.selectedIconForeground': color('--text'),
      'editorSuggestWidget.highlightForeground': color('--accent'),
      'editorSuggestWidget.focusHighlightForeground': color('--accent'),
      'editorSuggestWidgetStatus.foreground': color('--text-muted'),

      'editorHoverWidget.background': color('--bg-elevated'),
      'editorHoverWidget.foreground': color('--text'),
      'editorHoverWidget.border': color('--border-strong'),
      'editorHoverWidget.statusBarBackground': color('--bg-panel'),

      'list.hoverBackground': color('--bg-hover'),
      'list.hoverForeground': color('--text'),
      'list.focusBackground': color('--bg-selected'),
      'list.focusForeground': color('--text'),
      'list.highlightForeground': color('--accent'),

      'descriptionForeground': color('--text-muted'),
      'foreground': color('--text'),
      'editorGutter.background': color('--bg-app')
    }
  })
  themeDefined = true
}

const KIND_MAP: Record<SuggestKind, monaco.languages.CompletionItemKind> = {
  schema: monaco.languages.CompletionItemKind.Module,
  table: monaco.languages.CompletionItemKind.Class,
  view: monaco.languages.CompletionItemKind.Interface,
  column: monaco.languages.CompletionItemKind.Field,
  alias: monaco.languages.CompletionItemKind.Variable,
  keyword: monaco.languages.CompletionItemKind.Keyword,
  join: monaco.languages.CompletionItemKind.Snippet
}

/** Live catalog, swapped as the active connection changes. */
let currentCatalog: Catalog | null = null
export function setCatalog(catalog: Catalog | null): void {
  currentCatalog = catalog
}

let registered = false
export function registerCompletion(): void {
  if (registered) return
  registered = true

  monaco.languages.registerCompletionItemProvider(LANGUAGE, {
    // "." re-triggers so "u." immediately offers that table's columns.
    triggerCharacters: ['.', ' '],
    provideCompletionItems(model: monaco.editor.ITextModel, position: monaco.Position) {
      const offset = model.getOffsetAt(position)
      const ctx = resolveContext(model.getValue(), offset)
      const items = suggest(ctx, currentCatalog)
      if (!items.length) return { suggestions: [] }

      const start = model.getPositionAt(ctx.replaceStart)
      const range: monaco.IRange = {
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: position.lineNumber,
        endColumn: position.column
      }

      return {
        suggestions: items.map((s) => ({
          label: s.label,
          kind: KIND_MAP[s.kind],
          insertText: s.insert,
          insertTextRules: s.snippet
            ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
            : undefined,
          detail: s.detail,
          documentation: s.documentation,
          range,
          // Pad so lexical ordering matches our numeric rank.
          sortText: String(s.rank).padStart(6, '0'),
          filterText: s.label
        }))
      }
    }
  })

  // Hover: tables show their column list, columns show type/PK/FK/index/comment.
  monaco.languages.registerHoverProvider(LANGUAGE, {
    provideHover(model: monaco.editor.ITextModel, position: monaco.Position) {
      const hit = describeAt(model.getValue(), model.getOffsetAt(position), currentCatalog)
      if (!hit) return null
      const start = model.getPositionAt(hit.start)
      const end = model.getPositionAt(hit.end)
      return {
        range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
        contents: [{ value: hit.markdown, isTrusted: false }]
      }
    }
  })

  monaco.languages.setLanguageConfiguration(LANGUAGE, {
    comments: { lineComment: '--', blockComment: ['/*', '*/'] },
    brackets: [['(', ')']],
    autoClosingPairs: [
      { open: '(', close: ')' },
      { open: "'", close: "'" },
      { open: '"', close: '"' }
    ]
  })
}

export { monaco }
