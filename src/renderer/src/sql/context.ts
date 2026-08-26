import { maskLiterals, statementAt, tableReferences } from '@shared/sql'

export type Clause =
  | 'select' | 'from' | 'where' | 'join' | 'on' | 'group' | 'order'
  | 'having' | 'set' | 'values' | 'returning' | 'insert' | 'update' | 'unknown'

export interface TableRef {
  schema: string | null
  table: string
  alias: string | null
}

export interface CompletionContext {
  clause: Clause
  /** identifier before the dot, e.g. the "u" in "u.na|" — an alias or schema */
  qualifier: string | null
  /** the partial word being typed */
  prefix: string
  /** offset where a suggestion should start replacing */
  replaceStart: number
  /** tables visible at the caret, from FROM/JOIN/UPDATE/INTO */
  tables: TableRef[]
  /** the table just introduced by the JOIN whose ON clause we're in */
  joinTarget: TableRef | null
}

const CLAUSE_PATTERNS: [RegExp, Clause][] = [
  [/\bselect\b/gi, 'select'],
  [/\bfrom\b/gi, 'from'],
  [/\bwhere\b/gi, 'where'],
  [/\bjoin\b/gi, 'join'],
  [/\bon\b/gi, 'on'],
  [/\bgroup\s+by\b/gi, 'group'],
  [/\border\s+by\b/gi, 'order'],
  [/\bhaving\b/gi, 'having'],
  [/\bset\b/gi, 'set'],
  [/\bvalues\b/gi, 'values'],
  [/\breturning\b/gi, 'returning'],
  [/\binsert\s+into\b/gi, 'insert'],
  [/\bupdate\b/gi, 'update']
]


/**
 * Resolves what the caret is looking at, working purely from text.
 *
 * This deliberately does not use a real SQL parser: completion fires while the
 * statement is incomplete and unparseable ("select * from users u where u."),
 * which is exactly when a parse tree is unavailable. A backward scan degrades
 * gracefully instead — it still finds the alias map in broken SQL.
 */
export function resolveContext(sql: string, offset: number): CompletionContext {
  const stmt = statementAt(sql, offset)
  const stmtStart = stmt ? stmt.start : 0
  const stmtText = stmt ? sql.slice(stmt.start, Math.max(stmt.start, stmt.end)) : sql
  const masked = maskLiterals(stmtText)
  const caret = Math.max(0, Math.min(offset - stmtStart, masked.length))

  const { qualifier, prefix, replaceStart } = wordAt(stmtText, masked, caret)
  const region = innermostRegion(masked, caret)
  const scope = masked.slice(region.start, caret)

  const clause = lastClause(scope)
  let tables = extractTableRefs(stmtText, '', region.start, region.end)
  if (!tables.length && region.start !== 0) {
    tables = extractTableRefs(stmtText, '', 0)
  }

  return {
    clause,
    qualifier,
    prefix,
    replaceStart: replaceStart + stmtStart,
    tables,
    joinTarget: clause === 'on' ? lastJoinTarget(stmtText, masked, caret) : null
  }
}

/** Split the token under the caret into an optional qualifier and a prefix. */
function wordAt(
  raw: string,
  masked: string,
  caret: number
): { qualifier: string | null; prefix: string; replaceStart: number } {
  let i = caret
  while (i > 0 && isIdentChar(masked[i - 1])) i--
  const prefix = raw.slice(i, caret)

  let qualifier: string | null = null
  let replaceStart = i
  if (masked[i - 1] === '.') {
    let j = i - 1
    while (j > 0 && (isIdentChar(masked[j - 1]) || masked[j - 1] === '"')) j--
    qualifier = unquote(raw.slice(j, i - 1))
  }
  return { qualifier, prefix, replaceStart }
}

const isIdentChar = (c: string | undefined): boolean => !!c && /[A-Za-z0-9_$"]/.test(c)

function unquote(s: string): string {
  const t = s.trim()
  return t.startsWith('"') && t.endsWith('"') && t.length > 1 ? t.slice(1, -1) : t
}

/** Restrict the scan to the innermost unclosed parenthesis, so subqueries win. */
function innermostRegion(masked: string, caret: number): { start: number; end: number } {
  const stack: number[] = []
  for (let i = 0; i < caret; i++) {
    if (masked[i] === '(') stack.push(i)
    else if (masked[i] === ')') stack.pop()
  }
  if (!stack.length) return { start: 0, end: masked.length }
  const open = stack[stack.length - 1] + 1
  let depth = 1
  let end = masked.length
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '(') depth++
    else if (masked[i] === ')') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  return { start: open, end }
}

function lastClause(scope: string): Clause {
  let best: Clause = 'unknown'
  let bestAt = -1
  for (const [re, clause] of CLAUSE_PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(scope)) !== null) {
      if (m.index > bestAt) { bestAt = m.index; best = clause }
    }
  }
  return best
}

function extractTableRefs(raw: string, _maskedRegion: string, regionOffset: number, end?: number): TableRef[] {
  // Scanning the raw slice keeps quoted identifiers intact; the shared scanner
  // masks literals itself.
  const slice = raw.slice(regionOffset, end)
  return tableReferences(slice).map((r) => ({ schema: r.schema, table: r.table, alias: r.alias }))
}

/** The table introduced by the JOIN immediately before the caret. */
function lastJoinTarget(raw: string, masked: string, caret: number): TableRef | null {
  const before = masked.slice(0, caret)
  const idx = before.toLowerCase().lastIndexOf('join')
  if (idx === -1) return null
  const refs = extractTableRefs(raw, '', idx, caret)
  return refs.length ? refs[refs.length - 1] : null
}

/** The full identifier under `offset`, including a qualifier — used by hover and ⌘B. */
export interface IdentifierAt {
  qualifier: string | null
  name: string
  /** offsets of `name` within the document */
  start: number
  end: number
}

export function identifierAt(sql: string, offset: number): IdentifierAt | null {
  const masked = maskLiterals(sql)
  const isWord = (c: string | undefined): boolean => !!c && /[A-Za-z0-9_$"]/.test(c)
  if (!isWord(masked[offset]) && !isWord(masked[offset - 1])) return null

  let start = offset
  while (start > 0 && isWord(masked[start - 1])) start--
  let end = offset
  while (end < masked.length && isWord(masked[end])) end++
  if (start === end) return null

  let qualifier: string | null = null
  if (masked[start - 1] === '.') {
    let j = start - 1
    while (j > 0 && isWord(masked[j - 1])) j--
    qualifier = unquote(sql.slice(j, start - 1))
  }
  return { qualifier, name: unquote(sql.slice(start, end)), start, end }
}
