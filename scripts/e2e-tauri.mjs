// End-to-end drive of the TAURI build over the Chrome DevTools Protocol
// (WebView2 honours --remote-debugging-port via env).
// Usage: node scripts/e2e-tauri.mjs <outputDirForSignedPdfs> <screenshotDir>
import { spawn } from 'node:child_process'
import { mkdir, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const OUT_DIR = path.resolve(process.argv[2] ?? 'e2e-out-tauri')
const SHOT_DIR = path.resolve(process.argv[3] ?? 'e2e-shots')
const PORT = 9333
const EXE = path.resolve('src-tauri/target/release/signer.exe')

await mkdir(OUT_DIR, { recursive: true })
await mkdir(SHOT_DIR, { recursive: true })

const samples = (await readdir('samples')).filter((f) => f.endsWith('.pdf')).map((f) => path.resolve('samples', f))
console.log('launching tauri exe with', samples.length, 'sample PDFs')

const child = spawn(EXE, samples, {
  stdio: 'ignore',
  env: {
    ...process.env,
    SIGNER_OUTPUT_DIR: OUT_DIR,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
  },
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getPageWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
      if (page) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(500)
  }
  throw new Error('DevTools endpoint never appeared')
}

const ws = new WebSocket(await getPageWs())
await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)))
let msgId = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(JSON.stringify(msg.error)))
    else resolve(msg.result)
  }
}
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    pending.set(++msgId, { resolve, reject })
    ws.send(JSON.stringify({ id: msgId, method, params }))
  })
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error('page threw: ' + JSON.stringify(r.exceptionDetails).slice(0, 600))
  return r.result.value
}
async function screenshot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(path.join(SHOT_DIR, name), Buffer.from(r.data, 'base64'))
  console.log('shot:', name)
}
async function waitFor(expr, label, timeoutMs = 30000) {
  const start = Date.now()
  for (;;) {
    const v = await evaluate(expr)
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`)
    await sleep(400)
  }
}

try {
  await send('Page.enable')
  await send('Runtime.enable')

  await waitFor(`!!window.__signerStore`, 'store')
  const docCount = await waitFor(
    `(() => { const n = window.__signerStore.getState().docs.length; return n >= ${samples.length} ? n : 0 })()`,
    'documents loaded',
  )
  console.log('docs loaded:', docCount)
  await sleep(800)
  await screenshot('t01-loaded.png')

  await evaluate(`(() => {
    const c = document.createElement('canvas'); c.width = 600; c.height = 200
    const ctx = c.getContext('2d')
    ctx.strokeStyle = '#26357c'; ctx.lineWidth = 6; ctx.lineCap = 'round'
    ctx.beginPath(); ctx.moveTo(40, 140)
    ctx.bezierCurveTo(120, 20, 180, 185, 260, 85)
    ctx.bezierCurveTo(330, 10, 380, 165, 560, 55)
    ctx.stroke()
    window.__signerStore.getState().addSignature({ name: 'Tauri ink', dataUrl: c.toDataURL('image/png'), width: 600, height: 200 })
    return true
  })()`)

  await evaluate(`(window.__signerStore.getState().setMode('smart'), true)`)
  await waitFor(
    `(() => { const s = window.__signerStore.getState(); return !s.detecting && s.docs.every(d => d.smart !== undefined || d.status === 'error') })()`,
    'smart detection',
    60000,
  )
  await sleep(600)
  await screenshot('t02-smart.png')

  await evaluate(`window.__signerStore.getState().signAll()`)
  const result = await waitFor(
    `(() => { const r = window.__signerStore.getState().result; return r ? JSON.stringify(r) : 0 })()`,
    'signing finished',
    60000,
  )
  console.log('sign result:', result)
  await sleep(400)
  await screenshot('t03-signed.png')

  console.log('output files:', (await readdir(OUT_DIR)).join(', '))
} finally {
  ws.close()
  child.kill()
}
console.log('TAURI E2E DONE')
