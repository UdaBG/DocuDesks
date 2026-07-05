// Regression: (1) whiteout must cover PDF annotations (they paint above page
// content, so export flattens them into the content stream first); an
// uncovered annotation must survive flattening visually. (2) mobile: leaving
// the edit tab and coming back restores the zoomed scroll position.
// node scripts/annot-cover.mjs <shotDir>
import { spawn } from 'node:child_process'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import electronPath from 'electron'
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib'

const SHOT_DIR = path.resolve(process.argv[2] ?? 'e2e-shots')
const OUT_DIR = path.join(os.tmpdir(), 'signer-annot-out')
const PORT = 9245
await mkdir(SHOT_DIR, { recursive: true })
await rm(OUT_DIR, { recursive: true, force: true })
await mkdir(OUT_DIR, { recursive: true })

// ---- craft a PDF with two FreeText annotations (appearance streams) --------
const doc = await PDFDocument.create()
const page = doc.addPage([595, 842])
const helv = await doc.embedFont(StandardFonts.Helvetica)
page.drawText('Regular page content', { x: 60, y: 780, size: 14, font: helv })
const ctx = doc.context
const makeAnnot = (x, y, text, opaque = false) => {
  const bg = opaque ? '1 1 1 rg 0 0 160 24 re f ' : ''
  const ap = ctx.stream(`q ${bg}BT /F0 16 Tf 0 0 0 rg 2 5 Td (${text}) Tj ET Q`, {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, 160, 24],
    Resources: { Font: { F0: helv.ref } },
  })
  const annot = ctx.obj({
    Type: 'Annot',
    Subtype: 'FreeText',
    Rect: [x, y, x + 160, y + 24],
    F: 4,
    AP: { N: ctx.register(ap) },
    DA: '/Helv 0 Tf 0 g',
  })
  return ctx.register(annot)
}
const covered = makeAnnot(60, 700, 'SN-COVERED')
const visible = makeAnnot(60, 650, 'SN-VISIBLE')
// opaque background: without flattening, signing under this erases the stamp
const signOver = makeAnnot(60, 590, 'SN-SIGNOVER', true)
page.node.set(PDFName.of('Annots'), ctx.obj([covered, visible, signOver]))
const annotPdf = path.join(OUT_DIR, 'annotated.pdf')
await writeFile(annotPdf, await doc.save())

