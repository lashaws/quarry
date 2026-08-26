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
