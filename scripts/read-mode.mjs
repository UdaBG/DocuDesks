// Regression: Read mode — distraction-free reader on the shared canvas.
// Desktop: view toggle, no panels/action bar, zoom pill + crisp re-render,
// page navigation (buttons + keyboard), unsaved edits composited into the
// preview. Phone: two tabs only, pinch zoom, one-finger pan, tools-tab guard.
//   node scripts/read-mode.mjs <shotDir>
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import electronPath from 'electron'

const SHOT_DIR = path.resolve(process.argv[2] ?? 'e2e-shots')
const PORT = 9272
await mkdir(SHOT_DIR, { recursive: true })

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
const key = async (k, code) => {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: code === 'ArrowRight' ? 39 : 37, nativeVirtualKeyCode: code === 'ArrowRight' ? 39 : 37 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code })
}
const fail = (msg) => {
  console.error('FAIL:', msg)
  process.exitCode = 1
}
const S = `window.__signerStore.getState()`
const E = `window.__editStore.getState()`
/** average luminance of the read canvas (mid-page band) */
const lum = () =>
  evaluate(`(() => {
    const c = document.querySelector('.read-stage canvas')
    if (!c) return -1
    const d = c.getContext('2d').getImageData(0, Math.floor(c.height * 0.2), c.width, Math.floor(c.height * 0.6)).data
    let sum = 0, n = 0
    for (let i = 0; i < d.length; i += 40) { sum += (d[i] + d[i + 1] + d[i + 2]) / 3; n++ }
    return sum / n
  })()`)

