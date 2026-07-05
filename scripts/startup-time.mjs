// Measure cold start: process spawn -> CDP target -> app store ready.
import { spawn } from 'node:child_process'
import electronPath from 'electron'

const PORT = 9253
const t0 = Date.now()
const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], {
  stdio: 'ignore',
  env: { ...process.env, VITE_DEV_SERVER_URL: '' },
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let wsUrl
for (let i = 0; i < 120 && !wsUrl; i++) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    wsUrl = targets.find((t) => t.type === 'page' && t.url.includes('index.html'))?.webSocketDebuggerUrl
  } catch {}
  if (!wsUrl) await sleep(100)
}
const tTarget = Date.now()
const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)))
let id = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
}
const send = (method, params = {}) =>
  new Promise((res) => {
    pending.set(++id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  return r.result?.result?.value
}
for (let i = 0; i < 300; i++) {
  if (await evaluate(`!!window.__signerStore && document.querySelector('.topbar') !== null`)) break
  await sleep(50)
}
const tReady = Date.now()
const mem = await evaluate(`(performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1)`)
console.log(`page target up: ${tTarget - t0} ms`)
console.log(`app interactive: ${tReady - t0} ms`)
console.log(`JS heap at idle: ${mem} MB`)
child.kill()
