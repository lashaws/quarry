import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Catalog } from '@shared/ipc'
import { userDataDir } from './paths'

/**
 * The last catalog seen per connection, so the tree can still be browsed while
 * a tunnel is down. Metadata only: names, types and comments, never row data.
 */
const dir = (): string => {
  const d = join(userDataDir(), 'catalogs')
  mkdirSync(d, { recursive: true })
  return d
}

// Connection ids are UUIDs; refuse anything that could walk out of the folder.
const fileFor = (id: string): string | null => (/^[\w-]+$/.test(id) ? join(dir(), `${id}.json`) : null)

export function readCachedCatalog(id: string): Catalog | null {
  const p = fileFor(id)
  if (!p) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Catalog
  } catch {
    return null
  }
}

export function writeCachedCatalog(cat: Catalog): void {
  const p = fileFor(cat.connectionId)
  if (!p) return
  try {
    writeFileSync(`${p}.tmp`, JSON.stringify(cat), 'utf8')
    renameSync(`${p}.tmp`, p)
  } catch (err) {
    console.error('[quarry] could not cache catalog:', err)
  }
}

export function removeCachedCatalog(id: string): void {
  const p = fileFor(id)
  if (p) rmSync(p, { force: true })
}
