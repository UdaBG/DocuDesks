// Regression: covers must blend into non-white backgrounds. A page with a
// tinted table-cell background: (1) retype covers sample the paper behind
// the text, (2) whiteout rectangles sample the band around them, (3) the
// panel fill control overrides a selected cover.
// node scripts/cover-color.mjs
import { spawn } from 'node:child_process'
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import electronPath from 'electron'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

const PORT = 9259
const TMP = path.join(os.tmpdir(), 'signer-covercolor')
await mkdir(TMP, { recursive: true })

// light-blue page (bank-statement style) with black body text, plus a solid
// blue header band carrying WHITE text (the table-header case)
const doc = await PDFDocument.create()
const page = doc.addPage([595, 842])
page.drawRectangle({ x: 0, y: 0, width: 595, height: 842, color: rgb(0.86, 0.91, 0.97) }) // #dbe8f7
const helv = await doc.embedFont(StandardFonts.Helvetica)
page.drawText('Transaction Fee 360,000.00', { x: 80, y: 700, size: 14, font: helv, color: rgb(0.1, 0.1, 0.1) })
page.drawText('Balance 1,390,189,345.30', { x: 80, y: 640, size: 14, font: helv, color: rgb(0.1, 0.1, 0.1) })
// blue header band with white text near the top (y ~ 780pt)
page.drawRectangle({ x: 0, y: 760, width: 595, height: 44, color: rgb(0.36, 0.61, 0.84) }) // #5b9bd6
page.drawText('Posting Date', { x: 30, y: 774, size: 15, font: helv, color: rgb(1, 1, 1) })
const pdfPath = path.join(TMP, 'tinted.pdf')
await writeFile(pdfPath, await doc.save())

const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, pdfPath], {
  stdio: 'ignore',
  env: { ...process.env, VITE_DEV_SERVER_URL: '' },
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
const fail = (msg) => {
  console.error('FAIL:', msg)
  process.exitCode = 1
}
const near = (hex, r, g, b, tol = 16) => {
  const v = parseInt(hex.slice(1), 16)
  return (
    Math.abs(((v >> 16) & 255) - r) <= tol &&
    Math.abs(((v >> 8) & 255) - g) <= tol &&
    Math.abs((v & 255) - b) <= tol
  )
}
const S = `window.__signerStore.getState()`
const E = `window.__editStore.getState()`

try {
  await send('Page.enable')
  await waitFor(`!!window.__signerStore && !!window.__editStore`, 'stores')
  await waitFor(`${S}.docs.length >= 1`, 'doc loaded')
  await evaluate(`(${S}.setView('edit'), true)`)
  await waitFor(`!!document.querySelector('.edit-overlay')`, 'edit overlay')
  await sleep(500)
  const docId = await evaluate(`${S}.docs[0].id`)

  // 1. retype: cover samples the tinted paper (#dbe8f7-ish), not white
  await evaluate(`(${E}.setTool('retype'), true)`)
  const ov = await rectOf('.edit-overlay')
  // "Transaction Fee" line: y=700pt baseline -> top frac = (842-707)/842
  await evaluate(`(() => {
    const el = document.querySelector('.edit-overlay')
    const r = el.getBoundingClientRect()
    const ev = (type) => el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerId: 1, pointerType: 'mouse', pressure: 0.5, buttons: 1,
      clientX: r.left + ${140 / 595} * r.width, clientY: r.top + ${(842 - 703) / 842} * r.height,
    }))
    ev('pointerdown'); ev('pointerup')
    return true
  })()`)
  await waitFor(`${E}.sessions['${docId}'] && ${E}.sessions['${docId}'].editingId`, 'retype box open')
  const coverFill = await evaluate(`(() => {
    const s = ${E}.sessions['${docId}']
    return s.objects.find(o => o.kind === 'whiteout')?.fill
  })()`)
  console.log('retype cover fill on tinted page:', coverFill)
  if (!coverFill || !near(coverFill, 219, 232, 247)) fail(`retype cover ${coverFill}, expected ~#dbe8f7`)
  await evaluate(`(() => { document.querySelector('.eo-textarea')?.blur(); return true })()`)
  await sleep(300)

  // 2. whiteout: band sampling matches the tint
  await evaluate(`(${E}.setTool('whiteout'), true)`)
  await drag([
    [ov.x + ov.w * 0.3, ov.y + ov.h * 0.4],
    [ov.x + ov.w * 0.55, ov.y + ov.h * 0.47],
  ])
  await sleep(300)
  const wo = await evaluate(`(() => {
    const s = ${E}.sessions['${docId}']
    const list = s.objects.filter(o => o.kind === 'whiteout')
    return JSON.stringify({ fill: list[list.length - 1]?.fill, id: list[list.length - 1]?.id, n: list.length })
  })()`)
  const w = JSON.parse(wo)
  console.log('whiteout fill on tinted page:', w.fill)
  if (!w.fill || !near(w.fill, 219, 232, 247)) fail(`whiteout fill ${w.fill}, expected ~#dbe8f7`)

  // 2b. WHITE text on the BLUE header must retype as WHITE (not sampled as
  // the blue background — the bug where light text vanished on its own colour)
  await evaluate(`(${E}.setTool('retype'), true)`)
  await evaluate(`(() => {
    const el = document.querySelector('.edit-overlay')
    const r = el.getBoundingClientRect()
    const ev = (type) => el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerId: 1, pointerType: 'mouse', pressure: 0.5, buttons: 1,
      clientX: r.left + ${60 / 595} * r.width, clientY: r.top + ${(842 - 775) / 842} * r.height,
    }))
    ev('pointerdown'); ev('pointerup')
    return true
  })()`)
  await waitFor(`${E}.sessions['${docId}'] && ${E}.sessions['${docId}'].editingId`, 'header retype box open')
  const hdr = await evaluate(`(() => {
    const s = ${E}.sessions['${docId}']
    const t = s.objects.find(o => o.id === s.editingId)
    const cover = [...s.objects].reverse().find(o => o.kind === 'whiteout')
    return JSON.stringify({ text: t?.text, color: t?.color, cover: cover?.fill })
  })()`)
  const h = JSON.parse(hdr)
  console.log('white-on-blue header retype:', hdr)
  // ink must be light (near white), NOT the blue background
  const lum = (hex) => { const v = parseInt(hex.slice(1), 16); return 0.299*((v>>16)&255)+0.587*((v>>8)&255)+0.114*(v&255) }
  if (!h.color || lum(h.color) < 180) fail(`header text sampled as ${h.color} (dark) — should be near-white`)
  if (h.cover && lum(h.cover) > 160) fail(`header cover ${h.cover} is too light — should match the blue band`)
  await evaluate(`(() => { document.querySelector('.eo-textarea')?.blur(); return true })()`)
  await sleep(300)
  await evaluate(`(${E}.setTool('whiteout'), true)`)

  // 3. panel override: re-select the step-2 whiteout, then a swatch recolors it
  await evaluate(`(${E}.select('${docId}', '${w.id}'), true)`)
  await sleep(200)
  await evaluate(`(document.querySelectorAll('.color-field')[0].querySelectorAll('.swatch')[0].click(), true)`)
  await sleep(300)
  const overridden = await evaluate(`(() => {
    const s = ${E}.sessions['${docId}']
    return s.objects.find(o => o.id === '${w.id}')?.fill
  })()`)
  console.log('after panel override:', overridden)
  if (overridden === w.fill) fail('panel fill control did not recolor the selected cover')

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
