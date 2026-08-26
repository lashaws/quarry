import { useEffect, useState } from 'react'
import type { ConnectionConfig } from '@shared/ipc'

interface Props {
  initial: ConnectionConfig | null
  onCancel: () => void
  onSaved: (cfg: ConnectionConfig) => void
  onDeleted: (id: string) => void
}

const blank = (): ConnectionConfig => ({
  id: '',
  name: '',
  engine: 'postgres',
  host: 'localhost',
  port: 5432,
  database: '',
  user: '',
  ssl: false
})

export function ConnectionDialog({ initial, onCancel, onSaved, onDeleted }: Props) {
  const [cfg, setCfg] = useState<ConnectionConfig>(initial ?? blank())
  const [password, setPassword] = useState('')
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [imports, setImports] = useState<ConnectionConfig[]>([])

  useEffect(() => {
    if (!initial) void window.api.connections.importFromDBeaver().then(setImports)
  }, [initial])

  const set = <K extends keyof ConnectionConfig>(k: K, v: ConnectionConfig[K]): void =>
    setCfg((c) => ({ ...c, [k]: v }))

  const test = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      const res = await window.api.connections.test(cfg, password || undefined)
      setNote({ text: res.message, ok: res.ok })
    } finally {
      setBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const saved = await window.api.connections.save(
        { ...cfg, name: cfg.name || cfg.database || 'Connection' },
        password || undefined
      )
      onSaved(saved)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="q-overlay" onMouseDown={onCancel}>
      <div className="q-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{initial ? 'Edit Connection' : 'New Connection'}</h2>
        <div className="q-body">
          {!initial && imports.length > 0 && (
            <div className="q-note">
              Found in DBeaver:{' '}
              {imports.map((i) => (
                <button
                  key={i.id}
                  className="ghost"
                  style={{ textDecoration: 'underline', padding: '0 4px' }}
                  onClick={() => {
                    setCfg({ ...i, id: '' })
                    setNote({ text: 'Imported — enter the user and password.', ok: true })
                  }}
                >
                  {i.name}
                </button>
              ))}
            </div>
          )}

          <div className="q-field">
            <label>Name</label>
            <input value={cfg.name} onChange={(e) => set('name', e.target.value)} placeholder="Local Postgres" />
          </div>
          <div className="q-row">
            <div className="q-field" style={{ flex: 3 }}>
              <label>Host</label>
              <input value={cfg.host ?? ''} onChange={(e) => set('host', e.target.value)} />
            </div>
            <div className="q-field" style={{ flex: 1 }}>
              <label>Port</label>
              <input
                value={cfg.port ?? 5432}
                onChange={(e) => set('port', Number(e.target.value) || 5432)}
              />
            </div>
          </div>
          <div className="q-field">
            <label>Database</label>
            <input value={cfg.database ?? ''} onChange={(e) => set('database', e.target.value)} />
          </div>
          <div className="q-row">
            <div className="q-field">
              <label>User</label>
              <input value={cfg.user ?? ''} onChange={(e) => set('user', e.target.value)} />
            </div>
            <div className="q-field">
              <label>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={initial ? 'unchanged' : ''}
              />
            </div>
          </div>
          <label className="q-note" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={!!cfg.ssl}
              onChange={(e) => set('ssl', e.target.checked)}
            />
            Use SSL
          </label>
          <div className="q-note">Passwords are stored in the macOS Keychain, never on disk in the clear.</div>
          {note && <div className={`q-note ${note.ok ? 'ok' : 'bad'}`}>{note.text}</div>}
        </div>
        <div className="q-footer">
          {initial && (
            <button
              onClick={() => onDeleted(initial.id)}
              style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
            >
              Delete
            </button>
          )}
          <div className="spacer" />
          <button onClick={test} disabled={busy}>
            Test
          </button>
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={save} disabled={busy || !cfg.database}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
