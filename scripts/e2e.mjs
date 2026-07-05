// End-to-end drive of the built app over the Chrome DevTools Protocol.
// Usage: node scripts/e2e.mjs <outputDirForSignedPdfs> <screenshotDir>
import { spawn } from 'node:child_process'
import { mkdir, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import electronPath from 'electron'

const OUT_DIR = path.resolve(process.argv[2] ?? 'e2e-out')
const SHOT_DIR = path.resolve(process.argv[3] ?? 'e2e-shots')
const PORT = 9223

await mkdir(OUT_DIR, { recursive: true })
await mkdir(SHOT_DIR, { recursive: true })

const samples = (await readdir('samples')).filter((f) => f.endsWith('.pdf')).map((f) => path.resolve('samples', f))
console.log('launching with', samples.length, 'sample PDFs')

const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, ...samples], {
  stdio: 'ignore',
  env: { ...process.env, SIGNER_OUTPUT_DIR: OUT_DIR, VITE_DEV_SERVER_URL: '' },
})

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function getPageWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'))
      if (page) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(500)
  }
  throw new Error('DevTools endpoint never appeared')
}

const wsUrl = await getPageWs()
const ws = new WebSocket(wsUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})

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
function send(method, params = {}) {
  const id = ++msgId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (r.exceptionDetails) throw new Error('page threw: ' + JSON.stringify(r.exceptionDetails).slice(0, 600))
  return r.result.value
}

async function screenshot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const file = path.join(SHOT_DIR, name)
  await writeFile(file, Buffer.from(r.data, 'base64'))
  console.log('shot:', file)
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

  // 1. app booted, CLI files ingested
  await waitFor(`!!window.__signerStore`, 'store')
  const docCount = await waitFor(
    `(() => { const n = window.__signerStore.getState().docs.length; return n >= ${samples.length} ? n : 0 })()`,
    'documents loaded',
  )
  console.log('docs loaded:', docCount)
  await sleep(800) // let the first preview render
  await screenshot('01-loaded.png')

  // 2. create a signature programmatically (a drawn-looking bezier)
  await evaluate(`(() => {
    const c = document.createElement('canvas'); c.width = 600; c.height = 200
    const ctx = c.getContext('2d')
    ctx.strokeStyle = '#26357c'; ctx.lineWidth = 6; ctx.lineCap = 'round'
    ctx.beginPath(); ctx.moveTo(40, 140)
    ctx.bezierCurveTo(120, 20, 180, 185, 260, 85)
    ctx.bezierCurveTo(330, 10, 380, 165, 560, 55)
    ctx.stroke()
    window.__signerStore.getState().addSignature({ name: 'E2E ink', dataUrl: c.toDataURL('image/png'), width: 600, height: 200 })
    return true
  })()`)
  await sleep(600)
  await screenshot('02-signature-placed.png')

  // 3. smart mode: wait for detection over all docs
  await evaluate(`(window.__signerStore.getState().setMode('smart'), true)`)
  await waitFor(
    `(() => { const s = window.__signerStore.getState(); return !s.detecting && s.docs.every(d => d.smart !== undefined || d.status === 'error') })()`,
    'smart detection',
    60000,
  )
  const smartSummary = await evaluate(
    `window.__signerStore.getState().docs.map(d => ({ name: d.name, page: d.smart ? d.smart.pageIndex : null, found: !!d.smart }))`,
  )
  console.log('smart detection:', JSON.stringify(smartSummary, null, 1))
  await sleep(600)
  await screenshot('03-smart-mode.png')

  // 4. sign everything (SIGNER_OUTPUT_DIR bypasses the folder dialog)
  await evaluate(`window.__signerStore.getState().signAll()`)
  const result = await waitFor(
    `(() => { const r = window.__signerStore.getState().result; return r ? JSON.stringify(r) : 0 })()`,
    'signing finished',
    60000,
  )
  console.log('sign result:', result)
  await sleep(400)
  await screenshot('04-signed.png')

  const written = await readdir(OUT_DIR)
  console.log('output files:', written.join(', '))
} finally {
  ws.close()
  child.kill()
}
console.log('E2E DONE')
