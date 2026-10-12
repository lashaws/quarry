import { triggerTiming } from '../src/main/introspect/postgres.ts'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, extra = ''): void => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? '\n       ' + extra : ''}`) }
}
const is = (label: string, got: string, want: string): void => ok(label, got === want, `got ${got}, want ${want}`)

console.log('trigger timing from tgtype')
// Values are what pg_trigger.tgtype holds for each CREATE TRIGGER form.
is('BEFORE UPDATE FOR EACH ROW', triggerTiming(1 | 2 | 16), 'BEFORE UPDATE')
is('AFTER INSERT OR DELETE FOR EACH ROW', triggerTiming(1 | 4 | 8), 'AFTER INSERT OR DELETE')
is('AFTER INSERT OR UPDATE OR DELETE', triggerTiming(1 | 4 | 8 | 16), 'AFTER INSERT OR UPDATE OR DELETE')
is('INSTEAD OF INSERT on a view', triggerTiming(1 | 64 | 4), 'INSTEAD OF INSERT')
is('statement-level AFTER TRUNCATE', triggerTiming(32), 'AFTER TRUNCATE (statement)')

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
