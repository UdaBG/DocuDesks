// Regression: saving from the EDIT side must include the signature, not just
// the edits. Both sides finalize through store.finalizedBytesFor, so the
// "Save edited PDF" output for a doc must equal the "Sign" output for the same
// doc (same edit + same single stamp) — and be larger than the original.
// node scripts/edit-save-signature.mjs
import { spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import electronPath from 'electron'

const OUT_DIR = path.join(os.tmpdir(), 'signer-editsig-out')
const PORT = 9271
await rm(OUT_DIR, { recursive: true, force: true })
await mkdir(OUT_DIR, { recursive: true })
const sample = path.resolve('samples', 'Leave_Request_Amara_Perera.pdf')
const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, sample], {
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
const E = `window.__editStore.getState()`
const MARK = 'EDITSIGN789'

try {
  await send('Page.enable')
  await waitFor(`!!window.__signerStore && !!window.__editStore && !!window.__pdfText`, 'hooks')
  await waitFor(`${S}.docs.length >= 1`, 'doc')
  const doc0 = await evaluate(`${S}.docs[0].id`)
  const baseLen = await evaluate(`${S}.docs[0].bytes.length`)

  // a signature to place
  await evaluate(`(() => {
    const c = document.createElement('canvas'); c.width = 360; c.height = 120
    const g = c.getContext('2d'); g.strokeStyle = '#26357c'; g.lineWidth = 7; g.lineCap = 'round'
    g.beginPath(); g.moveTo(20, 90); g.bezierCurveTo(90, 10, 160, 120, 340, 40); g.stroke()
    ${S}.addSignature({ name: 'S', dataUrl: c.toDataURL('image/png'), width: c.width, height: c.height })
    return true
  })()`)

  // edit doc 0: add a text box, commit
  await evaluate(`(${S}.selectDoc('${doc0}'), ${S}.setView('edit'), true)`)
  await waitFor(`!!document.querySelector('.edit-overlay')`, 'edit overlay')
  await sleep(500)
  await evaluate(`(${E}.setTool('text'), true)`)
  await evaluate(`(() => {
    const el = document.querySelector('.edit-overlay'); const r = el.getBoundingClientRect()
    const ev = (t) => el.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: 1, pointerType: 'mouse', pressure: 0.5, buttons: 1, clientX: r.left + r.width*0.3, clientY: r.top + r.height*0.5 }))
    ev('pointerdown'); ev('pointerup'); return true
  })()`)
  await waitFor(`${E}.sessions['${doc0}'] && ${E}.sessions['${doc0}'].editingId`, 'text box open')
  await evaluate(`(() => {
    const el = document.querySelector('.eo-textarea')
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    set.call(el, '${MARK}'); el.dispatchEvent(new Event('input', { bubbles: true })); return true
  })()`)
  await evaluate(`(() => { document.querySelector('.eo-textarea')?.blur(); return true })()`)
  await sleep(300)
  if ((await evaluate(`${E}.sessions['${doc0}'].objects.filter(o => o.kind === 'text').length`)) < 1)
    fail('edit text object was not created')

  // sign side: place one stamp, sign — this output is our known-good baseline
  // (Phase-1 test proves it carries the edit; it also carries the signature)
  await evaluate(`(${S}.setView('sign'), ${S}.setMode('manual'), true)`)
  await sleep(400)
  await evaluate(`(${S}.addExtraStamp({ x: 0.5, yb: 0.7, w: 0.3 }), true)`)
  await evaluate(`${S}.signAll()`)
  await waitFor(`${S}.result && ${S}.result.signed >= 1`, 'signed', 40000)
  const signPath = JSON.parse(await evaluate(`JSON.stringify(${S}.result.paths)`))[0]
  const signLen = await evaluate(`(async () => (await window.signer.readFile(${JSON.stringify(signPath)})).length)()`)
  const signText = await evaluate(`(async () => window.__pdfText(await window.signer.readFile(${JSON.stringify(signPath)})))()`)
  console.log(`sign-side output: ${signLen} bytes, has edit marker: ${signText.includes(MARK)}`)
  if (signLen <= baseLen) fail(`sign output not larger than base (${baseLen} -> ${signLen})`)
  if (!signText.includes(MARK)) fail('sign output missing the edit marker')

  // edit side: click the real "Save edited PDF" button (build(true) -> finalizedBytesFor)
  await evaluate(`(${S}.setView('edit'), true)`)
  await waitFor(`!!document.querySelector('.edit-overlay')`, 'edit overlay again')
  await evaluate(`(${E}.setSavedPath(null), true)`)
  await evaluate(`(document.querySelector('.edit-actionbar .ab-actions .btn-primary').click(), true)`)
  await waitFor(`${E}.savedPath`, 'edit save wrote a file', 40000)
  const editPath = await evaluate(`${E}.savedPath`)
  const editLen = await evaluate(`(async () => (await window.signer.readFile(${JSON.stringify(editPath)})).length)()`)
  const editText = await evaluate(`(async () => window.__pdfText(await window.signer.readFile(${JSON.stringify(editPath)})))()`)
  console.log(`edit-side output: ${editLen} bytes, has edit marker: ${editText.includes(MARK)}`)

  // the fix: edit-side output must include the signature -> same size as the
  // sign-side output, and clearly larger than the un-signed base.
  if (!editText.includes(MARK)) fail('edit-side save dropped the edit')
  if (editLen <= baseLen) fail(`edit-side save produced no added content (${baseLen} -> ${editLen})`)
  // Both sides finalize through the same code, so the outputs should be within
  // a few bytes (pdf-lib jitter / an edit re-render can shift a byte or two). A
  // *dropped signature* would remove the embedded PNG — hundreds of bytes — so
  // require the two to be close rather than byte-identical.
  if (Math.abs(editLen - signLen) > 400)
    fail(`edit-side save differs from sign-side by ${Math.abs(editLen - signLen)} bytes — signature likely missing`)
  else console.log(`edit-side output matches sign-side within ${Math.abs(editLen - signLen)} bytes — signature IS included`)

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
