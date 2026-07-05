// Regression: stamp rotation (preview + baked into signed PDF), studio ink
// mixer + gold/silver + pen variants, edit-mode dash styles (preview + baked
// into saved PDF), and the phone layout incl. edit mode.
// node scripts/feature-shots.mjs <shotDir>
import { spawn } from 'node:child_process'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import electronPath from 'electron'

const SHOT_DIR = path.resolve(process.argv[2] ?? 'e2e-shots')
const OUT_DIR = path.join(os.tmpdir(), 'signer-feature-out')
const PORT = 9241
await mkdir(SHOT_DIR, { recursive: true })
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
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 700))
  return r.result?.result?.value
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(path.join(SHOT_DIR, name), Buffer.from(r.result.data, 'base64'))
  console.log('shot:', name)
}
const waitFor = async (expr, label, ms = 20000) => {
  const start = Date.now()
  for (;;) {
    if (await evaluate(expr)) return
    if (Date.now() - start > ms) throw new Error('timeout: ' + label)
    await sleep(300)
  }
}
const rectOf = (sel) =>
  evaluate(
    `(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })()`,
  )
// trusted drag via CDP input — real pointer events, so setPointerCapture works
async function drag(points) {
  const [x0, y0] = points[0]
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1 })
  for (const [x, y] of points.slice(1)) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
    await sleep(16)
  }
  const [xe, ye] = points[points.length - 1]
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: xe, y: ye, button: 'left', buttons: 0, clickCount: 1 })
}
const domClick = (sel) => evaluate(`(document.querySelector('${sel}').click(), true)`)
const fail = (msg) => {
  console.error('FAIL:', msg)
  process.exitCode = 1
}
const S = `window.__signerStore.getState()`

