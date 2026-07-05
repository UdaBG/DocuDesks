// Regression for the click-to-place interaction model:
// click paper = place (deselected), clean click = select, drag ≠ select,
// empty click deselects first, × shows the multi-doc confirmation dialog.
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import electronPath from 'electron'

const OUT_DIR = path.resolve(process.argv[2] ?? 'e2e-out-stamps')
const SHOT_DIR = path.resolve(process.argv[3] ?? 'e2e-shots')
const PORT = 9237
await mkdir(OUT_DIR, { recursive: true })
await mkdir(SHOT_DIR, { recursive: true })
const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, path.resolve('samples/Service_Agreement.pdf')], {
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
const fail = (msg) => {
  console.error('FAIL:', msg)
  process.exitCode = 1
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(path.join(SHOT_DIR, name), Buffer.from(r.result.data, 'base64'))
  console.log('shot:', name)
}
const S = () => `window.__signerStore.getState()`
const clickSheet = (fx, fy) => `(() => {
  const sheet = document.querySelector('.sheet')
  const r = sheet.getBoundingClientRect()
  sheet.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + ${fx} * r.width, clientY: r.top + ${fy} * r.height }))
  return true
})()`

await send('Page.enable')
await waitFor(`!!window.__signerStore`, 'store')
await waitFor(`${S()}.docs.length >= 1`, 'doc')
await evaluate(`(${S()}.duplicateDoc(${S()}.docs[0].id), true)`)
await waitFor(`${S()}.docs.length === 2`, 'two docs')
const [docA, docB] = await evaluate(`${S()}.docs.map(d => d.id)`)

await evaluate(`(() => {
  const make = (name, w, h, color) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h
    const ctx = c.getContext('2d'); ctx.strokeStyle = color; ctx.lineWidth = 8; ctx.lineCap = 'round'
    ctx.beginPath(); ctx.moveTo(w*0.1, h*0.8); ctx.bezierCurveTo(w*0.3, h*0.1, w*0.5, h*0.9, w*0.9, h*0.2); ctx.stroke()
    ${S()}.addSignature({ name, dataUrl: c.toDataURL('image/png'), width: w, height: h })
  }
  make('Tall A', 400, 400, '#26357c')
  make('Wide B', 600, 150, '#17804d')
  return true
})()`)
const tallId = await evaluate(`${S()}.signatures.find(s => s.name === 'Tall A').id`)
const wideId = await evaluate(`${S()}.signatures.find(s => s.name === 'Wide B').id`)
await evaluate(`(${S()}.setActiveSignature('${tallId}'), true)`)

// 1. click paper on page 2 of doc A places a stamp, deselected, no primary box
await evaluate(`(${S()}.selectDoc('${docA}'), true)`)
await evaluate(`(${S()}.setPreviewPage(1), true)`)
await sleep(900)
await evaluate(clickSheet(0.55, 0.5))
await sleep(300)
if ((await evaluate(`${S()}.extraStamps.length`)) !== 1) fail('click on paper did not place a stamp')
if ((await evaluate(`${S()}.selectedStampId`)) !== null) fail('freshly placed stamp must be deselected')
if ((await evaluate(`document.querySelectorAll('.sig-box:not(.extra)').length`)) !== 0) fail('manual mode should have no auto primary box')
const stamp1 = await evaluate(`${S()}.extraStamps[0].id`)
console.log('click-to-place, deselected: OK')

// 2. visible on doc B
await evaluate(`(${S()}.selectDoc('${docB}'), true)`)
await evaluate(`(${S()}.setPreviewPage(1), true)`)
await sleep(900)
if ((await evaluate(`document.querySelectorAll('.sig-box.extra').length`)) !== 1) fail('stamp not replicated to doc B')
console.log('stack-wide replication: OK')

// 3. dragging must move but NOT select
const xBefore = await evaluate(`${S()}.extraStamps[0].placement.x`)
await evaluate(`(() => {
  const el = document.querySelector('.sig-box.extra')
  const r = el.getBoundingClientRect()
  const ev = (type, dx) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, buttons: 1, clientX: r.left + 10 + dx, clientY: r.top + 10 }))
  ev('pointerdown', 0); ev('pointermove', 20); ev('pointermove', 40); ev('pointerup', 40)
  return true
})()`)
await sleep(250)
if ((await evaluate(`${S()}.selectedStampId`)) !== null) fail('drag selected the stamp — it must not')
if ((await evaluate(`${S()}.extraStamps[0].placement.x`)) === xBefore) fail('drag did not move the stamp')
console.log('drag moves without selecting: OK')

// 4. clean click selects; signature card click swaps; active unchanged
await evaluate(`(() => {
  const el = document.querySelector('.sig-box.extra')
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, buttons: 1 }))
  el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))
  return true
})()`)
await sleep(200)
if ((await evaluate(`${S()}.selectedStampId`)) !== stamp1) fail('clean click did not select')
await evaluate(`(() => { [...document.querySelectorAll('.sig-pick')].find(b => b.title === 'Wide B').click(); return true })()`)
await sleep(200)
const swap = await evaluate(`(() => { const s = ${S()}; return { sig: s.extraStamps[0].signatureId, active: s.activeSignatureId } })()`)
if (swap.sig !== wideId || swap.active !== tallId) fail(`swap wrong: ${JSON.stringify(swap)}`)
console.log('select + swap: OK')

// 5. empty click deselects without placing; second click places
await evaluate(clickSheet(0.3, 0.8))
await sleep(200)
if ((await evaluate(`${S()}.selectedStampId`)) !== null) fail('empty click did not deselect')
if ((await evaluate(`${S()}.extraStamps.length`)) !== 1) fail('deselect click must not place a stamp')
await evaluate(clickSheet(0.3, 0.8))
await sleep(250)
if ((await evaluate(`${S()}.extraStamps.length`)) !== 2) fail('second empty click should place')
console.log('deselect-first clicking: OK')

// 6. x opens the confirmation dialog (multi-doc): doc-only path
await evaluate(`(document.querySelectorAll('.sig-box.extra')[0].querySelector('.stamp-x:not(.stamp-doc-x)').click(), true)`)
await sleep(250)
if (!(await evaluate(`!!document.querySelector('.confirm-dialog')`))) fail('x did not open the confirmation dialog')
await shot('e15-remove-dialog.png')
await evaluate(`(document.querySelector('.confirm-dialog .ghost-btn').click(), true)`) // "Remove from this document"
await sleep(250)
if ((await evaluate(`${S()}.extraStamps.length`)) !== 2) fail('doc-only choice must keep the stamp globally')
if (!(await evaluate(`(${S()}.docs.find(d => d.id === '${docB}').excludedStamps ?? []).length === 1`))) fail('doc-only choice did not exclude locally')

// 7. x -> remove from all
await evaluate(`(document.querySelectorAll('.sig-box.extra')[0].querySelector('.stamp-x:not(.stamp-doc-x)').click(), true)`)
await sleep(250)
await evaluate(`(document.querySelector('.confirm-dialog .btn-danger').click(), true)`)
await sleep(250)
if ((await evaluate(`${S()}.extraStamps.length`)) !== 1) fail('remove-all did not delete the stamp')
console.log('x dialog (doc-only / remove-all): OK')

// 8. smart mode still auto-proposes its stamp
await evaluate(`(${S()}.setMode('smart'), true)`)
await waitFor(`(() => { const s = ${S()}; return !s.detecting && s.docs.every(d => d.smart !== undefined) })()`, 'detect')
await sleep(800)
if ((await evaluate(`document.querySelectorAll('.sig-box:not(.extra)').length`)) !== 1) fail('smart primary box missing')
console.log('smart auto-proposal intact: OK')

// 9. sign both
await evaluate(`${S()}.signAll()`)
await waitFor(`!!${S()}.result`, 'signed')
const result = await evaluate(`${S()}.result`)
console.log('sign result:', JSON.stringify(result))
if (result.signed !== 2) fail(`expected 2 signed docs, got ${result.signed}`)

ws.close()
child.kill()
console.log(process.exitCode ? 'MULTI STAMPS FAILED' : 'MULTI STAMPS PASSED')
