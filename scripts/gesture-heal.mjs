// Regression (phone emulation): text/retype tap-vs-slide, and self-healing of
// touch-gesture state so a lost pointerup can't leave the app stuck zooming.
//   node scripts/gesture-heal.mjs <shotDir>
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import electronPath from 'electron'

const SHOT_DIR = path.resolve(process.argv[2] ?? 'e2e-shots')
const PORT = 9263
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
const waitFor = async (expr, label, ms = 20000) => {
  const start = Date.now()
  for (;;) {
    if (await evaluate(expr)) return
    if (Date.now() - start > ms) throw new Error('timeout: ' + label)
    await sleep(300)
  }
}
const touch = (type, pts) =>
  send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y]) => ({ x, y })) })
const rectOf = (sel) =>
  evaluate(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })()`)
const fail = (msg) => {
  console.error('FAIL:', msg)
  process.exitCode = 1
}
const S = `window.__signerStore.getState()`
const E = `window.__editStore.getState()`

try {
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true })
  await waitFor(`!!window.__signerStore && !!window.__editStore`, 'stores')
  await waitFor(`${S}.docs.length >= 1`, 'doc')
  await evaluate(`(${S}.setView('edit'), true)`)
  await waitFor(`!!document.querySelector('.edit-overlay')`, 'edit overlay')
  await sleep(500)
  const docId = await evaluate(`${S}.docs[0].id`)
  await evaluate(`(${E}.setTool('text'), true)`)
  // zoom in so there is room to pan
  await evaluate(`(document.querySelector('.zoom-pill button:last-child').click(), true)`)
  await sleep(200)
  await evaluate(`(document.querySelector('.zoom-pill button:last-child').click(), true)`)
  await sleep(900)
  const ov = await rectOf('.edit-overlay')

  // 1. SLIDE with retype tool = pan, NOT a box and NOT a zoom
  const z0 = await evaluate(`document.querySelector('.zoom-value').textContent`)
  const st0 = await evaluate(`document.querySelector('.edit-scroll').scrollTop`)
  await touch('touchStart', [[ov.x + ov.w * 0.5, ov.y + ov.h * 0.6]])
  for (let dy = 0; dy <= 160; dy += 20) {
    await touch('touchMove', [[ov.x + ov.w * 0.5, ov.y + ov.h * 0.6 - dy]])
    await sleep(16)
  }
  await touch('touchEnd', [])
  await sleep(300)
  const z1 = await evaluate(`document.querySelector('.zoom-value').textContent`)
  const st1 = await evaluate(`document.querySelector('.edit-scroll').scrollTop`)
  const boxesAfterSlide = await evaluate(`${E}.sessions['${docId}'] ? ${E}.sessions['${docId}'].objects.length : 0`)
  console.log(`slide: zoom ${z0}->${z1}, scrollTop ${st0}->${st1}, boxes=${boxesAfterSlide}`)
  if (z0 !== z1) fail(`one-finger slide changed zoom (${z0}->${z1}) â€” should pan`)
  if (st1 - st0 < 60) fail(`one-finger slide did not pan (scrollTop ${st0}->${st1})`)
  if (boxesAfterSlide !== 0) fail(`slide opened a box (${boxesAfterSlide}) â€” should only pan`)

  // 2. CLEAN TAP with retype tool = open a retype box
  await touch('touchStart', [[ov.x + ov.w * 0.4, ov.y + ov.h * 0.28]])
  await sleep(30)
  await touch('touchEnd', [])
  await waitFor(`${E}.sessions['${docId}'] && ${E}.sessions['${docId}'].editingId`, 'clean tap opened retype box')
  console.log('clean tap opened a retype box')
  await evaluate(`(() => { document.querySelector('.eo-textarea')?.blur(); return true })()`)
  await sleep(300)

  // 3. SELF-HEAL: a lost pointerup (stale touch) must not stick the app in
  // pinch mode. Inject a touch pointerdown on the scroll container, then fire
  // the release only on WINDOW (as if the element handler missed it).
  await evaluate(`(() => {
    const el = document.querySelector('.edit-scroll')
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 99, pointerType: 'touch', clientX: 200, clientY: 400 }))
    return true
  })()`)
  const stuck = await evaluate(`window.__editGestureDebug().touches`)
  console.log('touches after injected orphan down:', stuck)
  // the window release listener should prune it
  await evaluate(`(window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 99, pointerType: 'touch' })), true)`)
  const healed = await evaluate(`JSON.stringify(window.__editGestureDebug())`)
  console.log('gesture state after window release:', healed)
  const g = JSON.parse(healed)
  if (g.touches !== 0 || g.pinch) fail(`stale touch not healed: ${healed}`)

  // 4. retype still works after the heal (the old bug blocked it entirely)
  await evaluate(`(${E}.setTool('text'), true)`)
  await touch('touchStart', [[ov.x + ov.w * 0.4, ov.y + ov.h * 0.45]])
  await sleep(30)
  await touch('touchEnd', [])
  await waitFor(`${E}.sessions['${docId}'] && ${E}.sessions['${docId}'].editingId`, 'retype works after heal')
  console.log('retype works after heal')

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}

