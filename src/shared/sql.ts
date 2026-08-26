/**
 * SQL text utilities shared by both processes.
 *
 * Splitting on ";" naively breaks the moment a function body shows up, because
 * PL/pgSQL bodies are dollar-quoted and full of semicolons. This scanner tracks
 * string, dollar-quote and comment state so `CREATE FUNCTION ... $$ ... ; ... $$`
 * stays a single statement.
 */

export interface Statement {
  text: string
  start: number
  end: number
}

export function splitStatements(sql: string): Statement[] {
  const out: Statement[] = []
  let i = 0
  let stmtStart = 0
  const n = sql.length

  const push = (end: number): void => {
    const raw = sql.slice(stmtStart, end)
    if (raw.trim()) out.push({ text: raw.trim(), start: stmtStart + leading(raw), end })
  }

  while (i < n) {
    const c = sql[i]

    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? n : nl + 1
      continue
    }
    if (c === '/' && sql[i + 1] === '*') {
      // Postgres block comments nest.
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2 }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2 }
        else i++
      }
      continue
    }
    if (c === "'" || c === '"') {
      i = skipQuoted(sql, i, c, c === "'" && isEscapeString(sql, i))
      continue
    }
    if (c === '$') {
      const tag = dollarTagAt(sql, i)
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length)
        i = close === -1 ? n : close + tag.length
        continue
      }
    }
    if (c === ';') {
      push(i)
      i++
      stmtStart = i
      continue
    }
    i++
  }
  push(n)
  return out
}

/** The statement containing `offset` — what Cmd+Enter executes. */
export function statementAt(sql: string, offset: number): Statement | null {
  const stmts = splitStatements(sql)
  if (!stmts.length) return null
  for (const s of stmts) {
    if (offset >= s.start && offset <= s.end) return s
  }
  // The caret is in the whitespace between statements. Return the statement it
  // sits *after*, never simply the last one in the buffer — a caret on a blank
  // line near the top would otherwise execute whatever is at the bottom.
  let previous: Statement | null = null
  for (const s of stmts) {
    if (s.start <= offset) previous = s
    else break
  }
  return previous ?? stmts[0]
}

function leading(s: string): number {
  const m = /^\s*/.exec(s)
  return m ? m[0].length : 0
}

/**
 * Skips a quoted run, handling doubled-quote escaping ('' and "").
 *
 * Backslash is an escape only in E'' strings: Postgres ships with
 * standard_conforming_strings=on, so in an ordinary literal a trailing
 * backslash ends the string like any other character. Treating it as an escape
 * swallowed the following statement, which then ran unannounced.
 */
function skipQuoted(sql: string, start: number, quote: string, escapeString = false): number {
  let i = start + 1
  while (i < sql.length) {
    if (escapeString && sql[i] === '\\') { i += 2; continue }
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) { i += 2; continue }
      return i + 1
    }
    i++
  }
  return sql.length
}

/** True when the quote at `i` opens an E'' escape-string literal. */
function isEscapeString(sql: string, i: number): boolean {
  return i > 0 && (sql[i - 1] === 'E' || sql[i - 1] === 'e') && !/[A-Za-z0-9_$]/.test(sql[i - 2] ?? ' ')
}

/** Returns "$$" or "$tag$" if a dollar-quote opens at `i`, else null. */
export function dollarTagAt(sql: string, i: number): string | null {
  if (sql[i] !== '$') return null
  let j = i + 1
  while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j++
  if (sql[j] !== '$') return null
  return sql.slice(i, j + 1)
}

/** Strip comments/strings so clause detection can't be fooled by their contents. */
export function maskLiterals(sql: string): string {
  const out = sql.split('')
  let i = 0
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '
  }
  while (i < sql.length) {
    const c = sql[i]
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      const end = nl === -1 ? sql.length : nl
      blank(i, end)
      i = end
      continue
    }
    if (c === '/' && sql[i + 1] === '*') {
      // Postgres block comments nest, exactly as splitStatements assumes.
      let depth = 1
      let j = i + 2
      while (j < sql.length && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2 }
        else if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2 }
        else j++
      }
      blank(i, j)
      i = j
      continue
    }
    if (c === "'") {
      const end = skipQuoted(sql, i, "'", isEscapeString(sql, i))
      blank(i, end)
      i = end
      continue
    }
    if (c === '"') {
      // Skipped, deliberately not blanked. Skipping stops an apostrophe inside a
      // quoted identifier (a table literally named o'brien) from opening a
      // phantom string that swallows the rest of the statement; blanking would
      // instead hide the identifier from the table scanner.
      i = skipQuoted(sql, i, '"')
      continue
    }
    if (c === '$') {
      const tag = dollarTagAt(sql, i)
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length)
        const to = close === -1 ? sql.length : close + tag.length
        blank(i, to)
        i = to
        continue
      }
    }
    i++
  }
  return out.join('')
}

