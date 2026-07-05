// Regression: the no-save Print button builds stamped PDFs into temp files.
import { spawn } from 'node:child_process'
import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import electronPath from 'electron'

const PORT = 9238
const PRINT_DIR = path.join(os.tmpdir(), 'signer-print')
await rm(PRINT_DIR, { recursive: true, force: true })

const samples = ['samples/Leave_Request_Amara_Perera.pdf', 'samples/Reference_Letter.pdf'].map((f) => path.resolve(f))
const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, ...samples], {
  stdio: 'ignore',
  env: { ...process.env, SIGNER_PRINT_DRYRUN: '1', VITE_DEV_SERVER_URL: '' },
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let wsUrl
for (let i = 0; i < 60 && !wsUrl; i++) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    wsUrl = targets.find((t) => t.type === 'page' && t.url.includes('index.html'))?.webSocketDebuggerUrl
  } catch {}
  if (!wsUrl) await sleep(500)
}
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
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 700))
  return r.result?.result?.value
}
const waitFor = async (expr, label, ms = 30000) => {
  const start = Date.now()
  for (;;) {
    if (await evaluate(expr)) return
    if (Date.now() - start > ms) throw new Error('timeout: ' + label)
    await sleep(300)
  }
}

await send('Page.enable')
await waitFor(`!!window.__signerStore`, 'store')
await waitFor(`window.__signerStore.getState().docs.length >= 2`, 'docs')
// a signature so stamps are applied
await evaluate(`(() => {
  const c = document.createElement('canvas'); c.width = 600; c.height = 200
  const ctx = c.getContext('2d'); ctx.strokeStyle = '#26357c'; ctx.lineWidth = 6
  ctx.beginPath(); ctx.moveTo(40, 140); ctx.bezierCurveTo(200, 20, 400, 180, 560, 60); ctx.stroke()
  window.__signerStore.getState().addSignature({ name: 'Print test', dataUrl: c.toDataURL('image/png'), width: 600, height: 200 })
  return true
})()`)
await sleep(300)
await evaluate(`window.__signerStore.getState().printAll()`)
await waitFor(`!window.__signerStore.getState().signing`, 'print build finished')
await sleep(400)

const files = await readdir(PRINT_DIR).catch(() => [])
console.log('temp print files:', JSON.stringify(files))
if (files.length !== 2) {
  console.error('FAIL: expected 2 temp print files, got', files.length)
  process.exitCode = 1
}
const statuses = await evaluate(`window.__signerStore.getState().docs.map(d => d.status)`)
if (JSON.stringify(statuses) !== JSON.stringify(['ready', 'ready'])) {
  console.error('FAIL: printing must not change document statuses:', statuses)
  process.exitCode = 1
}
ws.close()
child.kill()
console.log(process.exitCode ? 'PRINT DRYRUN FAILED' : 'PRINT DRYRUN PASSED')
