/**
 * Locates the vendored Amazon RDS global CA bundle.
 *
 * Deliberately free of any `electron` import: test/fixture.ts pulls the postgres
 * driver into plain Node, and importing electron there fails outside the app.
 * `process.resourcesPath` is a plain process property Electron sets when packaged
 * and leaves undefined elsewhere, so it needs no import to read.
 */
import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const FILE = 'rds-global-bundle.pem'

export function caBundlePath(): string {
  const packaged = process.resourcesPath
  if (typeof packaged === 'string' && packaged !== '') {
    const candidate = join(packaged, FILE)
    if (existsSync(candidate)) return candidate
  }
  // Dev and tests: the repo copy.
  return join(process.cwd(), 'resources', FILE)
}

export function readCaBundle(): string {
  return readFileSync(caBundlePath(), 'utf8')
}
