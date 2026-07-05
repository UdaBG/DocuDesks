// Regression (phone emulation): zoomed pages render at device resolution
// (no blur), a stage-height change (keyboard) never rescales the page, and
// the edit canvas pans with two fingers or one finger on the select tool.
// node scripts/mobile-edit-fixes.mjs <shotDir>
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import electronPath from 'electron'

const SHOT_DIR = path.resolve(process.argv[2] ?? 'e2e-shots')
const PORT = 9243
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
const E = `window.__editStore.getState()`

try {
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: 412,
    height: 915,
    deviceScaleFactor: 2,
    mobile: true,
  })
  await waitFor(`!!window.__signerStore && !!window.__editStore`, 'stores')
  await waitFor(`${S}.docs.length >= 1`, 'doc loaded')
  await evaluate(`(${S}.setView('edit'), true)`)
  await waitFor(`!!document.querySelector('.edit-sheet canvas')`, 'edit canvas')
  await sleep(600)

  // ---- 1. sharp zoom: canvas backing resolution tracks devicePixelRatio ---
  for (let i = 0; i < 6; i++) {
    await domClick('.zoom-pill button:last-child')
    await sleep(120)
  }
  await sleep(1200) // settle + crisp re-render
  const res = await evaluate(`(() => {
    const c = document.querySelector('.edit-sheet canvas')
    const r = c.getBoundingClientRect()
    return { backing: c.width, css: Math.round(r.width), dpr: window.devicePixelRatio }
  })()`)
  console.log('zoomed render:', JSON.stringify(res))
  const ratio = res.backing / res.css
  if (ratio < 1.5) fail(`zoomed canvas is low-res: ${ratio.toFixed(2)}x CSS (expected ~devicePixelRatio)`)
  await shot('01-zoom-sharp.png')

  // ---- 2. keyboard resize must not rescale the page ------------------------
  const wBefore = await evaluate(`document.querySelector('.edit-sheet').getBoundingClientRect().width`)
  await send('Emulation.setDeviceMetricsOverride', {
    width: 412,
    height: 520, // an open keyboard shrinks the viewport height
    deviceScaleFactor: 2,
    mobile: true,
  })
  await sleep(900)
  const wAfter = await evaluate(`document.querySelector('.edit-sheet').getBoundingClientRect().width`)
  console.log('sheet width before/after keyboard:', Math.round(wBefore), Math.round(wAfter))
  if (Math.abs(wBefore - wAfter) > 2) fail(`page rescaled on viewport-height change: ${wBefore} -> ${wAfter}`)
  await shot('02-keyboard-height-stable.png')
  await send('Emulation.setDeviceMetricsOverride', {
    width: 412,
    height: 915,
    deviceScaleFactor: 2,
    mobile: true,
  })
  await sleep(600)

  // ---- 3a. two-finger pan (parallel fingers, constant spread) --------------
  const st0 = await evaluate(`document.querySelector('.edit-scroll').scrollTop`)
  await touch('touchStart', [[150, 500], [260, 500]])
  for (let y = 500; y >= 340; y -= 20) {
    await touch('touchMove', [[150, y], [260, y]])
    await sleep(16)
  }
  await touch('touchEnd', [])
  await sleep(200)
  const st1 = await evaluate(`document.querySelector('.edit-scroll').scrollTop`)
  console.log('two-finger pan scrollTop:', st0, '->', st1)
  if (st1 - st0 < 80) fail(`two-finger pan barely moved: ${st0} -> ${st1}`)

  // ---- 3b. one-finger pan with the select tool ------------------------------
  await evaluate(`(${E}.setTool('select'), true)`)
  const p0 = await evaluate(`(() => { const el = document.querySelector('.edit-scroll'); return el.scrollTop })()`)
  await touch('touchStart', [[206, 560]])
  for (let y = 560; y >= 380; y -= 20) {
    await touch('touchMove', [[206, y]])
    await sleep(16)
  }
  await touch('touchEnd', [])
  await sleep(200)
  const p1 = await evaluate(`document.querySelector('.edit-scroll').scrollTop`)
  console.log('select-tool pan scrollTop:', p0, '->', p1)
  if (p1 - p0 < 100) fail(`select-tool one-finger pan barely moved: ${p0} -> ${p1}`)
  await shot('03-panned.png')

  // ---- 3c. pinch spread still zooms ----------------------------------------
  const zBefore = await evaluate(`document.querySelector('.zoom-value').textContent`)
  await touch('touchStart', [[206, 400], [206, 500]])
  for (let s = 0; s <= 80; s += 10) {
    await touch('touchMove', [[206, 400 - s], [206, 500 + s]])
    await sleep(16)
  }
  await touch('touchEnd', [])
  await sleep(500)
  const zAfter = await evaluate(`document.querySelector('.zoom-value').textContent`)
  console.log('pinch zoom:', zBefore, '->', zAfter)
  if (zBefore === zAfter) fail('pinch spread no longer zooms')

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
