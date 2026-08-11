// Regression: the view must not jump when the crisp re-render replaces the
// interim CSS scale. Phone metrics, read view: pinch/pill-zoom through the
// fit boundary in several patterns and assert the content point at the
// viewport center stays put (within tolerance) across the settle+commit.
//   node scripts/zoom-anchor.mjs
import { spawn } from 'node:child_process'
import path from 'node:path'
import electronPath from 'electron'

const PORT = 9277
const sample = path.resolve('samples', 'Service_Agreement.pdf')
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
const touch = (type, points) =>
  send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y]) => ({ x, y })) })
const fail = (msg) => {
  console.error('FAIL:', msg)
  process.exitCode = 1
}
const S = `window.__signerStore.getState()`
/** content point (page fraction) currently under the viewport center */
const centerPoint = () =>
  evaluate(`(() => {
    const el = document.querySelector('.read-scroll')
    const sheet = document.querySelector('.read-scroll .edit-sheet')
    if (!el || !sheet) return null
    const er = el.getBoundingClientRect()
    const sr = sheet.getBoundingClientRect()
    return {
      fx: (er.left + er.width / 2 - sr.left) / sr.width,
      fy: (er.top + er.height / 2 - sr.top) / sr.height,
      sheetW: Math.round(sr.width),
      scrollLeft: Math.round(el.scrollLeft),
      scrollTop: Math.round(el.scrollTop),
      zoom: document.querySelector('.zoom-value').textContent,
    }
  })()`)

async function pinch(cx, cy, d0, d1, steps = 8) {
  const a0 = d0 / 2
  await touch('touchStart', [[cx, cy - a0], [cx, cy + a0]])
  for (let i = 1; i <= steps; i++) {
    const a = (d0 + ((d1 - d0) * i) / steps) / 2
    await touch('touchMove', [[cx, cy - a], [cx, cy + a]])
    await sleep(16)
  }
  await touch('touchEnd', [])
}

async function checkStable(label, tolerance = 0.04) {
  const before = await centerPoint()
  await sleep(2500) // settle (180ms) + debounce (50ms) + render + margin
  const after = await centerPoint()
  const dx = Math.abs(after.fx - before.fx)
  const dy = Math.abs(after.fy - before.fy)
  console.log(
    `${label}: pre-commit (${before.fx.toFixed(3)}, ${before.fy.toFixed(3)}) @${before.zoom} -> post (${after.fx.toFixed(3)}, ${after.fy.toFixed(3)}) @${after.zoom} | drift (${dx.toFixed(3)}, ${dy.toFixed(3)})`,
  )
  if (dx > tolerance || dy > tolerance) fail(`${label}: view jumped by (${dx.toFixed(3)}, ${dy.toFixed(3)}) page fractions`)
  return after
}

try {
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true })
  await waitFor(`!!window.__signerStore`, 'store')
  await waitFor(`${S}.docs.length >= 1`, 'doc loaded')
  await evaluate(`(${S}.setView('read'), true)`)
  await waitFor(`!!document.querySelector('.read-stage canvas')`, 'read canvas')
  await sleep(800)

  // ---- A. pill-zoom out to 50%, pinch IN across the fit boundary ----------
  await evaluate(`(document.querySelector('.zoom-pill button:first-child').click(), true)`)
  await sleep(300)
  await evaluate(`(document.querySelector('.zoom-pill button:first-child').click(), true)`)
  await sleep(300)
  await evaluate(`(document.querySelector('.zoom-pill button:first-child').click(), true)`)
  await sleep(1500)
  console.log('zoomed out to:', await evaluate(`document.querySelector('.zoom-value').textContent`))
  await pinch(206, 450, 100, 290) // ~2.9x spread, crosses fit going up
  await checkStable('A. pinch in across fit')

  // ---- B. pinch further in, anchored off-center ----------------------------
  await pinch(300, 600, 100, 200)
  await checkStable('B. pinch in off-center')

  // ---- C. pinch OUT back across the fit boundary ---------------------------
  await pinch(206, 450, 240, 110)
  await checkStable('C. pinch out across fit')

  // ---- D. rapid pill steps (wheel-style zoom) then settle -------------------
  for (let i = 0; i < 4; i++) {
    await evaluate(`(document.querySelector('.zoom-pill button:last-child').click(), true)`)
    await sleep(90)
  }
  await checkStable('D. rapid pill zoom-in')

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
