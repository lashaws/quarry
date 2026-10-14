/**
 * connections.json round-trip for the AWS fields. Runs against the Electron
 * stub, whose userData is a throwaway temp directory.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { ConnectionConfig } from '@shared/ipc'
import { listConnections, parseShareFile, removeConnection, saveConnection, shareFileName, toShareFile } from '../src/main/store/connections.ts'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, extra = ''): void => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? '\n       ' + extra : ''}`) }
}

const dir = app.getPath('userData')
const raw = (name: string): string => readFileSync(join(dir, name), 'utf8')

const aws: ConnectionConfig = {
  id: 'aws-1', name: 'TEST — admin', engine: 'postgres',
  host: '127.0.0.1', port: 15433, database: 'trueage', user: 'trueage_admin',
  sslMode: 'verify-full', sslServerName: 'trueage-test.c1wgmosm4jiq.us-east-2.rds.amazonaws.com',
  ssmTunnel: {
    profile: 'trueage-test-admin', region: 'us-east-2', target: 'i-0f4d5d2e346e2945e',
    remoteHost: 'trueage-test.c1wgmosm4jiq.us-east-2.rds.amazonaws.com', remotePort: 5432, localPort: 15433
  },
  passwordSource: { kind: 'aws-secret', profile: 'trueage-test-admin', region: 'us-east-2', secretId: 'trueage/test/db-admin', jsonKey: 'password' }
}
const plain: ConnectionConfig = { id: 'plain-1', name: 'Local', engine: 'postgres', host: 'localhost', port: 5433, database: 'd', user: 'u' }

console.log('round trip')
{
  saveConnection(plain, 'keychain-pw')
  saveConnection(aws)
  const back = listConnections().find((c) => c.id === 'aws-1')
  ok('tunnel and password source survive a save and list', JSON.stringify(back) === JSON.stringify(aws), JSON.stringify(back))
  ok('optional fields stay optional', listConnections().find((c) => c.id === 'plain-1')?.ssmTunnel === undefined)
  ok('a connection without the fields has none written', !raw('connections.json').split('"id": "plain-1"')[1].split('}')[0].includes('ssmTunnel'))
}

console.log('no password is stored')
{
  const withoutKey = { ...aws, id: 'aws-2', passwordSource: { ...aws.passwordSource!, jsonKey: undefined } }
  saveConnection(withoutKey)
  ok('jsonKey may be absent', listConnections().find((c) => c.id === 'aws-2')?.passwordSource?.jsonKey === undefined)
  ok('connections.json holds the secret id, not a password', raw('connections.json').includes('trueage/test/db-admin') && !/"password"\s*:/.test(raw('connections.json')))
  ok('the vault has an entry only for the keychain connection', Object.keys(JSON.parse(raw('secrets.json')) as object).join() === 'plain-1')
}

console.log('edit and remove')
{
  saveConnection({ ...aws, ssmTunnel: { ...aws.ssmTunnel!, localPort: undefined } })
  ok('an edit replaces the tunnel in place', listConnections().filter((c) => c.id === 'aws-1').length === 1 && listConnections().find((c) => c.id === 'aws-1')?.ssmTunnel?.localPort === undefined)
  saveConnection({ ...aws, ssmTunnel: undefined, passwordSource: undefined })
  const cleared = listConnections().find((c) => c.id === 'aws-1')
  ok('unticking the AWS options removes them', cleared?.ssmTunnel === undefined && cleared?.passwordSource === undefined)
  removeConnection('aws-1')
  ok('remove works for AWS connections', !listConnections().some((c) => c.id === 'aws-1'))
}

console.log('sharing with a teammate')
{
  const file = JSON.stringify(toShareFile([aws, { ...plain, ssl: true }]))
  ok('the shared file carries no ids', !file.includes('aws-1') && !file.includes('plain-1'))
  ok('the shared file carries no password', !file.includes('keychain-pw') && !/"password"\s*:/.test(file))
  ok('the legacy ssl flag travels as an sslMode', !file.includes('"ssl"') && file.includes('"require"'))
  const back = parseShareFile(file)
  ok('round trip keeps the AWS settings', JSON.stringify(back[0]) === JSON.stringify({ ...aws, id: '' }), JSON.stringify(back[0]))
  ok('imports arrive unsaved', back.every((c) => c.id === ''))
  ok('two connections in, two out', back.length === 2 && back[1].port === 5433)

  const throws = (text: string, needle: string): boolean => {
    try { parseShareFile(text); return false } catch (e) { return (e as Error).message.includes(needle) }
  }
  ok('garbage is refused', throws('{nope', 'not valid JSON'))
  ok('another JSON file is refused', throws('{"connections": []}', 'not a Quarry connection file'))
  ok('a future version is refused', throws(JSON.stringify({ format: 'quarry.connections', version: 2, connections: [] }), 'newer'))
  const hostile = parseShareFile(JSON.stringify({
    format: 'quarry.connections', version: 1,
    connections: [{ name: 'x', id: 'evil', host: 7, port: -1, sslMode: 'yolo', file: '/etc/passwd', color: 'red; x', extra: 1 }]
  }))[0] as unknown as Record<string, unknown>
  ok('unknown or mistyped fields are dropped', hostile['id'] === '' && hostile['host'] === 'localhost' && hostile['port'] === 5432 &&
    hostile['sslMode'] === 'disable' && !('file' in hostile) && !('extra' in hostile) && !('color' in hostile), JSON.stringify(hostile))
  ok('file name comes from the connection name', shareFileName([aws]) === 'test-admin.quarry.json')
  ok('several connections get a generic name', shareFileName([aws, plain]) === 'connections.quarry.json')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
