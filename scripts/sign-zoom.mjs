// Regression: the Sign view on the shared canvas — zoom pill with crisp
// re-render, tap-vs-slide on empty paper (tap places at the right fraction
// whatever the zoom, slide pans without placing), stamp drag stays 1:1 with
// the pointer, and phone pinch/pan.
//   node scripts/sign-zoom.mjs <shotDir>
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import electronPath from 'electron'

const SHOT_DIR = path.resolve(process.argv[2] ?? 'e2e-shots')
const PORT = 9273
await mkdir(SHOT_DIR, { recursive: true })

const sample = path.resolve('samples', 'Leave_Request_Amara_Perera.pdf')
const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, sample], {
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
const domClick = (sel) => evaluate(`(document.querySelector('${sel}').click(), true)`)
const touch = (type, points) =>
  send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y]) => ({ x, y })) })
const fail = (msg) => {
  console.error('FAIL:', msg)
  process.exitCode = 1
}
const S = `window.__signerStore.getState()`
// press + release on the gesture overlay at a page fraction (placement
// defers to pointerup)
const tapSheet = (fx, fy) => `(() => {
  const sheet = document.querySelector('.sign-overlay')
  const r = sheet.getBoundingClientRect()
  const opts = { bubbles: true, clientX: r.left + ${fx} * r.width, clientY: r.top + ${fy} * r.height,
    button: 0, buttons: 1, isPrimary: true, pointerId: 991, pointerType: 'mouse' }
  sheet.dispatchEvent(new PointerEvent('pointerdown', opts))
  sheet.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }))
  return true
})()`

