import { readFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, extra = ''): void => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? '\n       ' + extra : ''}`) }
}

/**
 * Class names Monaco and AG Grid use for their own internals. Our stylesheet is
 * loaded globally and their widgets render inside our tree, so an unscoped rule
 * on any of these silently restyles them.
 *
 * This is not hypothetical: a global `.main { flex-direction: column }` hijacked
 * the Monaco suggest widget's row layout and pushed every completion label out
 * of its 20px row, making autocomplete look completely broken while the engine
 * was returning correct results.
 */
const RESERVED = new Set([
  'main', 'row', 'rows', 'item', 'items', 'group', 'left', 'right', 'top', 'bottom',
  'icon', 'contents', 'content', 'label', 'close', 'empty', 'note', 'field', 'dot',
  'tab', 'tabs', 'overlay', 'modal', 'pill', 'tree', 'list', 'header', 'body',
  'footer', 'cell', 'highlight', 'details', 'active', 'focused', 'selected',
  'hidden', 'disabled', 'container', 'title', 'message', 'actions', 'button',
  'input', 'text', 'value', 'name', 'type', 'expanded', 'collapsed', 'monaco', 'ag'
])

const css = readFileSync('src/renderer/src/theme/billing.css', 'utf8')

// Selectors at the start of a rule, i.e. not nested under one of our own classes.
const leading = [...css.matchAll(/^\s*(\.[A-Za-z][\w-]*)/gm)].map((m) => m[1].slice(1))
const offenders = [...new Set(leading)].filter((c) => RESERVED.has(c))

console.log('billing.css must not restyle bundled-widget internals')
ok('no unscoped rule targets a reserved class name', offenders.length === 0,
   offenders.length ? `offending selectors: ${offenders.map((o) => '.' + o).join(', ')}` : '')
ok('the stylesheet was actually read', leading.length > 20, String(leading.length))
ok('our own namespaced classes survive the check', leading.includes('q-main'), JSON.stringify(leading.slice(0, 5)))

console.log('\ncomponents must not use reserved class names either')
{
  const dir = 'src/renderer/src'
  const files: string[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name))
      else if (e.name.endsWith('.tsx')) files.push(join(d, e.name))
    }
  }
  walk(dir)

  const bad: string[] = []
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
      const raw = (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, ' ')
      for (const token of raw.split(/\s+/).filter(Boolean)) {
        if (RESERVED.has(token)) bad.push(`${f.split('/').pop()}: ${token}`)
      }
    }
  }
  ok('no component applies a reserved class name', bad.length === 0, bad.join(', '))
  ok('scanned the component tree', files.length >= 5, String(files.length))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
