/**
 * Everything Quarry asks of AWS goes through the `aws` CLI, never an SDK: the app
 * has no native or heavyweight dependencies, and the CLI already knows the
 * developer's SSO profiles, token cache and region config.
 *
 * Arguments are always passed as an array to execFile, never joined into a shell
 * string, so a profile or secret id cannot inject anything.
 *
 * The `exec` seam exists so test/aws.test.ts can drive every branch without AWS.
 */
import { execFile } from 'node:child_process'
import type { PasswordSource } from '@shared/ipc'

export type AwsExec = (args: string[], timeoutMs: number) => Promise<{ stdout: string; stderr: string }>

/**
 * sso    - the SSO session is missing or expired; `aws sso login` fixes it
 * no-cli - `aws` is not installed or not on PATH
 * failed - anything else; the message carries the CLI's stderr tail
 */
export type AwsErrorKind = 'sso' | 'no-cli' | 'failed'

export class AwsCliError extends Error {
  constructor(message: string, readonly kind: AwsErrorKind, readonly profile?: string) {
    super(message)
    this.name = 'AwsCliError'
  }
}

/**
 * A Finder-launched app inherits launchd's PATH, which has neither Homebrew's
 * `aws` nor the session-manager-plugin it shells out to. AWS_PAGER is cleared so
 * the CLI can never block on a pager with no terminal.
 */
export function awsEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/local/sessionmanagerplugin/bin']
  const have = (base['PATH'] ?? '').split(':').filter(Boolean)
  const path = [...have, ...extra.filter((d) => !have.includes(d))].join(':')
  return { ...base, PATH: path, AWS_PAGER: '' }
}

const defaultExec: AwsExec = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile('aws', args, { env: awsEnv(), timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }))
      else resolve({ stdout, stderr })
    })
  })

const SSO_EXPIRED =
  /sso session|token has expired|sso login|error loading sso token|error when retrieving token from sso|refresh token.*(expired|invalid)/i

/** The CLI's own wording for a missing or expired SSO login. */
export function isSsoExpired(stderr: string): boolean {
  return SSO_EXPIRED.test(stderr)
}

/** The last few lines are the useful ones; the CLI prints its traceback first. */
export function tail(text: string, lines = 6): string {
  return text.trim().split('\n').slice(-lines).join('\n').trim()
}

/** Turns a failed CLI run into an AwsCliError. `what` names the step for the message. */
export function classifyFailure(err: unknown, what: string, profile: string): AwsCliError {
  const e = err as { code?: unknown; stderr?: unknown; message?: string }
  if (e.code === 'ENOENT') {
    return new AwsCliError(
      'The AWS CLI (`aws`) was not found. Install AWS CLI v2 (brew install awscli) and the session-manager-plugin.',
      'no-cli'
    )
  }
  const stderr = typeof e.stderr === 'string' ? e.stderr : ''
  if (isSsoExpired(stderr)) {
    return new AwsCliError(`The AWS SSO session for profile ${profile} is missing or has expired.`, 'sso', profile)
  }
  const detail = tail(stderr) || e.message || 'no output'
  return new AwsCliError(`${what} failed (profile ${profile}): ${detail}`, 'failed', profile)
}

/**
 * Reads one password out of Secrets Manager. The secret is a JSON document (RDS
 * rotation writes `{"username":…,"password":…}`) and `jsonKey` picks the field.
 *
 * Error text names the secret and the key, never a value: stdout is read only on
 * success, and the parse failures below deliberately do not echo what was parsed.
 */
export async function fetchSecretPassword(src: PasswordSource, exec: AwsExec = defaultExec): Promise<string> {
  const key = src.jsonKey?.trim() || 'password'
  let stdout: string
  try {
    ;({ stdout } = await exec(
      [
        'secretsmanager', 'get-secret-value',
        '--profile', src.profile, '--region', src.region,
        '--secret-id', src.secretId,
        '--query', 'SecretString', '--output', 'text'
      ],
      60_000
    ))
  } catch (err) {
    throw classifyFailure(err, `Reading secret ${src.secretId}`, src.profile)
  }

  let doc: unknown
  try {
    doc = JSON.parse(stdout.trim())
  } catch {
    throw new AwsCliError(`Secret ${src.secretId} is not a JSON document, so key "${key}" cannot be read.`, 'failed', src.profile)
  }
  const value = doc !== null && typeof doc === 'object' ? (doc as Record<string, unknown>)[key] : undefined
  if (typeof value !== 'string' || value === '') {
    throw new AwsCliError(`Secret ${src.secretId} has no "${key}" entry.`, 'failed', src.profile)
  }
  return value
}

/** Opens the browser for `aws sso login`; resolves once the developer has finished. */
export async function ssoLogin(profile: string, exec: AwsExec = defaultExec): Promise<void> {
  try {
    await exec(['sso', 'login', '--profile', profile], 5 * 60_000)
  } catch (err) {
    const e = err as { code?: unknown; stderr?: unknown }
    if (e.code === 'ENOENT') throw classifyFailure(err, 'aws sso login', profile)
    const detail = typeof e.stderr === 'string' ? tail(e.stderr) : ''
    throw new AwsCliError(`aws sso login failed for profile ${profile}${detail ? `: ${detail}` : ''}`, 'failed', profile)
  }
}

/** SQLSTATE 28P01 invalid_password, or 28000 when a proxy words it as a bad authorization. */
export function isAuthFailure(err: unknown): boolean {
  const code = (err as { code?: string }).code
  return code === '28P01' || code === '28000' || /password authentication failed/i.test((err as Error).message)
}

/**
 * Runs `attempt` with the secret already read. Right after a rotation that
 * value can be stale, so an authentication failure re-reads the secret once and
 * tries again; if it comes back unchanged the failure is real and is rethrown
 * as it came. Any other failure is never retried.
 */
export async function withRotatedSecret<T>(
  src: PasswordSource,
  password: string,
  attempt: (password: string) => Promise<T>,
  exec: AwsExec = defaultExec
): Promise<T> {
  try {
    return await attempt(password)
  } catch (err) {
    if (!isAuthFailure(err)) throw err
    const fresh = await fetchSecretPassword(src, exec)
    if (fresh === password) throw err
    return attempt(fresh)
  }
}
