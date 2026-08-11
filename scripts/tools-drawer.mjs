// Regression: on phones the edit Tools panel is a slide-in drawer over the
// document (not a page swap). Toggle from the nav tab, close via the veil or
// the Android back button; the document stays visible underneath. Desktop
// keeps the plain grid column.
//   node scripts/tools-drawer.mjs
import { spawn } from 'node:child_process'
import path from 'node:path'
import electronPath from 'electron'

const PORT = 9281
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
const fail = (msg) => {
  console.error('FAIL:', msg)
  process.exitCode = 1
}
const S = `window.__signerStore.getState()`
const drawerState = () =>
  evaluate(`(() => {
    const host = document.querySelector('.tools-host')
    const canvas = document.querySelector('.edit-sheet canvas')
    return {
      open: !!host && host.classList.contains('open'),
      veil: !!document.querySelector('.drawer-veil'),
      panelVisible: !!host && host.getBoundingClientRect().right > 0 && getComputedStyle(host).transform !== 'none' ? host.getBoundingClientRect().left < window.innerWidth - 10 : false,
      stageCanvas: !!canvas && canvas.getBoundingClientRect().width > 50,
    }
  })()`)

try {
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true })
  await waitFor(`!!window.__signerStore`, 'store')
  await waitFor(`${S}.docs.length >= 1`, 'doc')
  await evaluate(`(${S}.setView('edit'), true)`)
  await waitFor(`!!document.querySelector('.edit-sheet canvas')`, 'edit canvas')
  await sleep(500)

  // ---- 1. Tools tab opens the drawer; the document stays visible ----------
  const tabs = await evaluate(`document.querySelectorAll('.mobile-tab').length`)
  if (tabs !== 3) fail(`edit view should show 3 tabs, got ${tabs}`)
  await evaluate(`(document.querySelectorAll('.mobile-tab')[2].click(), true)`)
  await sleep(400)
  const open = await drawerState()
  console.log('after Tools tap:', JSON.stringify(open))
  if (!open.open || !open.veil) fail('drawer did not open')
  if (!open.panelVisible) fail('drawer panel not visible on screen')
  if (!open.stageCanvas) fail('the document disappeared behind the drawer')

  // ---- 2. veil tap closes ---------------------------------------------------
  await evaluate(`(document.querySelector('.drawer-veil').click(), true)`)
  await sleep(400)
  const closed = await drawerState()
  console.log('after veil tap:', JSON.stringify(closed))
  if (closed.open || closed.veil) fail('veil tap did not close the drawer')

  // ---- 3. Android back closes it -------------------------------------------
  await evaluate(`(document.querySelectorAll('.mobile-tab')[2].click(), true)`)
  await sleep(400)
  const backResult = await evaluate(`window.__handleBackButton()`)
  await sleep(400)
  const afterBack = await drawerState()
  console.log('back button:', backResult, JSON.stringify(afterBack))
  if (backResult !== 'handled') fail(`back should handle the drawer, got ${backResult}`)
  if (afterBack.open) fail('back button did not close the drawer')

  // ---- 4. desktop: plain grid column, no drawer chrome ----------------------
  await send('Emulation.clearDeviceMetricsOverride')
  await sleep(700)
  const desktop = await evaluate(`(() => {
    const host = document.querySelector('.tools-host')
    const panel = document.querySelector('.tools-host .right-panel')
    return {
      contents: host ? getComputedStyle(host).display : null,
      panelW: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
    }
  })()`)
  console.log('desktop:', JSON.stringify(desktop))
  if (desktop.contents !== 'contents') fail(`desktop host should be display:contents, got ${desktop.contents}`)
  if (desktop.panelW < 200) fail(`desktop tools panel missing from the grid (width ${desktop.panelW})`)

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
