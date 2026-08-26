import { useMemo, useState } from 'react'
import type { PlanNode } from '@shared/ipc'

interface Props {
  plan: PlanNode
  analyzed: boolean
}

/** Self cost of a node: its total minus what its inputs already accounted for. */
const selfCost = (n: PlanNode): number =>
  Math.max(0, n.totalCost - n.children.reduce((t, c) => t + c.totalCost, 0))

const selfOf = (n: PlanNode, analyzed: boolean): number =>
  analyzed ? (n.selfMs ?? 0) : selfCost(n)

/** Deepest self time (or self cost) in the tree, for scaling the heat bars. */
function hottest(node: PlanNode, analyzed: boolean): number {
  return node.children.reduce(
    (n, c) => Math.max(n, hottest(c, analyzed)),
    selfOf(node, analyzed)
  )
}

export function PlanTree({ plan, analyzed }: Props) {
  const peak = useMemo(() => hottest(plan, analyzed) || 1, [plan, analyzed])
  return (
    <div className="plan-tree">
      <Node node={plan} analyzed={analyzed} peak={peak} depth={0} />
    </div>
  )
}

function Node({
  node, analyzed, peak, depth
}: { node: PlanNode; analyzed: boolean; peak: number; depth: number }) {
  const [open, setOpen] = useState(true)

  const self = selfOf(node, analyzed)
  // Self time can be negative once a CTE's build cost is discounted from the
  // scan that reads it; show the sign rather than hiding it behind a clamp.
  const share = peak > 0 ? Math.min(1, Math.max(0, self) / peak) : 0

  // Both row figures are per-loop, so the ratio compares them directly. Scaling
  // only the actual side by loops made every inner-loop node look 500x off.
  const misestimate =
    node.actualRows !== undefined && node.planRows > 0 ? node.actualRows / node.planRows : null
  // Postgres rounds actual rows per loop, so a genuinely productive node can
  // report 0 across many loops. There is nothing to judge in that case.
  const unjudgeable = node.actualRows === 0 && node.loops > 1
  const badEstimate =
    misestimate !== null && !unjudgeable && (misestimate > 10 || misestimate < 0.1)

  const target = node.indexName ?? node.relation
  return (
    <div className="plan-node" style={{ marginLeft: depth ? 16 : 0 }}>
      <div className="plan-row">
        <span
          className="plan-twisty"
          onClick={() => setOpen((v) => !v)}
          style={{ visibility: node.children.length ? 'visible' : 'hidden' }}
        >
          {open ? '▼' : '▶'}
        </span>

        <span className="plan-heat" title={analyzed ? 'share of total time' : 'share of total cost'}>
          <span style={{ width: `${Math.round(share * 100)}%` }} />
        </span>

        <span className="plan-type">{node.nodeType}</span>
        {node.joinType && <span className="plan-dim">{node.joinType}</span>}
        {target && <span className="plan-rel">on {target}</span>}
        {node.subplanName && <span className="plan-dim">[{node.subplanName}]</span>}
        {!!node.workers && <span className="plan-dim">×{node.workers + 1} workers</span>}
        {node.loops > 1 && <span className="plan-dim">×{formatRows(node.loops)} loops</span>}

        <span className="plan-spacer" />

        {analyzed ? (
          <>
            <span className="plan-metric" title="elapsed time in this node alone, workers divided out">
              {self.toFixed(2)} ms
            </span>
            <span className="plan-dim" title="rows estimated → actual, totalled over loops">
              {formatRows(node.planRows * node.loops)} →{' '}
              {formatRows((node.actualRows ?? 0) * node.loops)}
            </span>
          </>
        ) : (
          <>
            <span className="plan-metric" title="cost of this node alone">
              {self.toFixed(0)}
            </span>
            <span className="plan-dim" title="estimated rows">
              {formatRows(node.planRows * node.loops)} rows
            </span>
          </>
        )}
        {badEstimate && (
          <span className="plan-warn" title="row estimate is off by more than 10x">
            ⚠ estimate
          </span>
        )}
      </div>

      {node.filter && <div className="plan-filter" style={{ marginLeft: 34 }}>{node.filter}</div>}

      {open && node.children.map((c, i) => (
        <Node key={i} node={c} analyzed={analyzed} peak={peak} depth={depth + 1} />
      ))}
    </div>
  )
}

function formatRows(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}