try {
  await send('Page.enable')
  await waitFor(`!!window.__signerStore`, 'store')
  await waitFor(`${S}.docs.length >= 1`, 'doc loaded')
  await evaluate(`(${S}.setView('sign'), true)`) // the app now opens in Read
  await evaluate(`(() => {
    const c = document.createElement('canvas'); c.width = 400; c.height = 200
    const ctx = c.getContext('2d'); ctx.strokeStyle = '#26357c'; ctx.lineWidth = 8; ctx.lineCap = 'round'
    ctx.beginPath(); ctx.moveTo(40, 160); ctx.bezierCurveTo(120, 20, 200, 180, 360, 40); ctx.stroke()
    ${S}.addSignature({ name: 'Zoom Test', dataUrl: c.toDataURL('image/png'), width: 400, height: 200 })
    return true
  })()`)
  await evaluate(`(${S}.setMode('manual'), true)`)
  await waitFor(`!!document.querySelector('.sign-scroll .sheet canvas')`, 'sign canvas')
  await sleep(600)

  // ---- 1. clean tap places at the tap point --------------------------------
  await evaluate(tapSheet(0.5, 0.5))
  await sleep(300)
  const s1 = await evaluate(`${S}.extraStamps[0]?.placement`)
  if (!s1) fail('tap on paper did not place a stamp')
  else {
    const centerX = s1.x + s1.w / 2
    console.log('tap placed stamp center x:', centerX.toFixed(3))
    if (Math.abs(centerX - 0.5) > 0.02) fail(`stamp center off tap point: ${centerX}`)
  }

  // ---- 2. zoom pill grows the page, render stays crisp ----------------------
  const w0 = await evaluate(`document.querySelector('.zoom-sizer').getBoundingClientRect().width`)
  for (let i = 0; i < 3; i++) {
    await domClick('.zoom-pill button:last-child')
    await sleep(120)
  }
  await sleep(1200)
  const z = await evaluate(`(() => {
    const s = document.querySelector('.zoom-sizer').getBoundingClientRect().width
    const c = document.querySelector('.sign-scroll .sheet canvas')
    return { sizer: Math.round(s), backing: c.width, css: Math.round(c.getBoundingClientRect().width), dpr: window.devicePixelRatio }
  })()`)
  console.log('zoom:', Math.round(w0), '->', JSON.stringify(z))
  if (z.sizer < w0 * 1.5) fail(`zoom did not grow the page: ${w0} -> ${z.sizer}`)
  if (Math.abs(z.backing / z.css - z.dpr) > 0.5) fail(`zoomed sign canvas not crisp: ${z.backing} vs ${z.css}`)
  await shot('s01-sign-zoomed.png')

  // ---- 3. tap while zoomed still lands on the right page fraction ----------
  await evaluate(tapSheet(0.25, 0.25))
  await sleep(300)
  const s2 = await evaluate(`${S}.extraStamps[1]?.placement`)
  if (!s2) fail('zoomed tap did not place a stamp')
  else {
    const centerX = s2.x + s2.w / 2
    console.log('zoomed tap stamp center x:', centerX.toFixed(3))
    if (Math.abs(centerX - 0.25) > 0.02) fail(`zoomed placement off: ${centerX}`)
  }

  // ---- 4. mouse drag on empty paper pans, never places ----------------------
  await evaluate(`(() => { const el = document.querySelector('.sign-scroll'); el.scrollLeft = el.scrollWidth; el.scrollTop = el.scrollHeight; return true })()`)
  await sleep(200)
  const stamps0 = await evaluate(`${S}.extraStamps.length`)
  const pan0 = await evaluate(`document.querySelector('.sign-scroll').scrollTop`)
  const mid = await evaluate(`(() => { const r = document.querySelector('.sign-scroll').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mid.x, y: mid.y, button: 'left', buttons: 1, clickCount: 1 })
  for (let dy = 0; dy <= 120; dy += 20) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mid.x, y: mid.y + dy, button: 'left', buttons: 1 })
    await sleep(16)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mid.x, y: mid.y + 120, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(200)
  const pan1 = await evaluate(`document.querySelector('.sign-scroll').scrollTop`)
  const stamps1 = await evaluate(`${S}.extraStamps.length`)
  console.log('empty-paper drag: scrollTop', pan0, '->', pan1, '| stamps', stamps0, '->', stamps1)
  if (pan0 - pan1 < 80) fail(`drag on empty paper did not pan: ${pan0} -> ${pan1}`)
  if (stamps1 !== stamps0) fail('a pan drag placed a stamp')

  // ---- 5. stamp drag stays 1:1 with the pointer at committed zoom ----------
  const W = await evaluate(`document.querySelector('.sign-scroll .sheet').getBoundingClientRect().width`)
  const xA = await evaluate(`${S}.extraStamps[0].placement.x`)
  await evaluate(`(() => {
    const el = document.querySelector('.sig-box.extra')
    const r = el.getBoundingClientRect()
    const ev = (type, dx, buttons) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 992, buttons, isPrimary: true, clientX: r.left + 10 + dx, clientY: r.top + 10 }))
    ev('pointerdown', 0, 1); ev('pointermove', 30, 1); ev('pointermove', 60, 1); ev('pointerup', 60, 0)
    return true
  })()`)
  await sleep(250)
  const xB = await evaluate(`${S}.extraStamps[0].placement.x`)
  const dxFrac = xB - xA
  console.log('stamp drag 60px ->', dxFrac.toFixed(4), 'expected', (60 / W).toFixed(4))
  if (Math.abs(dxFrac - 60 / W) > 0.01) fail(`stamp drag not 1:1: moved ${dxFrac}, expected ${60 / W}`)

  // ---- 6. phone: pinch zoom + one-finger pan --------------------------------
  await domClick('.zoom-pill .zoom-value') // reset zoom
  await sleep(900)
  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true })
  await sleep(900)
  const zBefore = await evaluate(`document.querySelector('.zoom-value').textContent`)
  await touch('touchStart', [[206, 400], [206, 500]])
  for (let s = 0; s <= 80; s += 10) {
    await touch('touchMove', [[206, 400 - s], [206, 500 + s]])
    await sleep(16)
  }
  await touch('touchEnd', [])
  await sleep(600)
  const zAfter = await evaluate(`document.querySelector('.zoom-value').textContent`)
  console.log('phone pinch zoom:', zBefore, '->', zAfter)
  if (zBefore === zAfter) fail('pinch spread does not zoom the sign view')

  const stampsP = await evaluate(`${S}.extraStamps.length`)
  const t0 = await evaluate(`document.querySelector('.sign-scroll').scrollTop`)
  await touch('touchStart', [[300, 640]])
  for (let y = 640; y >= 460; y -= 20) {
    await touch('touchMove', [[300, y]])
    await sleep(16)
  }
  await touch('touchEnd', [])
  await sleep(200)
  const t1 = await evaluate(`document.querySelector('.sign-scroll').scrollTop`)
  const stampsQ = await evaluate(`${S}.extraStamps.length`)
  console.log('phone one-finger pan scrollTop:', t0, '->', t1, '| stamps', stampsP, '->', stampsQ)
  if (t1 - t0 < 100) fail(`phone pan barely moved: ${t0} -> ${t1}`)
  if (stampsQ !== stampsP) fail('a phone pan placed a stamp')
  await shot('s02-sign-phone.png')

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
