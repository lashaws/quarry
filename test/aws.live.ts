/**
 * Drives the real Session through an SSM tunnel and a Secrets Manager password
 * against the TrueAge TEST database, read-only login. Needs a live
 * `aws sso login --profile trueage-test-admin`; not part of test:all for that
 * reason. Run `pgrep -fl session-manager-plugin` before and after: no tunnel
 * process may survive it.
 */
import { Session } from '../src/main/session.ts'
import type { ConnectionConfig } from '@shared/ipc'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, extra = ''): void => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? '\n       ' + extra : ''}`) }
}

const HOST = 'trueage-test.c1wgmosm4jiq.us-east-2.rds.amazonaws.com'
const cfg: ConnectionConfig = {
  id: 'aws-live', name: 'TrueAge TEST — read-only (live check)', engine: 'postgres',
  host: '127.0.0.1', database: 'trueage', user: 'trueage_report',
  sslMode: 'verify-full', sslServerName: HOST,
  ssmTunnel: { profile: 'trueage-test-admin', region: 'us-east-2', target: 'i-0f4d5d2e346e2945e', remoteHost: HOST, remotePort: 5432 },
  passwordSource: { kind: 'aws-secret', profile: 'trueage-test-admin', region: 'us-east-2', secretId: 'trueage/test/db-report' }
}

const session = new Session()

async function main(): Promise<void> {
  console.log('test (open, connect, close)')
  const t = await session.test(cfg)
  ok('Test connects through the tunnel', t.ok, t.message)
  console.log(`       ${t.message}`)
  ok('Test leaves no tunnel behind', session.tunnelStatus().length === 0)

  console.log('connect and query')
  const st = await session.connect(cfg)
  ok('connected', st.connected)
  ok('verify-full did not downgrade', st.sslWarning === undefined, st.sslWarning)
  ok('one tunnel open, one user', session.tunnelStatus().length === 1 && session.tunnelStatus()[0].users === 1)
  const res = await session.run({ connectionId: cfg.id, sql: 'select current_user, inet_server_port() as port' }, cfg.name)
  console.log(`       current_user = ${res.rows[0]?.[0]}`)
  ok('current_user is trueage_report', res.rows[0]?.[0] === 'trueage_report')

  console.log('second connection shares the tunnel')
  const second = { ...cfg, id: 'aws-live-2', name: 'second tab' }
  await session.connect(second)
  ok('still one tunnel, two users', session.tunnelStatus().length === 1 && session.tunnelStatus()[0].users === 2)
  await session.disconnect(second.id)
  ok('first connection still works after the second leaves',
    (await session.run({ connectionId: cfg.id, sql: 'select 1' }, cfg.name)).rows[0]?.[0] === '1')

  console.log('close')
  await session.disconnect(cfg.id)
  ok('last disconnect closes the tunnel', session.tunnelStatus().length === 0)
  await session.shutdown()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error(e)
  await session.shutdown().catch(() => undefined)
  process.exit(1)
})
