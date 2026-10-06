import { EventEmitter } from 'node:events'
import type { SsmTunnel, TunnelStatus } from '@shared/ipc'
import { AwsCliError } from '../src/main/aws/cli.ts'
import { TunnelManager, ssmArgs, tunnelKey, type TunnelDeps, type TunnelProcess } from '../src/main/aws/tunnel.ts'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, extra = ''): void => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? '\n       ' + extra : ''}`) }
}

const spec = (o: Partial<SsmTunnel> = {}): SsmTunnel => ({
  profile: 'trueage-test-admin', region: 'us-east-2', target: 'i-0abc',
  remoteHost: 'db.example.rds.amazonaws.com', remotePort: 5432, ...o
})

class FakeProc extends EventEmitter implements TunnelProcess {
  signals: NodeJS.Signals[] = []
  /** SIGTERM is ignored when false, so only SIGKILL ends it. */
  obeysTerm = true
  kill(signal: NodeJS.Signals): void {
    this.signals.push(signal)
    if (signal === 'SIGKILL' || this.obeysTerm) setImmediate(() => this.emit('exit', null, signal))
  }
}

/** Ports in `listening` accept connections; `onSpawn` decides when a spawned forward starts to. */
function harness(over: Partial<TunnelDeps> = {}, onSpawn?: (p: FakeProc, port: number) => void) {
  const listening = new Set<number>()
  const procs: FakeProc[] = []
  const argvs: string[][] = []
  let next = 41000
  const deps: TunnelDeps = {
    spawn: (args) => {
      const p = new FakeProc()
      procs.push(p)
      argvs.push(args)
      const port = Number((JSON.parse(args[args.length - 1]) as { localPortNumber: string[] }).localPortNumber[0])
      if (onSpawn) onSpawn(p, port)
      else setTimeout(() => listening.add(port), 5)
      p.on('exit', () => listening.delete(port))
      return p
    },
    isListening: async (port) => listening.has(port),
    freePort: async () => next++,
    readyTimeoutMs: 400,
    pollMs: 2,
    killGraceMs: 30,
    ...over
  }
  const mgr = new TunnelManager(deps)
  const changes: TunnelStatus[][] = []
  mgr.onChange = (l) => changes.push(l)
  return { mgr, listening, procs, argvs, changes }
}

const rejection = async (p: Promise<unknown>): Promise<AwsCliError> => {
  try { await p } catch (e) { return e as AwsCliError }
  throw new Error('expected a rejection')
}

async function main(): Promise<void> {
  console.log('command line')
  {
    const a = ssmArgs(spec(), 41234)
    ok('uses the port-forward document', a.join(' ').includes('--document-name AWS-StartPortForwardingSessionToRemoteHost'))
    ok('passes profile, region and target as separate args',
      a.slice(0, 8).join(' ') === 'ssm start-session --profile trueage-test-admin --region us-east-2 --target i-0abc')
    const params = JSON.parse(a[a.length - 1]) as Record<string, string[]>
    ok('parameters are JSON with string ports',
      params['host'][0] === 'db.example.rds.amazonaws.com' && params['portNumber'][0] === '5432' && params['localPortNumber'][0] === '41234')
    ok('key ignores the local port and region',
      tunnelKey(spec({ localPort: 1 })) === tunnelKey(spec({ region: 'eu-west-1' })))
    ok('key differs by target', tunnelKey(spec()) !== tunnelKey(spec({ target: 'i-0def' })))
  }

  console.log('open and wait for the port')
  {
    const h = harness()
    const lease = await h.mgr.acquire(spec())
    ok('spawns exactly one forward', h.procs.length === 1)
    ok('chose a free port and waited until it accepted', lease.port === 41000 && h.listening.has(41000))
    ok('status reports it open with one user', h.mgr.list()[0].state === 'open' && h.mgr.list()[0].users === 1)
    ok('status passed through "opening" first', h.changes.some((l) => l[0]?.state === 'opening'))
    await lease.release()
    ok('released tunnel is gone', h.mgr.list().length === 0)
  }
  {
    const h = harness()
    const lease = await h.mgr.acquire(spec({ localPort: 15433 }))
    ok('honours a requested local port', lease.port === 15433 && h.argvs[0].join(' ').includes('"localPortNumber":["15433"]'))
    await lease.release()
  }

  console.log('reuse and reference counting')
  {
    const h = harness()
    const [a, b] = await Promise.all([h.mgr.acquire(spec()), h.mgr.acquire(spec())])
    ok('two concurrent connects share one process', h.procs.length === 1 && a.port === b.port)
    const c = await h.mgr.acquire(spec())
    ok('a later connect reuses it too', h.procs.length === 1 && h.mgr.list()[0].users === 3)
    await a.release()
    await a.release()
    ok('releasing twice counts once', h.mgr.list()[0].users === 2)
    await b.release()
    ok('still open while one connection uses it', h.procs[0].signals.length === 0)
    await c.release()
    ok('last release terminates the process', h.procs[0].signals.join() === 'SIGTERM')
    ok('...and the port is free again', h.listening.size === 0)
    const d = await h.mgr.acquire(spec())
    ok('the next connect opens a fresh one', h.procs.length === 2)
    await d.release()
  }
  {
    const h = harness()
    const a = await h.mgr.acquire(spec())
    const b = await h.mgr.acquire(spec({ target: 'i-0def' }))
    ok('a different target is a different tunnel', h.procs.length === 2 && a.port !== b.port)
    await Promise.all([a.release(), b.release()])
  }

  console.log('a forward that is already listening')
  {
    const h = harness()
    h.listening.add(15433)
    const lease = await h.mgr.acquire(spec({ localPort: 15433 }))
    ok('is used as is, with nothing spawned', h.procs.length === 0 && lease.port === 15433)
    await lease.release()
    ok('and left running on release', h.listening.has(15433))
  }

  console.log('failures')
  {
    const h = harness({}, (p) => setTimeout(() => {
      p.emit('output', 'The SSO session associated with this profile has expired.\n')
      p.emit('exit', 255, null)
    }, 5))
    const e = await rejection(h.mgr.acquire(spec()))
    ok('an expired SSO login is reported as such', e.kind === 'sso' && e.profile === 'trueage-test-admin')
    ok('and the failed tunnel is not kept', h.mgr.list().length === 0)
  }
  {
    const h = harness({}, (p) => setTimeout(() => {
      p.emit('output', 'An error occurred (TargetNotConnected) when calling the StartSession operation\n')
      p.emit('exit', 254, null)
    }, 5))
    const e = await rejection(h.mgr.acquire(spec()))
    ok('an early exit shows the CLI output tail', e.kind === 'failed' && e.message.includes('TargetNotConnected') && e.message.includes('code 254'))
  }
  {
    const h = harness({ readyTimeoutMs: 60 }, () => undefined)
    const e = await rejection(h.mgr.acquire(spec()))
    ok('a port that never opens times out and says which', e.message.includes('nothing was listening on 127.0.0.1:41000'))
    ok('the stuck process is killed, not orphaned', h.procs[0].signals.includes('SIGTERM'))
    ok('and nothing is left registered', h.mgr.list().length === 0)
  }
  {
    const h = harness({}, (p) => setTimeout(() => p.emit('error', Object.assign(new Error('spawn aws ENOENT'), { code: 'ENOENT' })), 5))
    const e = await rejection(h.mgr.acquire(spec()))
    ok('a missing aws binary says so', e.kind === 'no-cli')
  }
  {
    const h = harness({}, (p) => setTimeout(() => p.emit('exit', 1, null), 5))
    const [x, y] = await Promise.allSettled([h.mgr.acquire(spec()), h.mgr.acquire(spec())])
    ok('every waiter on a failed open is rejected', x.status === 'rejected' && y.status === 'rejected')
    ok('and the next try starts clean', h.mgr.list().length === 0)
  }

  console.log('dropped forward')
  {
    const h = harness()
    const lease = await h.mgr.acquire(spec())
    h.procs[0].emit('exit', 0, null)
    ok('the lease reports it is no longer alive', !lease.alive)
    ok('the dead tunnel is forgotten', h.mgr.list().length === 0)
    const again = await h.mgr.acquire(spec({ localPort: lease.port }))
    ok('the next acquire spawns a new one on the same port', h.procs.length === 2 && again.port === lease.port && again.alive)
    await lease.release()
    ok('releasing the dead lease does not touch the new tunnel', h.procs[1].signals.length === 0)
    await again.release()
  }

  console.log('cleanup')
  {
    const h = harness()
    await h.mgr.acquire(spec())
    await h.mgr.acquire(spec({ target: 'i-0def' }))
    await h.mgr.closeAll()
    ok('closeAll terminates every tunnel, leases or not', h.procs.every((p) => p.signals[0] === 'SIGTERM') && h.mgr.list().length === 0)
  }
  {
    const h = harness()
    const lease = await h.mgr.acquire(spec())
    h.procs[0].obeysTerm = false
    await lease.release()
    ok('a process that ignores SIGTERM gets SIGKILL', h.procs[0].signals.join() === 'SIGTERM,SIGKILL')
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
