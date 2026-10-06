import { useEffect, useState } from 'react'
import type { ConnectionConfig, PasswordSource, SslMode, SsmTunnel } from '@shared/ipc'
import { SsoLoginButton } from './SsoLogin'

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
  sslMode: 'disable'
})

/** Legacy `ssl: true` meant encrypted-but-unverified, which is exactly `require`. */
const blankTunnel = (): SsmTunnel => ({ profile: '', region: 'us-east-2', target: '', remoteHost: '', remotePort: 5432 })
const blankSource = (): PasswordSource => ({ kind: 'aws-secret', profile: '', region: 'us-east-2', secretId: '' })

/** An enabled AWS option with a required field empty cannot connect; say so before Save. */
function awsIncomplete(c: ConnectionConfig): boolean {
  const t = c.ssmTunnel
  const p = c.passwordSource
  const tunnelBad = !!t && !(t.profile.trim() && t.region.trim() && t.target.trim() && t.remoteHost.trim() && t.remotePort > 0)
  const sourceBad = !!p && !(p.profile.trim() && p.region.trim() && p.secretId.trim())
  return tunnelBad || sourceBad
}

const modeOf = (c: ConnectionConfig): SslMode => c.sslMode ?? (c.ssl === true ? 'require' : 'disable')

export function ConnectionDialog({ initial, onCancel, onSaved, onDeleted }: Props) {
  const [cfg, setCfg] = useState<ConnectionConfig>(initial ?? blank())
  const [password, setPassword] = useState('')
  const [note, setNote] = useState<{ text: string; ok: boolean; ssoProfile?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [imports, setImports] = useState<ConnectionConfig[]>([])

  useEffect(() => {
    if (!initial) void window.api.connections.importFromDBeaver().then(setImports)
  }, [initial])

  const set = <K extends keyof ConnectionConfig>(k: K, v: ConnectionConfig[K]): void =>
    setCfg((c) => ({ ...c, [k]: v }))

  const setTunnel = (patch: Partial<SsmTunnel>): void =>
    setCfg((c) => ({ ...c, ssmTunnel: { ...(c.ssmTunnel ?? blankTunnel()), ...patch } }))
  const setSource = (patch: Partial<PasswordSource>): void =>
    setCfg((c) => ({ ...c, passwordSource: { ...(c.passwordSource ?? blankSource()), ...patch } }))
  const tunnel = cfg.ssmTunnel
  const source = cfg.passwordSource

  const test = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      const res = await window.api.connections.test(cfg, password || undefined)
      setNote({ text: res.message, ok: res.ok, ssoProfile: res.ssoLoginProfile })
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
              <input value={cfg.host ?? ''} disabled={!!tunnel} onChange={(e) => set('host', e.target.value)} />
            </div>
            <div className="q-field" style={{ flex: 1 }}>
              <label>Port</label>
              <input
                value={cfg.port ?? 5432}
                disabled={!!tunnel}
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
                disabled={!!source}
                placeholder={source ? 'from Secrets Manager' : initial ? 'unchanged' : ''}
              />
            </div>
          </div>
          <div className="q-row">
            <div>
              <label>SSL</label>
              <select
                value={modeOf(cfg)}
                onChange={(e) => {
                  const mode = e.target.value as SslMode
                  // Drop the legacy flag on edit so the two cannot disagree later.
                  setCfg((c) => ({ ...c, sslMode: mode, ssl: undefined }))
                }}
              >
                <option value="disable">disable — plaintext</option>
                <option value="require">require — encrypted, certificate not checked</option>
                <option value="verify-full">verify-full — encrypted and verified</option>
              </select>
            </div>
            <div>
              <label>Verify certificate as</label>
              <input
                value={cfg.sslServerName ?? ''}
                placeholder={cfg.host || 'same as host'}
                disabled={modeOf(cfg) !== 'verify-full'}
                onChange={(e) => set('sslServerName', e.target.value)}
              />
            </div>
          </div>
          {modeOf(cfg) === 'verify-full' && (
            <div className="q-note">
              Reaching the database through a port-forward? Put the real endpoint name here —
              the certificate is checked against it while the socket still goes to {cfg.host || 'the host'}.
            </div>
          )}
          <fieldset className="q-aws">
            <legend>AWS</legend>
            <label className="q-check">
              <input
                type="checkbox"
                checked={!!tunnel}
                onChange={(e) => setCfg((c) => ({ ...c, ssmTunnel: e.target.checked ? blankTunnel() : undefined }))}
              />
              Open an SSM port-forward when connecting
            </label>
            {tunnel && (
              <>
                <div className="q-row">
                  <div className="q-field">
                    <label htmlFor="q-tun-profile">AWS profile</label>
                    <input id="q-tun-profile" value={tunnel.profile} placeholder="trueage-test-admin" onChange={(e) => setTunnel({ profile: e.target.value })} />
                  </div>
                  <div className="q-field">
                    <label htmlFor="q-tun-region">Region</label>
                    <input id="q-tun-region" value={tunnel.region} onChange={(e) => setTunnel({ region: e.target.value })} />
                  </div>
                </div>
                <div className="q-field">
                  <label htmlFor="q-tun-target">Jump host (instance id)</label>
                  <input id="q-tun-target" value={tunnel.target} placeholder="i-0123456789abcdef0" onChange={(e) => setTunnel({ target: e.target.value })} />
                </div>
                <div className="q-row">
                  <div className="q-field" style={{ flex: 3 }}>
                    <label htmlFor="q-tun-host">Remote host</label>
                    <input id="q-tun-host" value={tunnel.remoteHost} placeholder="mydb.abc123.us-east-2.rds.amazonaws.com" onChange={(e) => setTunnel({ remoteHost: e.target.value })} />
                  </div>
                  <div className="q-field" style={{ flex: 1 }}>
                    <label htmlFor="q-tun-port">Remote port</label>
                    <input id="q-tun-port" inputMode="numeric" value={tunnel.remotePort || ''} onChange={(e) => setTunnel({ remotePort: Number(e.target.value) || 0 })} />
                  </div>
                  <div className="q-field" style={{ flex: 1 }}>
                    <label htmlFor="q-tun-local">Local port</label>
                    <input id="q-tun-local" inputMode="numeric" value={tunnel.localPort ?? ''} placeholder="any free" onChange={(e) => setTunnel({ localPort: Number(e.target.value) || undefined })} />
                  </div>
                </div>
                <div className="q-note">
                  Quarry connects to 127.0.0.1 on the local port; Host and Port above are ignored.
                  Set SSL to verify-full and put the remote host in &ldquo;Verify certificate as&rdquo; to still check the real certificate.
                </div>
              </>
            )}
            <label className="q-check">
              <input
                type="checkbox"
                checked={!!source}
                onChange={(e) => setCfg((c) => ({ ...c, passwordSource: e.target.checked ? blankSource() : undefined }))}
              />
              Read the password from AWS Secrets Manager on every connect
            </label>
            {source && (
              <>
                <div className="q-row">
                  <div className="q-field">
                    <label htmlFor="q-sec-profile">AWS profile</label>
                    <input id="q-sec-profile" value={source.profile} placeholder="trueage-test-admin" onChange={(e) => setSource({ profile: e.target.value })} />
                  </div>
                  <div className="q-field">
                    <label htmlFor="q-sec-region">Region</label>
                    <input id="q-sec-region" value={source.region} onChange={(e) => setSource({ region: e.target.value })} />
                  </div>
                </div>
                <div className="q-row">
                  <div className="q-field" style={{ flex: 3 }}>
                    <label htmlFor="q-sec-id">Secret id</label>
                    <input id="q-sec-id" value={source.secretId} placeholder="trueage/test/db-admin" onChange={(e) => setSource({ secretId: e.target.value })} />
                  </div>
                  <div className="q-field" style={{ flex: 1 }}>
                    <label htmlFor="q-sec-key">JSON key</label>
                    <input id="q-sec-key" value={source.jsonKey ?? ''} placeholder="password" onChange={(e) => setSource({ jsonKey: e.target.value || undefined })} />
                  </div>
                </div>
                <div className="q-note">The password is held in memory for the connect only. It is never saved, logged or put in the Keychain.</div>
              </>
            )}
          </fieldset>
          <div className="q-note">Passwords are stored in the macOS Keychain, never on disk in the clear.</div>
          {note && (
            <div className={`q-note ${note.ok ? 'ok' : 'bad'}`} role={note.ok ? 'status' : 'alert'}>
              {note.text}
            </div>
          )}
          {note?.ssoProfile && <SsoLoginButton profile={note.ssoProfile} onDone={() => void test()} />}
          {awsIncomplete(cfg) && <div className="q-note bad">Fill in every AWS field above (local port and JSON key are optional), or untick the option.</div>}
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
          <button onClick={test} disabled={busy || awsIncomplete(cfg)}>
            Test
          </button>
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={save} disabled={busy || !cfg.database || awsIncomplete(cfg)}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
