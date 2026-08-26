// Drives the running app over CDP so UI behaviour can be verified end to end.
const targets = await (await fetch('http://localhost:9222/json', { signal: AbortSignal.timeout(5000) })).json()
const page = targets.find((t) => t.type === 'page')
if (!page) { console.log('no page target:', targets.map(t=>t.type)); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })

ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
await Promise.race([
  new Promise((r) => ws.addEventListener('open', r)),
  new Promise((_r, rej) => setTimeout(() => rej(new Error('ws open timeout')), 5000))
])

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  const ex = r.result?.exceptionDetails
  if (ex) {
    const desc = ex.exception?.description ?? ex.exception?.value ?? ex.text
    return { error: String(desc).split('\n').slice(0, 3).join(' | ') }
  }
  return r.result?.result?.value
}

const arg = process.argv[2] ?? '[]'
// "@path" reads steps from a file, which avoids shell-quoting SQL.
// "shot:<path>" captures the window instead of evaluating steps.
if (arg.startsWith('shot:')) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const data = r.result?.data
  if (!data) { console.log('no screenshot'); process.exit(1) }
  const fs = await import('node:fs/promises')
  await fs.writeFile(arg.slice(5), Buffer.from(data, 'base64'))
  console.log('saved', arg.slice(5))
  ws.close()
  process.exit(0)
}

const steps = arg.startsWith('@')
  ? JSON.parse(await (await import('node:fs/promises')).readFile(arg.slice(1), 'utf8'))
  : JSON.parse(arg)
for (const [label, exprOrMethod, params] of steps) {
  // A step is either JS to evaluate, or a raw CDP call when params are given.
  if (params !== undefined) {
    await send(exprOrMethod, params)
    console.log(`── ${label}\n   (cdp ${exprOrMethod})`)
    continue
  }
  const v = await evaluate(exprOrMethod)
  console.log(`── ${label}\n   ${typeof v === 'string' ? v : JSON.stringify(v)}`)
}
ws.close()
process.exit(0)
