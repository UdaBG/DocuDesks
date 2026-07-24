// Regression: rotated text/objects in edit mode.
//  A) retyping a vertical (90°) label auto-creates a rotated box (rot -90)
//     with a tall cover, and the EXPORTED replacement text is drawn vertical
//     at the original run's baseline start.
//  B) the rotate handle on a plain text box sets rot (sign-mode-style drag).
//  C) rotated shapes/whiteout export without error.
// node scripts/vertical-retype.mjs
import { spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import electronPath from 'electron'

const OUT_DIR = path.join(os.tmpdir(), 'signer-vertical-out')
const PORT = 9281
await rm(OUT_DIR, { recursive: true, force: true })
await mkdir(OUT_DIR, { recursive: true })
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
const E = `window.__editStore.getState()`
const LABEL = 'Credit Value'
const REPLACED = 'Point Score'

try {
  await send('Page.enable')
  await waitFor(`!!window.__signerStore && !!window.__editStore && !!window.__makeVerticalPdf && !!window.__pdfTextGeom`, 'hooks')

  // load the vertical-label document
  await evaluate(`(async () => {
    const bytes = new Uint8Array(await window.__makeVerticalPdf(${JSON.stringify(LABEL)}))
    await ${S}.addFiles([{ name: 'vertical.pdf', bytes }])
    return true
  })()`)
  await waitFor(`${S}.docs.length === 1`, 'doc added')
  const docId = await evaluate(`${S}.docs[0].id`)
  await evaluate(`(${S}.setView('edit'), true)`)
  await waitFor(`!!document.querySelector('.edit-overlay')`, 'edit overlay')
  await sleep(600)
  await evaluate(`(${E}.setTool('retype'), true)`)

  // A. tap inside the vertical run: label at x=300 y=400 size=10 rot 90 —
  // glyphs occupy x∈[290,300], y(pdf)∈[400, 400+len]; aim mid-run
  const tap = await evaluate(`(() => {
    const el = document.querySelector('.edit-overlay'); const r = el.getBoundingClientRect()
    const xf = 295.5 / 595, yf = 1 - 425 / 842
    const cx = r.left + xf * r.width, cy = r.top + yf * r.height
    const ev = (t) => el.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: 1, pointerType: 'mouse', pressure: 0.5, buttons: 1, clientX: cx, clientY: cy }))
    ev('pointerdown'); ev('pointerup'); return true
  })()`)
  if (!tap) fail('tap dispatch failed')
  await waitFor(`${E}.sessions['${docId}'] && ${E}.sessions['${docId}'].editingId`, 'retype box opened', 30000)
  const created = JSON.parse(await evaluate(`JSON.stringify(${E}.sessions['${docId}'].objects)`))
  const box = created.find((o) => o.kind === 'text')
  const cover = created.find((o) => o.kind === 'whiteout')
  console.log(`box: rot=${box?.rot} text=${JSON.stringify(box?.text)}; cover: w=${cover?.w.toFixed(3)} h=${cover?.h.toFixed(3)}`)
  if (!box || !cover) fail('retype did not create a cover+text pair')
  if (box && box.rot !== -90) fail(`vertical run should create rot -90, got ${box?.rot}`)
  if (box && box.text !== LABEL) fail(`expected run text ${JSON.stringify(LABEL)}, got ${JSON.stringify(box?.text)}`)
  if (cover && !(cover.h > cover.w * 2)) fail(`vertical cover should be tall (w=${cover?.w}, h=${cover?.h})`)

  // replace the text and close the box
  await evaluate(`(() => {
    const el = document.querySelector('.eo-textarea')
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    set.call(el, ${JSON.stringify(REPLACED)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true
  })()`)
  await evaluate(`(() => { document.querySelector('.eo-textarea')?.blur(); return true })()`)
  await sleep(400)

  // export via the real Save button and check the replacement's geometry
  await evaluate(`(document.querySelector('.edit-actionbar .ab-actions .btn-primary').click(), true)`)
  await waitFor(`${E}.savedPath`, 'edited PDF saved', 40000)
  const savedPath = await evaluate(`${E}.savedPath`)
  const geom = JSON.parse(await evaluate(`(async () => JSON.stringify(await window.__pdfTextGeom(await window.signer.readFile(${JSON.stringify(savedPath)}))))()`))
  const item = geom.find((g) => g.str.includes(REPLACED.split(' ')[0]))
  console.log('exported item:', JSON.stringify(item))
  if (!item) fail('replacement text missing from the exported PDF')
  if (item) {
    const [a, b] = item.transform
    if (Math.abs(a) > 0.5 || b < 5) fail(`replacement is not vertical (transform ${item.transform.slice(0, 4)})`)
    const dx = Math.abs(item.transform[4] - 300)
    const dy = Math.abs(item.transform[5] - 400)
    console.log(`baseline start offset from original: dx=${dx.toFixed(2)}pt dy=${dy.toFixed(2)}pt`)
    if (dx > 3.5 || dy > 3.5) fail(`replacement landed off-target (dx=${dx.toFixed(2)}, dy=${dy.toFixed(2)})`)
  }

  // B. rotate handle on a plain text box
  await evaluate(`(${E}.setTool('text'), true)`)
  await evaluate(`(() => {
    const el = document.querySelector('.edit-overlay'); const r = el.getBoundingClientRect()
    const cx = r.left + 0.25 * r.width, cy = r.top + 0.85 * r.height
    const ev = (t) => el.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: 2, pointerType: 'mouse', pressure: 0.5, buttons: 1, clientX: cx, clientY: cy }))
    ev('pointerdown'); ev('pointerup'); return true
  })()`)
  await waitFor(`${E}.sessions['${docId}'].editingId`, 'text box open')
  await evaluate(`(() => {
    const el = document.querySelector('.eo-textarea')
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    set.call(el, 'Angle me'); el.dispatchEvent(new Event('input', { bubbles: true })); return true
  })()`)
  await evaluate(`(() => { document.querySelector('.eo-textarea')?.blur(); return true })()`)
  await sleep(300)
  const plainId = await evaluate(`${E}.sessions['${docId}'].objects.filter(o => o.kind === 'text' && o.text === 'Angle me')[0]?.id`)
  if (!plainId) fail('plain text box was not created')
  await evaluate(`(${E}.setTool('select'), true)`)
  await evaluate(`(${E}.select('${docId}', ${JSON.stringify('')} || '${plainId}'), true)`)
  await waitFor(`!!document.querySelector('.eo-rotate')`, 'rotate handle visible')
  // drag: down on the handle, move to the right of the pivot => ~90°
  await evaluate(`(() => {
    const h = document.querySelector('.eo-rotate')
    const wrap = document.querySelector('.eo-selwrap').getBoundingClientRect()
    const cx = wrap.left + wrap.width / 2, cy = wrap.top + wrap.height / 2
    const hr = h.getBoundingClientRect()
    h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 3, pointerType: 'mouse', buttons: 1, clientX: hr.left + 6, clientY: hr.top + 6 }))
    const ov = document.querySelector('.edit-overlay')
    ov.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 3, pointerType: 'mouse', buttons: 1, clientX: cx + 120, clientY: cy }))
    ov.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 3, pointerType: 'mouse' }))
    return true
  })()`)
  const rotNow = await evaluate(`${E}.sessions['${docId}'].objects.find(o => o.id === '${plainId}')?.rot`)
  console.log('plain box rot after handle drag:', rotNow)
  if (rotNow !== 90) fail(`rotate handle should set 90 (snapped), got ${rotNow}`)

  // C. rotated shapes/whiteout export cleanly
  await evaluate(`(() => {
    const pageId = ${E}.sessions['${docId}'].pages[0].id
    ${E}.addObject('${docId}', { id: 'rw1', pageId, kind: 'whiteout', x: 0.1, y: 0.1, w: 0.2, h: 0.05, fill: '#ffffff', rot: 90 })
    ${E}.addObject('${docId}', { id: 'rr1', pageId, kind: 'rect', x: 0.4, y: 0.1, w: 0.2, h: 0.1, stroke: '#bb3a30', strokeWidthPt: 2, fill: null, opacity: 1, rot: 45 })
    ${E}.addObject('${docId}', { id: 're1', pageId, kind: 'ellipse', x: 0.7, y: 0.1, w: 0.2, h: 0.08, stroke: '#26357c', strokeWidthPt: 2, fill: null, opacity: 1, rot: 30 })
    return true
  })()`)
  await evaluate(`(${E}.setSavedPath(null), true)`)
  await evaluate(`(document.querySelector('.edit-actionbar .ab-actions .btn-primary').click(), true)`)
  await waitFor(`${E}.savedPath`, 'export with rotated shapes saved', 40000)
  console.log('rotated shapes exported cleanly')

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
