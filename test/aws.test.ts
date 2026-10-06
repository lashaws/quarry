import type { PasswordSource } from '@shared/ipc'
import {
  AwsCliError, awsEnv, fetchSecretPassword, isAuthFailure, isSsoExpired, ssoLogin, withRotatedSecret,
  type AwsExec
} from '../src/main/aws/cli.ts'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, extra = ''): void => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? '\n       ' + extra : ''}`) }
}

const SECRET = 'hunter2-Zq9!'
const src = (o: Partial<PasswordSource> = {}): PasswordSource =>
  ({ kind: 'aws-secret', profile: 'p', region: 'us-east-2', secretId: 'trueage/test/db-admin', ...o })

/** A stand-in for the CLI that records its argv and answers with `stdout` or a failure. */
function stub(result: { stdout?: string; err?: { code?: unknown; stderr?: string } }): { exec: AwsExec; calls: string[][] } {
  const calls: string[][] = []
  const exec: AwsExec = async (args) => {
    calls.push(args)
    if (result.err) throw Object.assign(new Error('Command failed'), result.err)
    return { stdout: result.stdout ?? '', stderr: '' }
  }
  return { exec, calls }
}

const rejection = async (p: Promise<unknown>): Promise<AwsCliError> => {
  try { await p } catch (e) { return e as AwsCliError }
  throw new Error('expected a rejection')
}

async function main(): Promise<void> {
  console.log('secret fetch')
  {
    const s = stub({ stdout: JSON.stringify({ username: 'u', password: SECRET }) + '\n' })
    ok('returns the default "password" key', (await fetchSecretPassword(src(), s.exec)) === SECRET)
    ok('argv is an array with profile, region and secret id',
      s.calls[0].join(' ') ===
        'secretsmanager get-secret-value --profile p --region us-east-2 --secret-id trueage/test/db-admin --query SecretString --output text')
  }
  {
    const s = stub({ stdout: JSON.stringify({ password: 'a', pw: SECRET }) })
    ok('jsonKey picks another field', (await fetchSecretPassword(src({ jsonKey: 'pw' }), s.exec)) === SECRET)
    ok('blank jsonKey falls back to password', (await fetchSecretPassword(src({ jsonKey: '  ' }), s.exec)) === 'a')
  }
  {
    const e = await rejection(fetchSecretPassword(src({ jsonKey: 'missing' }), stub({ stdout: JSON.stringify({ password: SECRET }) }).exec))
    ok('a missing key names the key', e.message.includes('"missing"'))
    ok('...and leaks no value', !e.message.includes(SECRET), e.message)
  }
  {
    const e = await rejection(fetchSecretPassword(src(), stub({ stdout: SECRET }).exec))
    ok('a non-JSON secret is refused', e.kind === 'failed' && e.message.includes('not a JSON document'))
    ok('...without echoing it', !e.message.includes(SECRET), e.message)
  }
  {
    const e = await rejection(fetchSecretPassword(src(), stub({ stdout: '"' + SECRET + '"' }).exec))
    ok('a JSON string (not an object) has no key', !e.message.includes(SECRET) && e.message.includes('no "password" entry'))
  }
  {
    const e = await rejection(fetchSecretPassword(src(), stub({ stdout: JSON.stringify({ password: '' }) }).exec))
    ok('an empty password is refused', e.message.includes('no "password" entry'))
  }

  console.log('SSO detection')
  for (const text of [
    'The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login with the corresponding profile.',
    'Token has expired and refresh failed',
    'Error loading SSO Token: Token for https://x.awsapps.com/start does not exist',
    'Error when retrieving token from sso: Token has expired and refresh failed'
  ]) ok(`recognises: ${text.slice(0, 48)}…`, isSsoExpired(text))
  ok('ignores an access-denied error', !isSsoExpired('An error occurred (AccessDeniedException) when calling GetSecretValue'))
  ok('ignores a missing secret', !isSsoExpired('An error occurred (ResourceNotFoundException): Secrets Manager can\'t find the specified secret.'))
  {
    const e = await rejection(fetchSecretPassword(src(), stub({ err: { code: 255, stderr: 'Error loading SSO Token: Token for x does not exist' } }).exec))
    ok('expired SSO becomes kind sso with the profile', e.kind === 'sso' && e.profile === 'p')
  }
  {
    const e = await rejection(fetchSecretPassword(src(), stub({ err: { code: 254, stderr: 'An error occurred (AccessDeniedException) when calling GetSecretValue' } }).exec))
    ok('other failures carry the stderr tail', e.kind === 'failed' && e.message.includes('AccessDeniedException'))
    ok('...and name the step and profile', e.message.includes('trueage/test/db-admin') && e.message.includes('profile p'))
  }
  {
    const e = await rejection(fetchSecretPassword(src(), stub({ err: { code: 'ENOENT' } }).exec))
    ok('a missing aws binary says so', e.kind === 'no-cli' && e.message.includes('AWS CLI'))
  }

  console.log('sso login')
  {
    const s = stub({ stdout: '' })
    await ssoLogin('trueage-test-admin', s.exec)
    ok('runs aws sso login --profile', s.calls[0].join(' ') === 'sso login --profile trueage-test-admin')
    const e = await rejection(ssoLogin('p', stub({ err: { code: 1, stderr: 'boom' } }).exec))
    ok('a failed login reports the CLI output', e.message.includes('boom'))
  }

  console.log('rotation retry')
  {
    const authErr = Object.assign(new Error('password authentication failed for user "u"'), { code: '28P01' })
    ok('28P01 is an auth failure', isAuthFailure(authErr))
    ok('a refused connection is not', !isAuthFailure(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })))

    const tried: string[] = []
    const s = stub({ stdout: JSON.stringify({ password: 'new' }) })
    const r = await withRotatedSecret(src(), 'old', async (pw) => {
      tried.push(pw)
      if (pw === 'old') throw authErr
      return 'connected'
    }, s.exec)
    ok('retries once with the re-read secret', r === 'connected' && tried.join() === 'old,new' && s.calls.length === 1)

    const same = stub({ stdout: JSON.stringify({ password: 'old' }) })
    let attempts = 0
    const e = await rejection(withRotatedSecret(src(), 'old', async () => { attempts++; throw authErr }, same.exec))
    ok('an unchanged secret is a real failure, not retried', e === authErr && attempts === 1)

    let n = 0
    const other = stub({ stdout: JSON.stringify({ password: 'new' }) })
    await rejection(withRotatedSecret(src(), 'old', async () => { n++; throw new Error('ECONNREFUSED') }, other.exec))
    ok('non-auth errors are never retried or re-read', n === 1 && other.calls.length === 0)

    let m = 0
    const twice = stub({ stdout: JSON.stringify({ password: 'newer' }) })
    await rejection(withRotatedSecret(src(), 'old', async () => { m++; throw authErr }, twice.exec))
    ok('only one retry', m === 2 && twice.calls.length === 1)
  }

  console.log('environment')
  {
    const env = awsEnv({ PATH: '/usr/bin:/bin', HOME: '/h' })
    ok('adds Homebrew and the plugin dir to a bare PATH', env['PATH']!.includes('/opt/homebrew/bin') && env['PATH']!.includes('sessionmanagerplugin'))
    ok('keeps the existing PATH first', env['PATH']!.startsWith('/usr/bin:/bin'))
    ok('does not duplicate entries', awsEnv({ PATH: '/opt/homebrew/bin' })['PATH']!.split(':').filter((d) => d === '/opt/homebrew/bin').length === 1)
    ok('disables the pager', env['AWS_PAGER'] === '')
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
