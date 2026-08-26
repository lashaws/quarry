import { parsePlan, maxSelfMs } from '../src/main/query/plan.ts'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, extra = ''): void => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? '\n       ' + extra : ''}`) }
}
const near = (a: number | undefined, b: number): boolean => Math.abs((a ?? NaN) - b) < 0.01

console.log('basic shape')
{
  const p = parsePlan(JSON.stringify([{
    Plan: {
      'Node Type': 'Hash Join', 'Join Type': 'Inner',
      'Startup Cost': 10, 'Total Cost': 100, 'Plan Rows': 500, 'Plan Width': 32,
      'Actual Rows': 480, 'Actual Loops': 1, 'Actual Total Time': 12.5,
      'Hash Cond': '(a.id = b.a_id)',
      Plans: [
        { 'Node Type': 'Seq Scan', 'Relation Name': 'a', Alias: 'a', 'Parent Relationship': 'Outer',
          'Startup Cost': 0, 'Total Cost': 40, 'Plan Rows': 1000, 'Plan Width': 16,
          'Actual Rows': 1000, 'Actual Loops': 1, 'Actual Total Time': 8.0, Filter: '(x > 1)' },
        { 'Node Type': 'Hash', 'Parent Relationship': 'Inner',
          'Startup Cost': 0, 'Total Cost': 20, 'Plan Rows': 200, 'Plan Width': 16,
          'Actual Rows': 200, 'Actual Loops': 1, 'Actual Total Time': 2.0,
          Plans: [{ 'Node Type': 'Index Scan', 'Relation Name': 'b', 'Index Name': 'b_pkey',
            'Parent Relationship': 'Outer',
            'Startup Cost': 0, 'Total Cost': 15, 'Plan Rows': 200, 'Plan Width': 16,
            'Actual Rows': 200, 'Actual Loops': 1, 'Actual Total Time': 1.5 }] }
      ]
    }
  }]))
  ok('root type', p.nodeType === 'Hash Join')
  ok('join type kept', p.joinType === 'Inner')
  ok('index name surfaced', p.children[1].children[0].indexName === 'b_pkey')
  ok('hash cond becomes the filter line', p.filter === '(a.id = b.a_id)')
  ok('root self excludes children', near(p.selfMs, 2.5), String(p.selfMs))
  ok('leaf self equals its own', near(p.children[0].selfMs, 8.0))
  ok('hottest is the seq scan', near(maxSelfMs(p), 8.0))
  ok('self times sum to the root elapsed',
     near(p.selfMs! + p.children[0].selfMs! + p.children[1].selfMs! + p.children[1].children[0].selfMs!, 12.5))
}

console.log('\nloops')
{
  const p = parsePlan(JSON.stringify([{
    Plan: {
      'Node Type': 'Nested Loop', 'Startup Cost': 0, 'Total Cost': 50,
      'Plan Rows': 500, 'Plan Width': 8, 'Actual Rows': 500, 'Actual Loops': 1, 'Actual Total Time': 20,
      Plans: [{ 'Node Type': 'Index Scan', 'Relation Name': 't', 'Parent Relationship': 'Inner',
        'Startup Cost': 0, 'Total Cost': 5, 'Plan Rows': 1, 'Plan Width': 8,
        'Actual Rows': 1, 'Actual Loops': 500, 'Actual Total Time': 0.03 }]
    }
  }]))
  const inner = p.children[0]
  ok('loops multiply elapsed', near(inner.elapsedMs, 15), String(inner.elapsedMs))
  ok('parent nets off the looped child', near(p.selfMs, 5), String(p.selfMs))
  // Both row figures are per-loop. Scaling only the actual side reported a
  // perfect 1-row-per-loop estimate as being off by 500x.
  ok('actual rows stay per-loop', inner.actualRows === 1, String(inner.actualRows))
  ok('plan rows stay per-loop', inner.planRows === 1)
  ok('loop count preserved for display', inner.loops === 500)
  ok('  so the ratio is 1, not 500', (inner.actualRows ?? 0) / inner.planRows === 1)
}

console.log('\nparallel plans')
{
  // Actual Total Time under a Gather is CPU summed across workers, not elapsed.
  // Subtracting it raw from the Gather's wall clock goes hugely negative.
  const p = parsePlan(JSON.stringify([{
    Plan: {
      'Node Type': 'Aggregate', 'Startup Cost': 0, 'Total Cost': 100,
      'Plan Rows': 1, 'Plan Width': 8, 'Actual Rows': 1, 'Actual Loops': 1, 'Actual Total Time': 75.4,
      Plans: [{ 'Node Type': 'Gather', 'Workers Planned': 2, 'Workers Launched': 2,
        'Startup Cost': 0, 'Total Cost': 90, 'Plan Rows': 3, 'Plan Width': 8,
        'Actual Rows': 3, 'Actual Loops': 1, 'Actual Total Time': 75.34,
        Plans: [{ 'Node Type': 'Partial Aggregate', 'Parallel Aware': false,
          'Startup Cost': 0, 'Total Cost': 80, 'Plan Rows': 1, 'Plan Width': 8,
          'Actual Rows': 1, 'Actual Loops': 3, 'Actual Total Time': 72.35,
          Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'big', 'Parallel Aware': true,
            'Startup Cost': 0, 'Total Cost': 70, 'Plan Rows': 100, 'Plan Width': 8,
            'Actual Rows': 100, 'Actual Loops': 3, 'Actual Total Time': 72.05 }] }] }]
    }
  }]))
  const gather = p.children[0]
  const scan = gather.children[0].children[0]
  ok('worker time is divided by participants', near(scan.elapsedMs, 72.05), String(scan.elapsedMs))
  ok('  which is under the total runtime', (scan.elapsedMs ?? 0) < 75.4)
  ok('gather self time is positive', (gather.selfMs ?? 0) > 0, String(gather.selfMs))
  ok('  and small', near(gather.selfMs, 3.0), String(gather.selfMs))
  ok('worker count exposed', gather.workers === 2)
  const total = (n: typeof p): number => n.children.reduce((t, c) => t + total(c), n.selfMs ?? 0)
  ok('self times sum to roughly the runtime', Math.abs(total(p) - 75.4) < 0.2, String(total(p)))
}

console.log('\nmaterialised CTE')
{
  // The CTE body is timed in its InitPlan and again inside every CTE Scan.
  const p = parsePlan(JSON.stringify([{
    Plan: {
      'Node Type': 'Limit', 'Startup Cost': 0, 'Total Cost': 10,
      'Plan Rows': 1, 'Plan Width': 8, 'Actual Rows': 1, 'Actual Loops': 1, 'Actual Total Time': 100,
      Plans: [
        { 'Node Type': 'Aggregate', 'Parent Relationship': 'InitPlan', 'Subplan Name': 'CTE m',
          'Startup Cost': 0, 'Total Cost': 5, 'Plan Rows': 1, 'Plan Width': 8,
          'Actual Rows': 1, 'Actual Loops': 1, 'Actual Total Time': 100,
          Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'big', 'Parent Relationship': 'Outer',
            'Startup Cost': 0, 'Total Cost': 4, 'Plan Rows': 100, 'Plan Width': 8,
            'Actual Rows': 100, 'Actual Loops': 1, 'Actual Total Time': 100 }] },
        { 'Node Type': 'Nested Loop', 'Parent Relationship': 'Outer',
          'Startup Cost': 0, 'Total Cost': 9, 'Plan Rows': 1, 'Plan Width': 8,
          'Actual Rows': 1, 'Actual Loops': 1, 'Actual Total Time': 100,
          Plans: [
            { 'Node Type': 'CTE Scan', 'CTE Name': 'm', 'Parent Relationship': 'Outer',
              'Startup Cost': 0, 'Total Cost': 1, 'Plan Rows': 1, 'Plan Width': 8,
              'Actual Rows': 1, 'Actual Loops': 1, 'Actual Total Time': 100 },
            { 'Node Type': 'CTE Scan', 'CTE Name': 'm', 'Parent Relationship': 'Inner',
              'Startup Cost': 0, 'Total Cost': 1, 'Plan Rows': 1, 'Plan Width': 8,
              'Actual Rows': 1, 'Actual Loops': 1, 'Actual Total Time': 0 }
          ] }
      ]
    }
  }]))
  const init = p.children[0]
  const loop = p.children[1]
  ok('the real work is under the InitPlan', near(init.children[0].selfMs, 100))
  ok('the first CTE Scan is discounted to zero', near(loop.children[0].selfMs, 0), String(loop.children[0].selfMs))
  // The build is paid once, so the discount is a budget, not a per-scan subtraction.
  ok('the second CTE Scan is not double-discounted', near(loop.children[1].selfMs, 0), String(loop.children[1].selfMs))
  const total = (n: typeof p): number => n.children.reduce((t, c) => t + total(c), n.selfMs ?? 0)
  ok('totals match the runtime rather than doubling it', Math.abs(total(p) - 100) < 0.5, String(total(p)))
  ok('InitPlan work is not charged to its parent', near(p.selfMs, 0), String(p.selfMs))
  ok('subplan name kept for labelling', init.subplanName === 'CTE m')
}

console.log('\ndegenerate input')
{
  const plain = parsePlan(JSON.stringify([{ Plan: {
    'Node Type': 'Seq Scan', 'Relation Name': 't',
    'Startup Cost': 0, 'Total Cost': 30, 'Plan Rows': 100, 'Plan Width': 4 } }]))
  ok('no timings without ANALYZE', plain.elapsedMs === undefined && plain.selfMs === undefined)
  ok('costs still present', plain.totalCost === 30)
  ok('loops default to 1', plain.loops === 1)
}
ok('accepts a bare object', parsePlan(JSON.stringify({ Plan: {
  'Node Type': 'Result', 'Startup Cost': 0, 'Total Cost': 1, 'Plan Rows': 1, 'Plan Width': 0 } })).nodeType === 'Result')
{
  let threw = false
  try { parsePlan('[]') } catch { threw = true }
  ok('rejects an empty plan', threw)
}
{
  const never = parsePlan(JSON.stringify([{ Plan: {
    'Node Type': 'Index Scan', 'Startup Cost': 0, 'Total Cost': 1,
    'Plan Rows': 1, 'Plan Width': 0, 'Actual Rows': 0, 'Actual Loops': 0, 'Actual Total Time': 0 } }]))
  ok('a never-executed node does not produce NaN', Number.isFinite(never.selfMs ?? 0))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
