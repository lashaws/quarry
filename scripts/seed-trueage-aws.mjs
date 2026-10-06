#!/usr/bin/env node
/**
 * One-off: point the developer's TrueAge connections at their SSM tunnels and
 * Secrets Manager passwords, so Connect does what the old shell script did.
 *
 *   node scripts/seed-trueage-aws.mjs --dry-run   # print what would change, write nothing
 *   node scripts/seed-trueage-aws.mjs             # back up connections.json, then write
 *   --file <path>                                 # a different connections.json
 *
 * Edits the four existing TrueAge connections in place, matched by exact name, keeping
 * their ids, names and colours, and adds the read-only TEST connection. "TrueAge (local
 * Docker)" is not touched. It never reads or writes secrets.json: a password saved in
 * the keychain for these ids is simply no longer used. Quit Quarry first, or its next
 * save of a connection can write the old file back over this.
 *
 * Re-running is safe: it matches by name and reports "no change" when already seeded.
 */
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const fileArg = args.indexOf('--file')
const file = fileArg >= 0 ? args[fileArg + 1] : join(homedir(), 'Library', 'Application Support', 'quarry', 'connections.json')

const REGION = 'us-east-2'
const ENVS = {
  test: {
    profile: 'trueage-test-admin',
    target: 'i-0f4d5d2e346e2945e',
    host: 'trueage-test.c1wgmosm4jiq.us-east-2.rds.amazonaws.com',
    defaultLocalPort: 15433,
    color: '#d9a400'
  },
  prod: {
    profile: 'trueage-prod-admin',
    target: 'i-0fed053d960fdd0cf',
    host: 'trueage-prod.proxy-cbc6oakgoy12.us-east-2.rds.amazonaws.com',
    defaultLocalPort: 55433,
    color: '#d9342b'
  }
}

/** name -> what to apply. `create` is true only for the connection that may not exist yet. */
const TARGETS = [
  { name: 'TrueAge TEST — admin (trueage_db_admin)', env: 'test', user: 'trueage_admin', secret: 'trueage/test/db-admin' },
  { name: 'TrueAge TEST — read-only (trueage_report)', env: 'test', user: 'trueage_report', secret: 'trueage/test/db-report', create: true },
  { name: 'TrueAge PROD — admin (trueage_admin)', env: 'prod', user: 'trueage_admin', secret: 'trueage/prod/db-admin' },
  { name: 'TrueAge PROD — read-only (trueage_report)', env: 'prod', user: 'trueage_report', secret: 'trueage/prod/db-report' }
]

if (!existsSync(file)) {
  console.error(`No connections file at ${file}`)
  process.exit(1)
}
const connections = JSON.parse(readFileSync(file, 'utf8'))
if (!Array.isArray(connections)) {
  console.error(`${file} is not a JSON array of connections`)
  process.exit(1)
}

/** Fields written onto a connection. Everything else on it is left as it was. */
function desired(existing, t) {
  const e = ENVS[t.env]
  const localPort = existing?.ssmTunnel?.localPort ?? (existing?.port && existing.port !== 5432 ? existing.port : e.defaultLocalPort)
  return {
    engine: 'postgres',
    host: '127.0.0.1',
    port: localPort,
    database: existing?.database ?? 'trueage',
    user: t.user,
    sslMode: 'verify-full',
    sslServerName: e.host,
    ssmTunnel: { profile: e.profile, region: REGION, target: e.target, remoteHost: e.host, remotePort: 5432, localPort },
    passwordSource: { kind: 'aws-secret', profile: e.profile, region: REGION, secretId: t.secret, jsonKey: 'password' }
  }
}

const show = (v) => (v === undefined ? '(unset)' : JSON.stringify(v))
const missing = []
const next = connections.map((c) => c)
let changed = 0

for (const t of TARGETS) {
  const i = next.findIndex((c) => c.name === t.name)
  if (i < 0 && !t.create) {
    missing.push(t.name)
    continue
  }
  const existing = i >= 0 ? next[i] : undefined
  const want = desired(existing, t)
  const merged = existing
    ? { ...existing, ...want }
    : { id: randomUUID(), name: t.name, ...want, color: ENVS[t.env].color }

  const diffs = Object.keys(merged).filter((k) => JSON.stringify(existing?.[k]) !== JSON.stringify(merged[k]))
  console.log(`\n${existing ? 'UPDATE' : 'CREATE'}  ${t.name}   id ${merged.id}`)
  if (!diffs.length) console.log('  no change')
  for (const k of diffs) {
    // Only connection metadata lives in this file; no field here can hold a password.
    console.log(`  ${k}: ${existing ? show(existing[k]) + ' -> ' : ''}${show(merged[k])}`)
  }
  if (diffs.length) changed++
  if (i >= 0) next[i] = merged
  else next.push(merged)
}

for (const name of missing) console.log(`\nSKIP    ${name}  (no connection with that name; not created)`)
console.log(`\n${changed} connection(s) ${dryRun ? 'would change' : 'to write'}; "TrueAge (local Docker)" and any other connection untouched.`)

if (dryRun) {
  console.log('Dry run: nothing written.')
} else if (changed > 0) {
  const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  copyFileSync(file, backup)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  renameSync(tmp, file)
  console.log(`Backed up to ${backup}\nWrote ${file}`)
}
