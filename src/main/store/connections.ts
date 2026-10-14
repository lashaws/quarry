import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import type { ConnectionConfig } from '@shared/ipc'
import { readJson, writeJson } from './json'
import { deleteSecret, setSecret } from './secrets'

const FILE = 'connections.json'

export function listConnections(): ConnectionConfig[] {
  return readJson<ConnectionConfig[]>(FILE, [])
}

export function saveConnection(cfg: ConnectionConfig, password?: string): ConnectionConfig {
  const all = listConnections()
  const next: ConnectionConfig = { ...cfg, id: cfg.id || randomUUID() }
  const i = all.findIndex((c) => c.id === next.id)
  if (i >= 0) all[i] = next
  else all.push(next)
  writeJson(FILE, all)
  if (password !== undefined) setSecret(next.id, password)
  return next
}

export function removeConnection(id: string): void {
  writeJson(FILE, listConnections().filter((c) => c.id !== id))
  deleteSecret(id)
}

interface DBeaverFile {
  connections?: Record<string, {
    provider?: string
    name?: string
    configuration?: { host?: string; port?: string; database?: string; type?: string }
  }>
  'connection-types'?: Record<string, { color?: string }>
}

/**
 * Import connection metadata from DBeaver. Deliberately reads only
 * data-sources.json and never touches credentials-config.json — passwords are
 * re-entered and stored in the Keychain rather than decrypted out of another
 * app's vault.
 */
export function importFromDBeaver(): ConnectionConfig[] {
  const root = join(homedir(), 'Library', 'DBeaverData')
  if (!existsSync(root)) return []

  const found: ConnectionConfig[] = []
  for (const ws of safeReaddir(root)) {
    for (const project of safeReaddir(join(root, ws))) {
      const file = join(root, ws, project, '.dbeaver', 'data-sources.json')
      if (!existsSync(file)) continue
      let parsed: DBeaverFile
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8')) as DBeaverFile
      } catch {
        continue
      }
      for (const src of Object.values(parsed.connections ?? {})) {
        if (src.provider !== 'postgresql') continue
        const cfg = src.configuration ?? {}
        found.push({
          id: randomUUID(),
          name: src.name ?? cfg.database ?? 'Imported',
          engine: 'postgres',
          host: cfg.host ?? 'localhost',
          port: cfg.port ? Number(cfg.port) : 5432,
          database: cfg.database ?? '',
          user: '',
          color: rgbToHex(parsed['connection-types']?.[cfg.type ?? '']?.color)
        })
      }
    }
  }

  // Don't offer duplicates of connections already configured here.
  const existing = new Set(
    listConnections().map((c) => `${c.host}:${c.port}/${c.database}`)
  )
  return found.filter((c) => !existing.has(`${c.host}:${c.port}/${c.database}`))
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
}

function rgbToHex(rgb?: string): string | undefined {
  if (!rgb) return undefined
  const parts = rgb.split(',').map((n) => Number(n.trim()))
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return undefined
  // DBeaver marks the default type as pure white; that's not a useful accent.
  if (parts.every((n) => n === 255)) return undefined
  return '#' + parts.map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('')
}

/**
 * Sharing a connection with a teammate. The file carries everything needed to
 * reach the database — host, SSL, SSM tunnel, Secrets Manager source — and
 * never a password: Keychain entries stay on this machine, and a Secrets
 * Manager source resolves with the teammate's own AWS credentials.
 */
export const SHARE_FORMAT = 'quarry.connections'

export interface SharedFile {
  format: typeof SHARE_FORMAT
  version: 1
  connections: Omit<ConnectionConfig, 'id'>[]
}

export function toShareFile(cfgs: ConnectionConfig[]): SharedFile {
  return {
    format: SHARE_FORMAT,
    version: 1,
    connections: cfgs.map((c) => {
      const out: Omit<ConnectionConfig, 'id'> = {
        name: c.name,
        engine: c.engine,
        host: c.host,
        port: c.port,
        database: c.database,
        user: c.user,
        // Write the resolved mode so the legacy flag never travels.
        sslMode: c.sslMode ?? (c.ssl === true ? 'require' : 'disable'),
        sslServerName: c.sslServerName || undefined,
        ssmTunnel: c.ssmTunnel ? { ...c.ssmTunnel } : undefined,
        passwordSource: c.passwordSource ? { ...c.passwordSource } : undefined,
        color: c.color
      }
      return JSON.parse(JSON.stringify(out)) as Omit<ConnectionConfig, 'id'>
    })
  }
}

/**
 * Parse a shared file into unsaved configs (empty id). Only known fields of the
 * right type are copied, so a hand-edited or hostile file can't smuggle
 * anything else into connections.json.
 */
export function parseShareFile(text: string): ConnectionConfig[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('That file is not valid JSON.')
  }
  const file = raw as Partial<SharedFile> | null
  if (!file || typeof file !== 'object' || file.format !== SHARE_FORMAT || !Array.isArray(file.connections)) {
    throw new Error('That is not a Quarry connection file.')
  }
  if (file.version !== 1) throw new Error(`Connection file version ${String(file.version)} is newer than this Quarry understands.`)

  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)
  const obj = (v: unknown): Record<string, unknown> | undefined =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  const modes = ['disable', 'require', 'verify-full'] as const

  return file.connections.map((entry, i) => {
    const c = obj(entry)
    if (!c) throw new Error(`Connection ${i + 1} in the file is malformed.`)
    const t = obj(c['ssmTunnel'])
    const p = obj(c['passwordSource'])
    const mode = modes.find((m) => m === c['sslMode'])
    const cfg: ConnectionConfig = {
      id: '',
      name: str(c['name']) || str(c['database']) || 'Imported',
      engine: 'postgres',
      host: str(c['host']) ?? 'localhost',
      port: num(c['port']) ?? 5432,
      database: str(c['database']) ?? '',
      user: str(c['user']) ?? '',
      sslMode: mode ?? 'disable',
      sslServerName: str(c['sslServerName']) || undefined,
      ssmTunnel: t
        ? {
            profile: str(t['profile']) ?? '',
            region: str(t['region']) ?? '',
            target: str(t['target']) ?? '',
            remoteHost: str(t['remoteHost']) ?? '',
            remotePort: num(t['remotePort']) ?? 5432,
            localPort: num(t['localPort'])
          }
        : undefined,
      passwordSource: p
        ? {
            kind: 'aws-secret',
            profile: str(p['profile']) ?? '',
            region: str(p['region']) ?? '',
            secretId: str(p['secretId']) ?? '',
            jsonKey: str(p['jsonKey']) || undefined
          }
        : undefined,
      color: /^#[0-9a-f]{6}$/i.test(str(c['color']) ?? '') ? str(c['color']) : undefined
    }
    return JSON.parse(JSON.stringify(cfg)) as ConnectionConfig
  })
}

/** "TEST — admin" -> "test-admin.quarry.json" */
export function shareFileName(cfgs: ConnectionConfig[]): string {
  const base = cfgs.length === 1 ? cfgs[0].name : 'connections'
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'connection'
  return `${slug}.quarry.json`
}