/** Words that can follow a table name but are never an alias. */
export const NOT_ALIASES = new Set([
  'on', 'using', 'where', 'group', 'order', 'having', 'limit', 'offset', 'join',
  'inner', 'left', 'right', 'full', 'outer', 'cross', 'lateral', 'natural',
  'union', 'intersect', 'except', 'set', 'values', 'returning', 'as', 'and',
  'or', 'select', 'from', 'window', 'fetch', 'for'
])

/** Clause keywords that terminate a comma-separated table list. */
const CLAUSE_END = new Set([
  'where', 'group', 'order', 'having', 'limit', 'offset', 'union', 'intersect',
  'except', 'returning', 'window', 'fetch', 'for', 'on', 'using', 'set', 'values'
])

export interface SqlTableRef {
  schema: string | null
  table: string
  alias: string | null
  /** offset of the reference within the input */
  at: number
}

const IDENT_RE = /^(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)/

const unquoteIdent = (s: string): string =>
  s.startsWith('"') && s.endsWith('"') && s.length > 1 ? s.slice(1, -1).replace(/""/g, '"') : s

/**
 * Every table reference the statement introduces, including the comma form
 * (`FROM a, b`) that a keyword-anchored regex cannot see.
 *
 * That blind spot was not cosmetic: `FROM t a, t b` is a self-join, Postgres
 * reports one relation oid for both aliases, and the result was therefore
 * treated as editable — an UPDATE keyed on one alias's primary key then wrote
 * to a row the user never touched.
 */
export function tableReferences(sql: string): SqlTableRef[] {
  const masked = maskLiterals(sql)
  const refs: SqlTableRef[] = []
  const keyword = /\b(from|join|update|insert\s+into)\b/gi
  let m: RegExpExecArray | null

  while ((m = keyword.exec(masked)) !== null) {
    const commaList = !/^join$/i.test(m[1])
    const isInsert = /^insert/i.test(m[1])
    let i = m.index + m[0].length
    for (;;) {
      const parsed = parseRef(sql, masked, i, isInsert)
      if (!parsed) break
      refs.push(parsed.ref)
      i = parsed.next
      if (!commaList) break
      const after = skipSpace(masked, i)
      if (masked[after] !== ',') break
      i = after + 1
    }
    // Resume scanning after this reference so nested keywords are still seen.
    keyword.lastIndex = Math.max(keyword.lastIndex, i)
  }
  return refs
}

function skipSpace(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) i++
  return i
}

function parseRef(
  raw: string,
  masked: string,
  from: number,
  isInsert = false
): { ref: SqlTableRef; next: number } | null {
  let i = skipSpace(masked, from)
  // A subquery or function call in the FROM list is not a plain table.
  if (masked[i] === '(') return null

  const first = IDENT_RE.exec(raw.slice(i))
  if (!first) return null
  const at = i
  let schema: string | null = null
  let table = unquoteIdent(first[0])
  i += first[0].length

  const afterDot = skipSpace(masked, i)
  if (masked[afterDot] === '.') {
    const second = IDENT_RE.exec(raw.slice(skipSpace(masked, afterDot + 1)))
    if (second) {
      schema = table
      table = unquoteIdent(second[0])
      i = skipSpace(masked, afterDot + 1) + second[0].length
    }
  }

  // A function call such as generate_series(1,2) is not a table reference. The
  // parenthesis must follow immediately — "INSERT INTO t (a, b)" is a column
  // list, not a call.
  if (!isInsert && masked[i] === '(') return null

  let alias: string | null = null
  let j = skipSpace(masked, i)
  if (/^as\b/i.test(masked.slice(j))) j = skipSpace(masked, j + 2)
  const candidate = IDENT_RE.exec(raw.slice(j))
  if (candidate && !NOT_ALIASES.has(candidate[0].toLowerCase()) && !CLAUSE_END.has(candidate[0].toLowerCase())) {
    alias = unquoteIdent(candidate[0])
    i = j + candidate[0].length
  }

  return { ref: { schema, table, alias, at }, next: i }
}

/**
 * How many table references the statement introduces. Used to reject editing a
 * self-join: Postgres reports the same relation oid for every alias of one
 * table, so the oid check alone cannot tell one reference from two.
 */
export function countTableReferences(sql: string): number {
  return tableReferences(sql).length
}
