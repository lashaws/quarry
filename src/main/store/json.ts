import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { filePath } from './paths'

/** Small atomic JSON file store. Avoids a dependency for a job this size. */
export function readJson<T>(name: string, fallback: T): T {
  const p = filePath(name)
  if (!existsSync(p)) return fallback
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T
  } catch {
    return fallback
  }
}

export function writeJson(name: string, value: unknown): void {
  const p = filePath(name)
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, p)
}
