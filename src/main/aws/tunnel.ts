/**
 * Owns every `aws ssm start-session` port-forward Quarry opens.
 *
 * One tunnel per (profile, target, remoteHost, remotePort), shared by every
 * connection and tab that asks for it and reference-counted: the last release
 * kills it, and so does quitting the app. A tunnel nobody holds must not outlive
 * the app, so the child runs in its own process group (the `aws` CLI forks the
 * session-manager-plugin, and signalling only the CLI leaves the plugin behind).
 *
 * Process, port and clock access are injected (TunnelDeps) so test/tunnel.test.ts
 * runs the whole lifecycle against a stub spawn.
 */
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as net from 'node:net'
import type { SsmTunnel, TunnelStatus } from '@shared/ipc'
import { AwsCliError, awsEnv, isSsoExpired, tail } from './cli'

/** Emits 'output' (string), 'exit' (code, signal) and 'error' (Error). */
export interface TunnelProcess extends EventEmitter {
  kill(signal: NodeJS.Signals): void
}

export interface TunnelDeps {
  spawn(args: string[]): TunnelProcess
  isListening(port: number): Promise<boolean>
  freePort(): Promise<number>
  readyTimeoutMs: number
  pollMs: number
  /** SIGTERM to SIGKILL grace when closing */
  killGraceMs: number
}

export interface TunnelLease {
  readonly port: number
  /** False once the process behind it has exited on its own (an SSM idle timeout, say). */
  readonly alive: boolean
  release(): Promise<void>
}

interface Entry {
  key: string
  label: string
  state: 'opening' | 'open'
  port: number | null
  proc: TunnelProcess | null
  exited: Promise<void>
  users: number
  dead: boolean
  ready: Promise<number>
}

export const tunnelKey = (t: SsmTunnel): string => [t.profile, t.target, t.remoteHost, t.remotePort].join('|')

export function ssmArgs(t: SsmTunnel, localPort: number): string[] {
  return [
    'ssm', 'start-session',
    '--profile', t.profile, '--region', t.region, '--target', t.target,
    '--document-name', 'AWS-StartPortForwardingSessionToRemoteHost',
    '--parameters',
    JSON.stringify({
      host: [t.remoteHost],
      portNumber: [String(t.remotePort)],
      localPortNumber: [String(localPort)]
    })
  ]
}