try {
  await send('Page.enable')
  await waitFor(`!!window.__signerStore && !!window.__editStore`, 'stores')
  await waitFor(`${S}.docs.length >= 1`, 'doc loaded')

  // ---- 1. desktop: read view is the paper and nothing else ----------------
  await evaluate(`(${S}.setView('read'), true)`)
  await waitFor(`!!document.querySelector('.read-stage canvas')`, 'read canvas')
  await sleep(600)
  const chrome = await evaluate(`(() => ({
    actionbar: !!document.querySelector('.actionbar'),
    rightPanel: !!document.querySelector('.right-panel'),
    toolbar: !!document.querySelector('.edit-toolbar'),
    dataView: document.querySelector('.layout').dataset.view,
    pill: !!document.querySelector('.zoom-pill'),
    nav: !!document.querySelector('.page-nav'),
  }))()`)
  console.log('read chrome:', JSON.stringify(chrome))
  if (chrome.actionbar) fail('action bar still visible in read view')
  if (chrome.rightPanel) fail('right panel still rendered in read view')
  if (chrome.toolbar) fail('edit toolbar leaked into read view')
  if (chrome.dataView !== 'read') fail(`layout data-view is ${chrome.dataView}`)
  if (!chrome.pill || !chrome.nav) fail('zoom pill / page nav missing')
  await shot('r01-read-desktop.png')

  // ---- 2. zoom pill: interim scale then crisp re-render --------------------
  const w0 = await evaluate(`document.querySelector('.zoom-sizer').getBoundingClientRect().width`)
  for (let i = 0; i < 3; i++) {
    await domClick('.zoom-pill button:last-child')
    await sleep(120)
  }
  await sleep(1200) // settle + crisp render
  const zoomed = await evaluate(`(() => {
    const s = document.querySelector('.zoom-sizer').getBoundingClientRect().width
    const c = document.querySelector('.read-stage canvas')
    return { sizer: Math.round(s), pct: document.querySelector('.zoom-value').textContent, backing: c.width, css: Math.round(c.getBoundingClientRect().width) }
  })()`)
  console.log('zoom:', Math.round(w0), '->', JSON.stringify(zoomed))
  if (zoomed.sizer < w0 * 1.5) fail(`zoom did not grow the page: ${w0} -> ${zoomed.sizer}`)
  if (Math.abs(zoomed.backing / zoomed.css - (await evaluate('window.devicePixelRatio'))) > 0.5)
    fail(`zoomed canvas not crisp: backing ${zoomed.backing} vs css ${zoomed.css}`)

  // ---- 3. mouse drag pans the zoomed page ----------------------------------
  const c0 = await evaluate(`(() => { const r = document.querySelector('.read-stage canvas').getBoundingClientRect(); return { x: Math.round(Math.max(r.left + 40, 0) + Math.min(r.width, window.innerWidth - r.left) / 2), y: Math.round(window.innerHeight / 2) } })()`)
  const st0 = await evaluate(`document.querySelector('.read-scroll').scrollTop`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c0.x, y: c0.y, button: 'left', buttons: 1, clickCount: 1 })
  for (let dy = 0; dy <= 140; dy += 20) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c0.x, y: c0.y - dy, button: 'left', buttons: 1 })
    await sleep(16)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c0.x, y: c0.y - 140, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(200)
  const st1 = await evaluate(`document.querySelector('.read-scroll').scrollTop`)
  console.log('mouse-drag pan scrollTop:', st0, '->', st1)
  if (st1 - st0 < 80) fail(`read-view mouse pan barely moved: ${st0} -> ${st1}`)

  // ---- 4. page navigation: buttons + keyboard ------------------------------
  await domClick('.zoom-pill .zoom-value') // reset zoom
  await sleep(900)
  const pages = await evaluate(`${S}.docs[0].pageCount`)
  if (pages < 2) fail(`sample should be multi-page, got ${pages}`)
  await domClick('.page-nav button:last-child')
  await sleep(700)
  const nav1 = await evaluate(`(() => ({ page: ${S}.previewPage, label: document.querySelector('.page-nav span').textContent }))()`)
  console.log('after next:', JSON.stringify(nav1))
  if (nav1.page !== 1) fail(`next button page: ${nav1.page}`)
  await key('ArrowLeft', 'ArrowLeft')
  await sleep(700)
  const nav2 = await evaluate(`${S}.previewPage`)
  console.log('after ArrowLeft:', nav2)
  if (nav2 !== 0) fail(`ArrowLeft did not go back: ${nav2}`)
  await key('ArrowRight', 'ArrowRight')
  await sleep(700)
  if ((await evaluate(`${S}.previewPage`)) !== 1) fail('ArrowRight did not advance')
  await key('ArrowLeft', 'ArrowLeft')
  await sleep(700)

  // ---- 5. unsaved edits show in the reader ---------------------------------
  const before = await lum()
  await evaluate(`(() => {
    const s = ${S}
    const doc = s.docs.find((d) => d.id === s.selectedDocId) ?? s.docs[0]
    window.__editStore.getState().openSession(doc)
    const sess = window.__editStore.getState().sessions[doc.id]
    window.__editStore.getState().addObject(doc.id, {
      id: 'read-test-rect', pageId: sess.pages[0].id, kind: 'rect',
      x: 0, y: 0, w: 1, h: 1, stroke: '#000000', strokeWidthPt: 1, fill: '#000000', opacity: 1,
    })
    return true
  })()`)
  await waitFor(`(() => { const c = document.querySelector('.read-stage canvas'); if (!c) return false
    const d = c.getContext('2d').getImageData(Math.floor(c.width/2), Math.floor(c.height/2), 1, 1).data
    return d[0] < 60 })()`, 'edited preview rendered', 15000)
  const after = await lum()
  console.log('luminance with full-page black rect:', Math.round(before), '->', Math.round(after))
  if (before < 200) fail(`page unexpectedly dark before edit: ${before}`)
  if (after > 60) fail(`edit not composited into read preview: ${after}`)
  await evaluate(`(window.__editStore.getState().removeObject(${S}.docs[0].id, 'read-test-rect'), true)`)
  await sleep(800)

  // ---- 6. phone: two tabs, pinch zoom, one-finger pan ----------------------
  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true })
  await sleep(900)
  const tabs = await evaluate(`document.querySelectorAll('.mobile-tab').length`)
  console.log('mobile tabs in read view:', tabs)
  if (tabs !== 2) fail(`read view should show 2 tabs, got ${tabs}`)
  await shot('r02-read-phone.png')

  const zBefore = await evaluate(`document.querySelector('.zoom-value').textContent`)
  await touch('touchStart', [[206, 400], [206, 500]])
  for (let s = 0; s <= 80; s += 10) {
    await touch('touchMove', [[206, 400 - s], [206, 500 + s]])
    await sleep(16)
  }
  await touch('touchEnd', [])
  await sleep(600)
  const zAfter = await evaluate(`document.querySelector('.zoom-value').textContent`)
  console.log('pinch zoom:', zBefore, '->', zAfter)
  if (zBefore === zAfter) fail('pinch spread does not zoom the reader')

  const p0 = await evaluate(`document.querySelector('.read-scroll').scrollTop`)
  await touch('touchStart', [[206, 560]])
  for (let y = 560; y >= 380; y -= 20) {
    await touch('touchMove', [[206, y]])
    await sleep(16)
  }
  await touch('touchEnd', [])
  await sleep(200)
  const p1 = await evaluate(`document.querySelector('.read-scroll').scrollTop`)
  console.log('one-finger pan scrollTop:', p0, '->', p1)
  if (p1 - p0 < 100) fail(`one-finger pan barely moved: ${p0} -> ${p1}`)

  // ---- 7. tools-tab guard: sigs tab + switch to read -> stage tab ----------
  await evaluate(`(${S}.setView('sign'), true)`)
  await sleep(400)
  await evaluate(`(document.querySelectorAll('.mobile-tab')[2].click(), true)`)
  await sleep(300)
  const tabSigs = await evaluate(`document.querySelector('.layout').dataset.tab`)
  await evaluate(`(${S}.setView('read'), true)`)
  await sleep(400)
  const tabRead = await evaluate(`document.querySelector('.layout').dataset.tab`)
  console.log('tab before/after read switch:', tabSigs, '->', tabRead)
  if (tabRead !== 'sign') fail(`parked on ${tabRead}; expected the stage tab`)

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
