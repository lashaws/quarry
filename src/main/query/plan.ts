import type { PlanNode } from '@shared/ipc'

interface RawPlan {
  'Node Type': string
  'Parent Relationship'?: string
  'Subplan Name'?: string
  'CTE Name'?: string
  'Relation Name'?: string
  Alias?: string
  'Index Name'?: string
  'Startup Cost': number
  'Total Cost': number
  'Plan Rows': number
  'Plan Width': number
  'Actual Rows'?: number
  'Actual Loops'?: number
  'Actual Total Time'?: number
  'Workers Launched'?: number
  'Workers Planned'?: number
  'Parallel Aware'?: boolean
  Filter?: string
  'Index Cond'?: string
  'Hash Cond'?: string
  'Join Type'?: string
  Plans?: RawPlan[]
}

/**
 * Converts EXPLAIN (FORMAT JSON) into a tree with per-node self time.
 *
 * Three things make the arithmetic non-obvious, and getting any of them wrong
 * makes the viewer point at the wrong node — which is its only job:
 *
 *  1. `Actual Total Time` is per-loop and cumulative over children, so a node's
 *     own total is `time x loops` minus what its children accounted for.
 *  2. Under a Gather, that product is CPU time summed across workers, not
 *     elapsed time. Subtracting it from the Gather's wall clock yields a large
 *     negative number; clamping that to zero hides the error and leaves the
 *     worker's scan claiming more time than the whole query took.
 *  3. A materialised CTE is timed twice: once in the InitPlan that builds it and
 *     again inside every CTE Scan that reads it.
 */
export function parsePlan(json: string): PlanNode {
  const parsed = JSON.parse(json) as [{ Plan: RawPlan }] | { Plan: RawPlan }
  const root = Array.isArray(parsed) ? parsed[0]?.Plan : parsed?.Plan
  if (!root) throw new Error('Could not read the query plan')

  const node = convert(root, 1)
  // CTE bodies are timed in their InitPlan and again in every CTE Scan.
  discountCtes(node, collectCteTimes(node))
  return node
}

function convert(raw: RawPlan, divisor: number): PlanNode {
  const loops = raw['Actual Loops'] ?? 1

  // A Gather's children run concurrently across the leader plus its workers, so
  // their summed time has to be divided back down to elapsed time.
  const participants = (raw['Workers Launched'] ?? 0) + 1
  const childDivisor = /^Gather/.test(raw['Node Type']) ? divisor * participants : divisor

  const children = (raw.Plans ?? []).map((c) => convert(c, childDivisor))

  const perLoop = raw['Actual Total Time']
  const elapsedMs = perLoop === undefined ? undefined : (perLoop * loops) / divisor

  // Only real inputs count against this node; an InitPlan or SubPlan is separate
  // work hanging off it, not part of its own cost.
  const inlineChildMs = children
    .filter((c) => c.relationship !== 'InitPlan' && c.relationship !== 'SubPlan')
    .reduce((n, c) => n + (c.elapsedMs ?? 0), 0)

  return {
    nodeType: raw['Node Type'],
    relationship: raw['Parent Relationship'],
    subplanName: raw['Subplan Name'],
    cteName: raw['CTE Name'],
    relation: raw['Relation Name'],
    alias: raw.Alias,
    indexName: raw['Index Name'],
    startupCost: raw['Startup Cost'],
    totalCost: raw['Total Cost'],
    // Both row figures are per-loop; the UI multiplies both or neither.
    planRows: raw['Plan Rows'],
    planWidth: raw['Plan Width'],
    actualRows: raw['Actual Rows'],
    loops,
    workers: raw['Workers Launched'],
    parallelAware: raw['Parallel Aware'] === true || (raw['Workers Launched'] ?? 0) > 0,
    elapsedMs,
    selfMs: elapsedMs === undefined ? undefined : elapsedMs - inlineChildMs,
    filter: raw.Filter ?? raw['Index Cond'] ?? raw['Hash Cond'],
    joinType: raw['Join Type'],
    children
  }
}

/** Elapsed time of each materialised CTE, keyed by its name. */
function collectCteTimes(node: PlanNode, into = new Map<string, number>()): Map<string, number> {
  // InitPlan nodes are labelled "CTE <name>" in Subplan Name.
  const m = /^CTE (.+)$/.exec(node.subplanName ?? '')
  if (m && node.elapsedMs !== undefined) {
    into.set(m[1], (into.get(m[1]) ?? 0) + node.elapsedMs)
  }
  for (const c of node.children) collectCteTimes(c, into)
  return into
}

/**
 * Removes CTE build time from the scans that merely read it.
 *
 * The build is paid once no matter how many scans read the result, so the
 * discount is a budget drawn down across them rather than applied to each —
 * subtracting it per scan drives later scans deeply negative and cancels the
 * real work out of the totals.
 */
function discountCtes(node: PlanNode, budget: Map<string, number>): void {
  if (node.nodeType === 'CTE Scan' && node.cteName && node.selfMs !== undefined) {
    const left = budget.get(node.cteName)
    if (left !== undefined && left > 0) {
      const take = Math.min(left, node.selfMs)
      node.selfMs -= take
      budget.set(node.cteName, left - take)
    }
  }
  for (const c of node.children) discountCtes(c, budget)
}

/** Largest self time in the tree, used to scale the heat bars. */
export function maxSelfMs(node: PlanNode): number {
  return node.children.reduce((n, c) => Math.max(n, maxSelfMs(c)), node.selfMs ?? 0)
}
