// Regression: the sign-view date stamp. Add via the pill (selects + opens the
// style drawer), restyle (format/color re-render the image), drag like any
// stamp, composite into the Read preview, ghost in Edit, land in the signed
// output, and remember the style across... the session (settings write).
//   node scripts/date-stamp.mjs
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import electronPath from 'electron'

const OUT = path.resolve('e2e-out-date')
const PORT = 9284
await mkdir(OUT, { recursive: true })
const sample = path.resolve('samples', 'Service_Agreement.pdf')
const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, sample], {
  stdio: 'ignore',
  env: { ...process.env, VITE_DEV_SERVER_URL: '', SIGNER_OUTPUT_DIR: OUT },
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
const fail = (msg) => {
  console.error('FAIL:', msg)
  process.exitCode = 1
}
const S = `window.__signerStore.getState()`

try {
  await send('Page.enable')
  await waitFor(`!!window.__signerStore`, 'store')
  await waitFor(`${S}.docs.length >= 1`, 'doc loaded')
  await evaluate(`(${S}.setView('sign'), true)`)
  await evaluate(`(${S}.setMode('manual'), true)`)
  await waitFor(`!!document.querySelector('.sign-scroll .sheet canvas')`, 'sign canvas')
  await sleep(500)

  // ---- 1. the pill adds today's date, selected, drawer open ----------------
  await evaluate(`(document.querySelector('.date-add-pill').click(), true)`)
  await waitFor(`${S}.dateStamps.length === 1`, 'date stamp added')
  const first = await evaluate(`(() => { const d = ${S}.dateStamps[0]; return { id: d.id, format: d.format, w: d.width, dataLen: d.dataUrl.length, selected: ${S}.selectedStampId === d.id } })()`)
  console.log('added:', JSON.stringify(first))
  if (!first.selected) fail('fresh date stamp should be selected')
  await waitFor(`!!document.querySelector('.date-drawer')`, 'style drawer open')
  await waitFor(`!!document.querySelector('.sig-box.date-stamp img')`, 'date stamp on the paper')

  // ---- 2. restyle: format + color re-render the image ----------------------
  // the persisted dateStyle seeds the fresh stamp (this very machine may
  // carry one from earlier runs) — pick a format that DIFFERS from it
  const targetIdx = first.format === 'long' ? 3 : 4 // iso vs long
  const targetFmt = first.format === 'long' ? 'iso' : 'long'
  await evaluate(`(document.querySelectorAll('.date-format')[${targetIdx}].click(), true)`)
  await waitFor(`${S}.dateStamps[0].format === '${targetFmt}'`, 'format applied')
  const afterFormat = await evaluate(`(() => { const d = ${S}.dateStamps[0]; return { w: d.width, dataLen: d.dataUrl.length } })()`)
  console.log(`after ${targetFmt} format:`, JSON.stringify(afterFormat))
  if (afterFormat.dataLen === first.dataLen) fail('format change did not re-render the image')
  await evaluate(`(document.querySelectorAll('.date-colors .color-chip')[2].click(), true)`)
  await waitFor(`${S}.dateStamps[0].color === '#2f45c4'`, 'color applied')
  const savedStyle = await evaluate(`window.signer.loadSettings().then((s) => s.dateStyle)`)
  console.log('persisted style:', JSON.stringify(savedStyle))
  if (!savedStyle || savedStyle.format !== targetFmt) fail('date style not persisted to settings')

  // ---- 3. veil closes the drawer; drag moves the stamp ----------------------
  await evaluate(`(document.querySelector('.drawer-veil').click(), true)`)
  await sleep(300)
  if (await evaluate(`!!document.querySelector('.date-drawer')`)) fail('veil did not close the drawer')
  const x0 = await evaluate(`${S}.dateStamps[0].placement.x`)
  await evaluate(`(() => {
    const el = document.querySelector('.sig-box.date-stamp')
    const r = el.getBoundingClientRect()
    const ev = (type, dx, buttons) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 993, buttons, isPrimary: true, clientX: r.left + 8 + dx, clientY: r.top + 8 }))
    ev('pointerdown', 0, 1); ev('pointermove', 25, 1); ev('pointermove', 50, 1); ev('pointerup', 50, 0)
    return true
  })()`)
  await sleep(250)
  const x1 = await evaluate(`${S}.dateStamps[0].placement.x`)
  console.log('drag: x', x0.toFixed(3), '->', x1.toFixed(3))
  if (Math.abs(x1 - x0) < 0.02) fail('date stamp did not move')

  // ---- 3b. the image never escapes its box, however small the zoom ---------
  // (inline imgs ride a text baseline: thin date strips overflowed below it)
  for (let i = 0; i < 3; i++) {
    await evaluate(`(document.querySelector('.zoom-pill button:first-child').click(), true)`)
    await sleep(400)
  }
  await sleep(1200)
  const contain = await evaluate(`(() => {
    const box = document.querySelector('.sig-box.date-stamp').getBoundingClientRect()
    const img = document.querySelector('.sig-box.date-stamp img').getBoundingClientRect()
    return { oy: +(img.bottom - box.bottom).toFixed(1), ox: +(img.right - box.right).toFixed(1), boxH: +box.height.toFixed(1) }
  })()`)
  console.log('zoomed-out containment:', JSON.stringify(contain))
  if (contain.oy > 0.5 || contain.ox > 0.5) fail(`date image escapes its box when zoomed out (${JSON.stringify(contain)})`)
  await evaluate(`(document.querySelector('.zoom-pill .zoom-value').click(), true)`)
  await sleep(1000)

  // ---- 4. read view composites the date -------------------------------------
  // park the stamp over a known-empty region, then sample it in Read
  await evaluate(`(${S}.updateDateStamp(${S}.dateStamps[0].id, { x: 0.36, yb: 0.56, w: 0.26 }), true)`)
  await evaluate(`(${S}.setView('read'), true)`)
  await waitFor(`!!document.querySelector('.read-stage canvas')`, 'read canvas')
  await waitFor(`(() => {
    const c = document.querySelector('.read-stage canvas')
    if (!c) return false
    const x = Math.floor(c.width * 0.36), w = Math.floor(c.width * 0.26)
    const y = Math.floor(c.height * 0.50), h = Math.floor(c.height * 0.07)
    const d = c.getContext('2d').getImageData(x, y, w, h).data
    let dark = 0
    for (let i = 0; i < d.length; i += 16) { if ((d[i] + d[i + 1] + d[i + 2]) / 3 < 150) dark++ }
    return dark > 20
  })()`, 'date visible in read preview', 15000)
  console.log('date composites into the read preview')

  // ---- 5. edit view shows the ghost -----------------------------------------
  await evaluate(`(${S}.setView('edit'), true)`)
  await waitFor(`!!document.querySelector('.edit-sheet canvas')`, 'edit canvas')
  await waitFor(`!!document.querySelector('.stamp-ghosts img')`, 'ghost in edit view')
  console.log('ghost visible in edit view')

  // ---- 6. the signed output carries the date --------------------------------
  await evaluate(`(${S}.setView('sign'), true)`)
  await sleep(400)
  await evaluate(`${S}.signAll()`)
  await waitFor(`!!${S}.result`, 'signAll finished', 30000)
  const result = await evaluate(`${S}.result`)
  console.log('sign result:', JSON.stringify({ signed: result.signed, first: result.firstPath }))
  if (result.signed !== 1) fail(`expected 1 signed doc, got ${result.signed}`)
  if (!existsSync(result.firstPath)) fail('signed output missing on disk')
  const probe = await evaluate(`window.__renderProbe(${JSON.stringify(result.firstPath)}, 0)`)
  console.log('signed output renders, ink:', JSON.stringify(probe))

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