export function defaultTunnelDeps(): TunnelDeps {
  return {
    spawn(args) {
      const child = spawn('aws', args, { env: awsEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
      const proc: TunnelProcess = Object.assign(new EventEmitter(), {
        kill(signal: NodeJS.Signals) {
          try {
            // Negative pid: the whole group, so the plugin goes with the CLI.
            if (child.pid !== undefined) process.kill(-child.pid, signal)
          } catch {
            /* already gone */
          }
        }
      })
      for (const s of [child.stdout, child.stderr]) s?.on('data', (b: Buffer) => proc.emit('output', b.toString('utf8')))
      child.on('exit', (code, signal) => proc.emit('exit', code, signal))
      child.on('error', (err) => proc.emit('error', err))
      return proc
    },
    isListening: (port) =>
      new Promise((resolve) => {
        const s = net.connect({ host: '127.0.0.1', port })
        s.setTimeout(750)
        s.once('connect', () => (s.destroy(), resolve(true)))
        s.once('timeout', () => (s.destroy(), resolve(false)))
        s.once('error', () => (s.destroy(), resolve(false)))
      }),
    freePort: () =>
      new Promise((resolve, reject) => {
        const srv = net.createServer()
        srv.once('error', reject)
        srv.listen(0, '127.0.0.1', () => {
          const { port } = srv.address() as net.AddressInfo
          srv.close(() => resolve(port))
        })
      }),
    readyTimeoutMs: 30_000,
    pollMs: 250,
    killGraceMs: 3_000
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class TunnelManager {
  private entries = new Map<string, Entry>()

  /** Pushed whenever a tunnel opens, closes or changes how many connections use it. */
  onChange?: (tunnels: TunnelStatus[]) => void

  constructor(private deps: TunnelDeps = defaultTunnelDeps()) {}

  list(): TunnelStatus[] {
    return [...this.entries.values()].map((e) => ({
      key: e.key, label: e.label, state: e.state, localPort: e.port, users: e.users
    }))
  }

  private changed(): void {
    this.onChange?.(this.list())
  }

  /**
   * A lease on the tunnel for `spec`, opening it if nothing is listening yet.
   * When `localPort` is already accepting connections (the developer's own
   * script left a forward running) that listener is used and never killed.
   */
  async acquire(spec: SsmTunnel): Promise<TunnelLease> {
    const key = tunnelKey(spec)
    let e = this.entries.get(key)
    if (!e) {
      e = this.open(spec, key)
      this.entries.set(key, e)
    }
    const entry = e
    entry.users++
    this.changed()

    let port: number
    try {
      port = await entry.ready
    } catch (err) {
      entry.users--
      throw err
    }
    let released = false
    return {
      port,
      get alive() { return !entry.dead },
      release: async () => {
        if (released) return
        released = true
        entry.users--
        if (entry.users <= 0) await this.close(entry)
        else this.changed()
      }
    }
  }

  private open(spec: SsmTunnel, key: string): Entry {
    const entry: Entry = {
      key, label: `${spec.profile} → ${spec.target}`, state: 'opening', port: null,
      proc: null, exited: Promise.resolve(), users: 0, dead: false, ready: Promise.resolve(0)
    }
    entry.ready = this.start(entry, spec).catch(async (err) => {
      await this.close(entry)
      throw err
    })
    return entry
  }

  private async start(entry: Entry, spec: SsmTunnel): Promise<number> {
    if (spec.localPort !== undefined && (await this.deps.isListening(spec.localPort))) {
      entry.port = spec.localPort
      entry.state = 'open'
      this.changed()
      return spec.localPort
    }

    const port = spec.localPort ?? (await this.deps.freePort())
    entry.port = port
    this.changed()

    const proc = this.deps.spawn(ssmArgs(spec, port))
    entry.proc = proc
    let output = ''
    // An object, not a bare let: the handlers below assign it behind the loop's back.
    const run: { died: Error | null } = { died: null }
    let gone!: () => void
    entry.exited = new Promise<void>((resolve) => { gone = resolve })
    const ended = (err: Error): void => {
      run.died ??= err
      entry.dead = true
      // After it was open, an exit means the forward dropped; forget it so the
      // next acquire dials a fresh one instead of handing out a dead port.
      if (entry.state === 'open' && this.entries.get(entry.key) === entry) {
        this.entries.delete(entry.key)
        this.changed()
      }
      gone()
    }
    proc.on('output', (s: string) => { output = (output + s).slice(-4000) })
    // Spawn failures (no `aws` on PATH) emit 'error' and never 'exit'.
    proc.on('error', (err: Error) => ended(err))
    proc.on('exit', (code: number | null, signal: string | null) =>
      ended(new Error(`exited with ${signal ?? `code ${String(code)}`}`))
    )

    const deadline = Date.now() + this.deps.readyTimeoutMs
    for (;;) {
      if (run.died) throw this.failure(spec, run.died, output)
      if (await this.deps.isListening(port)) break
      if (Date.now() >= deadline) {
        throw this.failure(spec, `nothing was listening on 127.0.0.1:${port} after ${Math.round(this.deps.readyTimeoutMs / 1000)} s`, output)
      }
      await sleep(this.deps.pollMs)
    }
    entry.state = 'open'
    this.changed()
    return port
  }

  private failure(spec: SsmTunnel, cause: Error | string, output: string): AwsCliError {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return new AwsCliError(
        'The AWS CLI (`aws`) was not found. Install AWS CLI v2 (brew install awscli) and the session-manager-plugin.',
        'no-cli'
      )
    }
    const why = typeof cause === 'string' ? cause : `the AWS CLI ${cause.message}`
    if (isSsoExpired(output)) {
      return new AwsCliError(`The AWS SSO session for profile ${spec.profile} is missing or has expired.`, 'sso', spec.profile)
    }
    const t = tail(output)
    return new AwsCliError(
      `Could not open the SSM tunnel to ${spec.target} (profile ${spec.profile}): ${why}.${t ? `\n${t}` : ''}`,
      'failed', spec.profile
    )
  }

  /** Signals now, resolves once the process is gone. SIGKILL follows if SIGTERM is ignored. */
  private async close(entry: Entry): Promise<void> {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
    this.changed()
    const proc = entry.proc
    if (!proc || entry.dead) return
    proc.kill('SIGTERM')
    const hardKill = setTimeout(() => proc.kill('SIGKILL'), this.deps.killGraceMs)
    await entry.exited
    clearTimeout(hardKill)
  }

  /** Quit path: every tunnel goes, whoever still holds a lease. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map((e) => this.close(e)))
  }
}