try {
  await send('Page.enable')
  await waitFor(`!!window.__signerStore && !!window.__editStore`, 'stores')
  await waitFor(`${S}.docs.length >= 1`, 'doc loaded')

  // a simple signature to stamp with
  await evaluate(`(() => {
    const c = document.createElement('canvas'); c.width = 400; c.height = 140
    const g = c.getContext('2d')
    g.strokeStyle = '#26357c'; g.lineWidth = 7; g.lineCap = 'round'
    g.beginPath(); g.moveTo(20, 100); g.bezierCurveTo(90, 10, 150, 130, 220, 50)
    g.bezierCurveTo(260, 10, 330, 120, 380, 60); g.stroke()
    ${S}.addSignature({ name: 'Test', dataUrl: c.toDataURL('image/png'), width: c.width, height: c.height })
    return true
  })()`)

  // ---- 1. rotation: place an extra stamp, rotate it 25° -------------------
  await evaluate(`(${S}.addExtraStamp({ x: 0.5, yb: 0.72, w: 0.28 }), true)`)
  const stampId = await evaluate(`${S}.extraStamps[0].id`)
  await evaluate(`(${S}.updateExtraStamp('${stampId}', { x: 0.5, yb: 0.72, w: 0.28, rot: 25 }), true)`)
  await sleep(400)
  const rot = await evaluate(`${S}.extraStamps[0].placement.rot`)
  if (rot !== 25) fail(`stamp rot expected 25, got ${rot}`)
  await evaluate(`(${S}.setSelectedStamp('${stampId}'), true)`)
  await sleep(200)
  await shot('01-rotated-stamp-preview.png')

  // sign, then load the signed copy back in — the rotation must be baked in
  await evaluate(`${S}.signAll()`)
  await waitFor(`${S}.result && ${S}.result.signed >= 1`, 'signed')
  const signedPath = await evaluate(`${S}.result.paths[0]`)
  console.log('signed:', signedPath)
  await evaluate(`(${S}.dismissResult(), true)`)
  await evaluate(`(${S}.removeExtraStampEverywhere('${stampId}'), true)`)
  await evaluate(`(async () => {
    const bytes = await window.signer.readFile(${JSON.stringify(signedPath)})
    await ${S}.addFiles([{ name: 'signed-check.pdf', bytes }])
    const docs = window.__signerStore.getState().docs
    window.__signerStore.getState().selectDoc(docs[docs.length - 1].id)
  })()`)
  await sleep(1200)
  await shot('02-rotation-baked-into-pdf.png')

  // ---- 2. studio: gold ink + marker pen + mixer ----------------------------
  await evaluate(`(${S}.openStudio(), true)`)
  await waitFor(`!!document.querySelector('.draw-paper canvas')`, 'studio open')
  const penCount = await evaluate(`document.querySelectorAll('.pen-opt').length`)
  if (penCount !== 3) fail(`expected 3 pen options, got ${penCount}`)
  // scope to the Draw tab: the Type tab mounts its own picker too
  const swatchCount = await evaluate(
    `document.querySelectorAll('.tab-body')[0].querySelectorAll('.ink-swatch').length`,
  )
  console.log('draw-tab ink swatches (incl. custom):', swatchCount)
  if (swatchCount !== 6) fail(`expected 6 ink swatches (3 preset + 2 metallic + custom), got ${swatchCount}`)

  // gold + fountain
  await evaluate(`(document.querySelectorAll('.ink-picker .ink-swatch')[3].click(), true)`)
  const paper = await rectOf('.draw-paper canvas')
  const wave = (yShift) =>
    Array.from({ length: 24 }, (_, i) => [
      paper.x + paper.w * (0.08 + (0.84 * i) / 23),
      paper.y + paper.h * (0.5 + yShift) + Math.sin(i / 2.2) * paper.h * 0.22,
    ])
  await drag(wave(-0.12))
  // ballpoint stroke
  await domClick('.pen-opt:nth-child(3)') // label + 3 buttons: fountain is 2nd child
  await drag(wave(0.05))
  // marker stroke
  await domClick('.pen-opt:nth-child(4)')
  await drag(wave(0.22))
  await sleep(300)
  await shot('03-studio-gold-three-pens.png')

  // custom mixer popover
  await domClick('.ink-swatch.custom')
  await waitFor(`!!document.querySelector('.color-popover')`, 'mixer open')
  await shot('04-studio-color-mixer.png')
  await evaluate(`(() => {
    const inp = document.querySelector('.cp-hex')
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(inp, '#b03060')
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(250)
  const strokes = await evaluate(`document.querySelectorAll('.draw-paper canvas').length`)
  console.log('draw canvas present:', strokes)
  await shot('05-studio-custom-color.png')
  await domClick('.studio-head .icon-btn') // close studio

  // ---- 3. edit mode: dashed line + dotted rect, then baked PDF ------------
  await evaluate(`(${S}.selectDoc(${S}.docs[0].id), true)`)
  await evaluate(`(${S}.setView('edit'), true)`)
  await waitFor(`!!document.querySelector('.edit-overlay')`, 'edit overlay')
  const E = `window.__editStore.getState()`
  const overlay = await rectOf('.edit-overlay')
  await evaluate(`(${E}.setStyle({ dash: 'dashed', strokeWidthPt: 2.5 }), ${E}.setTool('line'), true)`)
  await drag([
    [overlay.x + overlay.w * 0.15, overlay.y + overlay.h * 0.3],
    [overlay.x + overlay.w * 0.7, overlay.y + overlay.h * 0.3],
  ])
  await evaluate(`(${E}.setStyle({ dash: 'dotted' }), ${E}.setTool('rect'), true)`)
  await drag([
    [overlay.x + overlay.w * 0.2, overlay.y + overlay.h * 0.42],
    [overlay.x + overlay.w * 0.65, overlay.y + overlay.h * 0.62],
  ])
  await evaluate(`(${E}.setStyle({ dash: 'solid' }), ${E}.setTool('arrow'), true)`)
  await drag([
    [overlay.x + overlay.w * 0.2, overlay.y + overlay.h * 0.72],
    [overlay.x + overlay.w * 0.6, overlay.y + overlay.h * 0.82],
  ])
  await evaluate(`(${E}.setTool('select'), true)`)
  await sleep(300)
  const docId0 = await evaluate(`${S}.docs[0].id`)
  const kinds = await evaluate(`JSON.stringify(${E}.sessions['${docId0}'].objects.map(o => o.kind + ':' + (o.dash ?? '-')))`)
  console.log('edit objects:', kinds)
  await shot('06-edit-dash-variants.png')
  // panel with the dash selector visible
  await evaluate(`(${E}.setTool('line'), true)`)
  await sleep(200)
  await shot('07-edit-panel-dash-selector.png')

  // save the edited copy and load it back: dashes must survive pdf-lib
  await domClick('.actionbar .btn-primary')
  await waitFor(`!!window.__editStore.getState().savedPath`, 'edited saved')
  const editedPath = await evaluate(`${E}.savedPath`)
  console.log('edited:', editedPath)
  await evaluate(`(${S}.setView('sign'), true)`)
  await evaluate(`(async () => {
    const bytes = await window.signer.readFile(${JSON.stringify(editedPath)})
    await ${S}.addFiles([{ name: 'edited-check.pdf', bytes }])
    const docs = window.__signerStore.getState().docs
    window.__signerStore.getState().selectDoc(docs[docs.length - 1].id)
  })()`)
  await sleep(1200)
  await shot('08-dashes-baked-into-pdf.png')

  // ---- 4. phone layout: sign view, edit view -------------------------------
  await send('Emulation.setDeviceMetricsOverride', {
    width: 412,
    height: 915,
    deviceScaleFactor: 2,
    mobile: true,
  })
  await sleep(800)
  await shot('09-mobile-sign.png')
  const overflow = await evaluate(
    `document.documentElement.scrollWidth - document.documentElement.clientWidth`,
  )
  if (overflow > 1) fail(`mobile sign view overflows horizontally by ${overflow}px`)
  await evaluate(`(${S}.setView('edit'), true)`)
  await sleep(900)
  await shot('10-mobile-edit.png')
  const overflow2 = await evaluate(
    `document.documentElement.scrollWidth - document.documentElement.clientWidth`,
  )
  if (overflow2 > 1) fail(`mobile edit view overflows horizontally by ${overflow2}px`)
  await send('Emulation.clearDeviceMetricsOverride')

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
