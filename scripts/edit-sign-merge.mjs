// Regression (Phase 1): edits are merged into signed output without an
// "Apply to stack" step — signatures stay stack-wide, edits stay per-doc,
// bulk sign still hits every doc, and edits remain editable afterwards.
// node scripts/edit-sign-merge.mjs
import { spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import electronPath from 'electron'

const OUT_DIR = path.join(os.tmpdir(), 'signer-editsign-out')
const PORT = 9267
await rm(OUT_DIR, { recursive: true, force: true })
await mkdir(OUT_DIR, { recursive: true })
const samples = ['Leave_Request_Amara_Perera.pdf', 'Leave_Request_Kasun_Fernando.pdf'].map((f) =>
  path.resolve('samples', f),
)
const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, ...samples], {
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
const MARK = 'EDITMERGE123'

try {
  await send('Page.enable')
  await waitFor(`!!window.__signerStore && !!window.__editStore && !!window.__pdfText`, 'hooks')
  await waitFor(`${S}.docs.length >= 2`, 'two docs')
  const doc0 = await evaluate(`${S}.docs[0].id`)

  // a signature to bulk-place
  await evaluate(`(() => {
    const c = document.createElement('canvas'); c.width = 360; c.height = 120
    const g = c.getContext('2d'); g.strokeStyle = '#26357c'; g.lineWidth = 7; g.lineCap = 'round'
    g.beginPath(); g.moveTo(20, 90); g.bezierCurveTo(90, 10, 160, 120, 340, 40); g.stroke()
    ${S}.addSignature({ name: 'S', dataUrl: c.toDataURL('image/png'), width: c.width, height: c.height })
    return true
  })()`)

  // edit doc 0: add a text box with a distinctive marker, commit it
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
  const objCount = await evaluate(`${E}.sessions['${doc0}'].objects.filter(o => o.kind === 'text').length`)
  if (objCount < 1) fail('edit text object was not created')

  // back to sign, place a signature (applies to the whole stack), sign all —
  // NO "Apply to stack" step
  await evaluate(`(${S}.setView('sign'), ${S}.setMode('manual'), true)`)
  await sleep(400)
  await evaluate(`(${S}.addExtraStamp({ x: 0.5, yb: 0.7, w: 0.3 }), true)`)
  await evaluate(`${S}.signAll()`)
  await waitFor(`${S}.result && ${S}.result.signed >= 2`, 'both docs signed', 40000)
  const paths = await evaluate(`JSON.stringify(${S}.result.paths)`)
  const outs = JSON.parse(paths)
  console.log('signed outputs:', outs.length)
  if (outs.length !== 2) fail(`expected 2 signed outputs, got ${outs.length}`)

  // doc 0 output must contain the edit; doc 1 output must NOT (edits per-doc)
  const t0 = await evaluate(`(async () => window.__pdfText(await window.signer.readFile(${JSON.stringify(outs[0])})))()`)
  const t1 = await evaluate(`(async () => window.__pdfText(await window.signer.readFile(${JSON.stringify(outs[1])})))()`)
  const in0 = t0.includes(MARK)
  const in1 = t1.includes(MARK)
  console.log(`marker in doc0 output: ${in0}; in doc1 output: ${in1}`)
  if (!in0) fail('edit was NOT merged into the signed output of the edited doc')
  if (in1) fail('edit leaked into a doc that was not edited (edits should be per-doc)')

  // edits stay editable after signing (session not dropped)
  const stillEditable = await evaluate(`${E}.sessions['${doc0}'] && ${E}.sessions['${doc0}'].objects.length > 0`)
  console.log('edit session still present after signing:', stillEditable)
  if (!stillEditable) fail('edit session was dropped by signing (edits should stay live)')

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
