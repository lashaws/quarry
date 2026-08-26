import type { ConnectionState, QueryResult, TxMode } from '@shared/ipc'

interface Props {
  connectionName: string | null
  state: ConnectionState | null
  result: QueryResult | null
  pendingEdits: number
  busy: boolean
  /** transient confirmation, e.g. after a clipboard copy */
  notice?: string | null
  onSetTxMode: (mode: TxMode) => void
  onCommit: () => void
  onRollback: () => void
}

export function StatusBar(props: Props) {
  const { state, result, pendingEdits, busy } = props
  const txMode = state?.txMode ?? 'auto'

  return (
    <div className="statusbar">
      <span>{props.connectionName ?? 'No connection'}</span>
      {state?.serverVersion && <span>PostgreSQL {state.serverVersion}</span>}

      <span className="spacer" />

      {busy && <span style={{ color: 'var(--accent)' }}>Running…</span>}
      {props.notice && <span style={{ color: 'var(--success)' }}>Copied {props.notice}</span>}

      {result && !result.error && (
        <>
          <span>
            {result.rowCount !== null && result.command !== 'SELECT'
              ? `${result.rowCount} affected`
              : `${result.rows.length}${result.complete ? '' : '+'} rows`}
          </span>
          <span>{result.durationMs} ms</span>
        </>
      )}

      {pendingEdits > 0 && <span className="q-pill dirty">{pendingEdits} pending</span>}

      {/*
        Auto vs manual commit is the transaction control DBeaver handles worst,
        so it lives permanently in the status bar rather than a settings page.
      */}
      <select
        value={txMode}
        onChange={(e) => props.onSetTxMode(e.target.value as TxMode)}
        style={{ padding: '0 4px', height: 18, fontSize: 11 }}
        title="Transaction mode"
      >
        <option value="auto">Auto-commit</option>
        <option value="manual">Manual commit</option>
      </select>

      {txMode === 'manual' && (
        <>
          <span className={`q-pill${state?.txStatus === 'active' ? ' tx-active' : ''}${state?.txStatus === 'failed' ? ' tx-failed' : ''}`}>
            {state?.txStatus === 'active' ? 'TX open' : state?.txStatus === 'failed' ? 'TX failed' : 'TX idle'}
          </span>
          <button
            className="ghost"
            style={{ padding: '0 6px', fontSize: 11 }}
            disabled={state?.txStatus === 'idle'}
            onClick={props.onCommit}
          >
            Commit
          </button>
          <button
            className="ghost"
            style={{ padding: '0 6px', fontSize: 11 }}
            disabled={state?.txStatus === 'idle'}
            onClick={props.onRollback}
          >
            Rollback
          </button>
        </>
      )}
    </div>
  )
}
