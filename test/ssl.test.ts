import type { ConnectionConfig } from '@shared/ipc'
import { buildSslOptions, needsAddressDial, resolveSslMode, splitPem, verificationName } from '../src/main/drivers/ssl.ts'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, extra = ''): void => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? '\n       ' + extra : ''}`) }
}

const cfg = (o: Partial<ConnectionConfig>): ConnectionConfig =>
  ({ id: 'x', name: 'x', engine: 'postgres', host: 'db.example.com', ...o })

const CERT = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----'
const bundle = (n: number): string => Array.from({ length: n }, () => CERT).join('\n')
const roots = ['ROOT-A', 'ROOT-B']
const reader = (n = 2) => (): string => bundle(n)
const explodes = (): string => { throw new Error('ENOENT: no such file') }

console.log('mode resolution (legacy compatibility)')
{
  ok('no flags at all is disable', resolveSslMode(cfg({})) === 'disable')
  ok('legacy ssl:false is disable', resolveSslMode(cfg({ ssl: false })) === 'disable')
  ok('legacy ssl:true is require, NOT verify-full', resolveSslMode(cfg({ ssl: true })) === 'require')
  ok('sslMode wins over the legacy flag', resolveSslMode(cfg({ ssl: true, sslMode: 'verify-full' })) === 'verify-full')
  ok('sslMode:disable beats ssl:true', resolveSslMode(cfg({ ssl: true, sslMode: 'disable' })) === 'disable')
}

console.log('verification name')
{
  ok('defaults to the host', verificationName(cfg({})) === 'db.example.com')
  ok('override wins', verificationName(cfg({ sslServerName: 'real.rds.amazonaws.com' })) === 'real.rds.amazonaws.com')
  ok('blank override falls back to host', verificationName(cfg({ sslServerName: '   ' })) === 'db.example.com')
  ok('no host and no override is undefined', verificationName(cfg({ host: '' })) === undefined)
}

console.log('disable')
{
  const r = buildSslOptions(cfg({ sslMode: 'disable' }), reader(), roots)
  ok('no ssl options at all', r.ssl === undefined)
  ok('no warning', r.warning === undefined)
}

console.log('require')
{
  const r = buildSslOptions(cfg({ sslMode: 'require' }), reader(), roots)
  ok('does not verify', r.ssl?.rejectUnauthorized === false)
  ok('carries no CA', r.ssl?.ca === undefined)
  ok('still sets servername for SNI', r.ssl?.servername === 'db.example.com')
}

console.log('verify-full')
{
  const r = buildSslOptions(cfg({ sslMode: 'verify-full' }), reader(3), roots)
  ok('verifies', r.ssl?.rejectUnauthorized === true)
  ok('trusts Node defaults AND the RDS bundle', r.ssl?.ca?.length === 5, `got ${r.ssl?.ca?.length}`)
  ok('default roots come through', r.ssl?.ca?.[0] === 'ROOT-A')
  ok('no warning on the happy path', r.warning === undefined)
}

console.log('verify-full through a tunnel')
{
  const r = buildSslOptions(
    cfg({ host: 'localhost', sslMode: 'verify-full', sslServerName: 'trueage-prod.proxy-x.us-east-2.rds.amazonaws.com' }),
    reader(), roots
  )
  ok('checks the real endpoint, not localhost',
    r.ssl?.servername === 'trueage-prod.proxy-x.us-east-2.rds.amazonaws.com', r.ssl?.servername)
  ok('still verifying', r.ssl?.rejectUnauthorized === true)
}

console.log('verify-full when the bundle is unreadable')
{
  const r = buildSslOptions(cfg({ sslMode: 'verify-full' }), explodes, roots)
  ok('does not throw', r.ssl !== undefined)
  ok('degrades to unverified rather than failing shut', r.ssl?.rejectUnauthorized === false)
  ok('says so', (r.warning ?? '').includes('UNVERIFIED'), r.warning)
}

console.log('verify-full when the bundle is empty')
{
  const r = buildSslOptions(cfg({ sslMode: 'verify-full' }), () => 'not a pem', roots)
  ok('warns rather than trusting an empty CA list', (r.warning ?? '').includes('no certificates'), r.warning)
  ok('and does not claim verification', r.ssl?.rejectUnauthorized === false)
}

console.log('dial by address (pg overwrites servername when the host is a name)')
{
  const rds = 'trueage-prod.proxy-x.us-east-2.rds.amazonaws.com'
  ok('tunnel by name with an override dials the address',
    needsAddressDial(cfg({ host: 'localhost', sslMode: 'verify-full', sslServerName: rds })))
  ok('require mode with an override also dials the address',
    needsAddressDial(cfg({ host: 'localhost', sslMode: 'require', sslServerName: rds })))
  ok('an IP literal is left alone; pg keeps servername for those',
    !needsAddressDial(cfg({ host: '127.0.0.1', sslMode: 'verify-full', sslServerName: rds })))
  ok('no override means nothing to protect', !needsAddressDial(cfg({ host: 'localhost', sslMode: 'verify-full' })))
  ok('override equal to the host is a no-op',
    !needsAddressDial(cfg({ host: rds, sslMode: 'verify-full', sslServerName: rds })))
  ok('blank override falls back to host and needs no dial',
    !needsAddressDial(cfg({ host: 'localhost', sslMode: 'verify-full', sslServerName: '  ' })))
  ok('plaintext never dials by address', !needsAddressDial(cfg({ host: 'localhost', sslMode: 'disable', sslServerName: rds })))
}

console.log('splitPem')
{
  ok('counts certificates', splitPem(bundle(4)).length === 4)
  ok('empty input yields none', splitPem('').length === 0)
  ok('keeps the full PEM block', splitPem(bundle(1))[0].startsWith('-----BEGIN CERTIFICATE-----'))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
