// Regression: Android file naming.
//  A) saved files always get a clean, legal .pdf name even from an ugly source
//     name (a content-URI id like "document%3A1000048777"),
//  B) the pick net corrects an already-added doc to its real DISPLAY_NAME,
//  C) a net-delivered new pick is added under its real name.
// node scripts/android-names.mjs
import { spawn } from 'node:child_process'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import electronPath from 'electron'

const OUT_DIR = path.join(os.tmpdir(), 'signer-names-out')
const TMP = path.join(os.tmpdir(), 'signer-names')
const PORT = 9275
await rm(OUT_DIR, { recursive: true, force: true })
await mkdir(OUT_DIR, { recursive: true })
await mkdir(TMP, { recursive: true })
const src = path.resolve('samples', 'Leave_Request_Amara_Perera.pdf')
const realA = path.join(TMP, 'realA.pdf')
const realB = path.join(TMP, 'realB.pdf')
await copyFile(src, realA)
await copyFile(src, realB)
const esc = (p) => p.replace(/\\/g, '\\\\')

const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], {
  stdio: 'ignore',
  env: { ...process.env, SIGNER_OUTPUT_DIR: OUT_DIR, VITE_DEV_SERVER_URL: '' },
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
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 900))
  return r.result?.result?.value
}
const waitFor = async (expr, label, ms = 25000) => {
  const start = Date.now()
  for (;;) {
    if (await evaluate(expr)) return
    if (Date.now() - start > ms) throw new Error('timeout: ' + label)
    await sleep(300)
  }
}
const fail = (msg) => {
  console.error('FAIL:', msg)
  process.exitCode = 1
}
const S = `window.__signerStore.getState()`

try {
  await send('Page.enable')
  await waitFor(`!!window.__signerStore && !!window.__androidPickedFiles`, 'hooks')

  // A. an ugly source name saves as a clean, legal .pdf
  await evaluate(`(async () => {
    const bytes = new Uint8Array(await window.signer.readFile(${JSON.stringify(realA)}))
    await ${S}.addFiles([{ name: 'weird:name *?.pdf', bytes }])
    const c = document.createElement('canvas'); c.width = 300; c.height = 100
    const g = c.getContext('2d'); g.strokeStyle = '#26357c'; g.lineWidth = 6
    g.beginPath(); g.moveTo(10, 80); g.lineTo(280, 20); g.stroke()
    ${S}.addSignature({ name: 'S', dataUrl: c.toDataURL('image/png'), width: 300, height: 100 })
    return true
  })()`)
  await evaluate(`(${S}.setView('sign'), ${S}.setMode('manual'), true)`)
  await sleep(300)
  await evaluate(`(${S}.addExtraStamp({ x: 0.5, yb: 0.5, w: 0.3 }), true)`)
  await evaluate(`${S}.signAll()`)
  await waitFor(`${S}.result && ${S}.result.signed >= 1`, 'signed', 40000)
  const savedPath = JSON.parse(await evaluate(`JSON.stringify(${S}.result.paths)`))[0]
  const base = savedPath.split(/[\\/]/).pop()
  console.log('saved as:', base)
  if (/[%:*?"<>|]/.test(base.replace(/^[A-Za-z]:/, ''))) fail(`saved name still has illegal chars: ${base}`)
  if (!/_signed\.pdf$/.test(base)) fail(`saved name is not a _signed.pdf: ${base}`)
  if (base !== 'weird_name_signed.pdf') fail(`unexpected sanitised name: ${base}`)

  // B. pick net corrects an already-added doc to its real DISPLAY_NAME
  const uglyUri = 'content://com.android.providers.downloads.documents/document/document%3A999'
  await evaluate(`(async () => {
    const bytes = new Uint8Array(await window.signer.readFile(${JSON.stringify(realB)}))
    await ${S}.addFiles([{ name: 'document%3A999', bytes, path: ${JSON.stringify(uglyUri)} }])
    return true
  })()`)
  await evaluate(`window.__androidPickedFiles([{ uri: ${JSON.stringify(uglyUri)}, name: 'My Real Report.pdf' }])`)
  await waitFor(`${S}.docs.some(d => d.path === ${JSON.stringify(uglyUri)} && d.name === 'My Real Report.pdf')`, 'renamed to real name')
  console.log('renamed URI-id doc to its real DISPLAY_NAME')

  // C. a net-delivered NEW pick is added under its real name (realA's bytes
  // were added in A under a different, path-less key, so this is a fresh add)
  await evaluate(`window.__androidPickedFiles([{ uri: ${JSON.stringify(realA)}, name: 'Fresh Pick.pdf' }])`)
  await waitFor(`${S}.docs.some(d => d.name === 'Fresh Pick.pdf')`, 'net pick added under real name')
  console.log('net-delivered new pick added under its real name')

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