const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, annotPdf], {
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
/** darkest luminance inside a fractional region of the sign-view page canvas */
const minLum = (fx0, fy0, fx1, fy1) =>
  evaluate(`(() => {
    const c = document.querySelector('.sheet canvas')
    const g = c.getContext('2d', { willReadFrequently: true })
    const x0 = Math.floor(${fx0} * c.width), y0 = Math.floor(${fy0} * c.height)
    const w = Math.max(1, Math.floor((${fx1} - ${fx0}) * c.width))
    const h = Math.max(1, Math.floor((${fy1} - ${fy0}) * c.height))
    const d = g.getImageData(x0, y0, w, h).data
    let min = 255
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
      if (l < min) min = l
    }
    return Math.round(min)
  })()`)
const fail = (msg) => {
  console.error('FAIL:', msg)
  process.exitCode = 1
}
const S = `window.__signerStore.getState()`
const E = `window.__editStore.getState()`

// annotation regions as page fractions (PDF y is bottom-up, canvas top-down)
const COVERED = { x0: 60 / 595, x1: 220 / 595, y0: (842 - 724) / 842, y1: (842 - 700) / 842 }
const VISIBLE = { x0: 60 / 595, x1: 220 / 595, y0: (842 - 674) / 842, y1: (842 - 650) / 842 }

try {
  await send('Page.enable')
  await waitFor(`!!window.__signerStore && !!window.__editStore`, 'stores')
  await waitFor(`${S}.docs.length >= 1`, 'doc loaded')

  // sanity: both annotations render in the app preview
  await sleep(800)
  const preCovered = await minLum(COVERED.x0, COVERED.y0, COVERED.x1, COVERED.y1)
  const preVisible = await minLum(VISIBLE.x0, VISIBLE.y0, VISIBLE.x1, VISIBLE.y1)
  console.log('annotation ink before edit (covered, visible):', preCovered, preVisible)
  if (preCovered > 120 || preVisible > 120) fail('annotations did not render in the preview')

  // whiteout over the first annotation in edit mode
  await evaluate(`(${S}.setView('edit'), true)`)
  await waitFor(`!!document.querySelector('.edit-overlay')`, 'edit overlay')
  await evaluate(`(${E}.setTool('whiteout'), true)`)
  const ov = await rectOf('.edit-overlay')
  await drag([
    [ov.x + (COVERED.x0 - 0.02) * ov.w, ov.y + (COVERED.y0 - 0.008) * ov.h],
    [ov.x + (COVERED.x1 + 0.02) * ov.w, ov.y + (COVERED.y1 + 0.008) * ov.h],
  ])
  await sleep(300)
  const nObj = await evaluate(`${E}.sessions[${S}.docs[0].id].objects.length`)
  if (nObj !== 1) fail(`expected 1 whiteout object, got ${nObj}`)

  // save the edited copy and load it back
  await domClick('.actionbar .btn-primary')
  await waitFor(`!!window.__editStore.getState().savedPath`, 'edited saved')
  const editedPath = await evaluate(`${E}.savedPath`)
  await evaluate(`(${S}.setView('sign'), true)`)
  await evaluate(`(async () => {
    const bytes = await window.signer.readFile(${JSON.stringify(editedPath)})
    await ${S}.addFiles([{ name: 'edited-annot.pdf', bytes }])
    const docs = window.__signerStore.getState().docs
    window.__signerStore.getState().selectDoc(docs[docs.length - 1].id)
  })()`)
  await sleep(1500)

  const postCovered = await minLum(COVERED.x0, COVERED.y0, COVERED.x1, COVERED.y1)
  const postVisible = await minLum(VISIBLE.x0, VISIBLE.y0, VISIBLE.x1, VISIBLE.y1)
  console.log('annotation ink after edit (covered, visible):', postCovered, postVisible)
  if (postCovered < 230) fail(`whiteout did not cover the annotation (darkest px ${postCovered})`)
  if (postVisible > 120) fail(`uncovered annotation lost its appearance after flattening (darkest px ${postVisible})`)
  await shot('01-annotation-covered.png')

  // ---- signing over an OPAQUE annotation: the stamp must stay on top -------
  await evaluate(`(${S}.selectDoc(${S}.docs[0].id), true)`)
  await evaluate(`(() => {
    const c = document.createElement('canvas'); c.width = 400; c.height = 140
    const g = c.getContext('2d')
    g.strokeStyle = '#26357c'; g.lineWidth = 9; g.lineCap = 'round'
    g.beginPath(); g.moveTo(20, 100); g.bezierCurveTo(90, 10, 150, 130, 220, 50)
    g.bezierCurveTo(260, 10, 330, 120, 380, 60); g.stroke()
    ${S}.addSignature({ name: 'T', dataUrl: c.toDataURL('image/png'), width: c.width, height: c.height })
    return true
  })()`)
  // stamp box overlapping the opaque annotation (PDF y 590..614)
  await evaluate(`(${S}.addExtraStamp({ x: 0.10, yb: ${(842 - 585) / 842}, w: 0.30 }), true)`)
  await evaluate(`${S}.signAll()`)
  await waitFor(`${S}.result && ${S}.result.signed >= 1`, 'signed over annotation')
  const signedPath = await evaluate(`${S}.result.paths[0]`)
  await evaluate(`(${S}.dismissResult(), true)`)
  await evaluate(`(${S}.removeExtraStampEverywhere(${S}.extraStamps[0].id), true)`)
  await evaluate(`(async () => {
    const bytes = await window.signer.readFile(${JSON.stringify(signedPath)})
    await ${S}.addFiles([{ name: 'signed-annot.pdf', bytes }])
    const docs = window.__signerStore.getState().docs
    window.__signerStore.getState().selectDoc(docs[docs.length - 1].id)
  })()`)
  await sleep(1500)
  // signature ink (blue) must be present inside the annotation's rectangle
  const bluish = await evaluate(`(() => {
    const c = document.querySelector('.sheet canvas')
    const g = c.getContext('2d', { willReadFrequently: true })
    const x0 = Math.floor(${62 / 595} * c.width), y0 = Math.floor(${(842 - 612) / 842} * c.height)
    const w = Math.floor(${156 / 595} * c.width), h = Math.floor(${20 / 842} * c.height)
    const d = g.getImageData(x0, y0, w, h).data
    let n = 0
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 2] - d[i] > 30 && d[i + 2] > 80) n++
    }
    return n
  })()`)
  console.log('signature-ink pixels inside opaque annotation rect:', bluish)
  if (bluish < 30) fail(`signature was painted over by the opaque annotation (${bluish} ink px)`)
  await shot('01b-sign-over-annotation.png')

  // ---- mobile: tab away and back keeps the zoomed scroll position ----------
  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true })
  await evaluate(`(${S}.selectDoc(${S}.docs[0].id), true)`)
  await evaluate(`(${S}.setView('edit'), true)`)
  await sleep(900)
  for (let i = 0; i < 5; i++) {
    await domClick('.zoom-pill button:last-child')
    await sleep(120)
  }
  await sleep(1000)
  await evaluate(`(() => { const el = document.querySelector('.edit-scroll'); el.scrollLeft = 180; el.scrollTop = 420; return true })()`)
  await sleep(300)
  const set0 = await evaluate(`(() => { const el = document.querySelector('.edit-scroll'); return [el.scrollLeft, el.scrollTop, el.scrollWidth, el.clientWidth] })()`)
  console.log('scroll before tab switch:', JSON.stringify(set0))
  console.log('debug before switch:', JSON.stringify(await evaluate(`window.__editScrollDebug()`)))
  await domClick('.mobile-nav .mobile-tab:nth-child(3)') // Tools
  await sleep(500)
  const hidden = await evaluate(`getComputedStyle(document.querySelector('.edit-stage')).display`)
  const sizerWhileHidden = await evaluate(`!!document.querySelector('.zoom-sizer')`)
  console.log('stage display while on Tools tab:', hidden, '— zoom-sizer still mounted:', sizerWhileHidden)
  await domClick('.mobile-nav .mobile-tab:nth-child(2)') // back to Edit
  let pos = [0, 0]
  for (let i = 0; i < 8; i++) {
    await sleep(300)
    pos = await evaluate(`(() => { const el = document.querySelector('.edit-scroll'); return [el.scrollLeft, el.scrollTop] })()`)
    console.log(`scroll ${(i + 1) * 300}ms after return:`, JSON.stringify(pos), JSON.stringify(await evaluate(`window.__editScrollDebug()`)))
    if (pos[0] > 0 || pos[1] > 0) break
  }
  if (Math.abs(pos[0] - 180) > 4 || Math.abs(pos[1] - 420) > 4) fail(`scroll not restored: ${pos}`)
  await shot('02-scroll-restored.png')
  await send('Emulation.clearDeviceMetricsOverride')

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
