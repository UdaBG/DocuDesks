// Regression (phone emulation):
//  A) a very long file name no longer stretches the app past the viewport;
//     the name ellipsises inside the doc list.
//  B) the unlock prompt now appears in the Sign view for a protected doc
//     (previously only in Edit), so signing a protected PDF isn't a dead end.
// node scripts/unlock-longname.mjs
import { spawn } from 'node:child_process'
import path from 'node:path'
import electronPath from 'electron'

const PORT = 9277
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
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800))
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
const LONG = 'Acc_Statement_1680003016084_2026-06-01_2026-06-25_1234567890_final_version.pdf'

try {
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true })
  await waitFor(`!!window.__signerStore`, 'store')
  await waitFor(`${S}.docs.length >= 1`, 'doc')

  // A. give the doc a very long name and confirm the layout stays within the
  // viewport and the name is visually truncated
  await evaluate(`(window.__signerStore.setState((s) => ({ docs: s.docs.map((d) => ({ ...d, name: ${JSON.stringify(LONG)} })) })), true)`)
  // make sure the Documents tab is showing so the doc list is laid out
  await evaluate(`(document.querySelector('.mobile-nav .mobile-tab')?.click(), true)`)
  await waitFor(`getComputedStyle(document.querySelector('.docs-panel')).display !== 'none'`, 'docs panel visible')
  await sleep(300)
  const m = await evaluate(`(() => {
    const vw = window.innerWidth
    const appW = document.querySelector('.app').getBoundingClientRect().width
    const bodyScroll = document.documentElement.scrollWidth
    const nm = document.querySelector('.doc-name')
    const panel = document.querySelector('.docs-panel')
    return {
      vw, appW, bodyScroll,
      panelDisplay: panel ? getComputedStyle(panel).display : null,
      nameClient: nm ? nm.clientWidth : null,
      nameScroll: nm ? nm.scrollWidth : null,
      nameClipped: nm ? nm.scrollWidth > nm.clientWidth + 1 : null,
    }
  })()`)
  console.log('layout:', JSON.stringify(m))
  if (m.appW > m.vw + 1) fail(`app is wider than the viewport (${m.appW} > ${m.vw})`)
  if (m.bodyScroll > m.vw + 1) fail(`page overflows horizontally (scrollWidth ${m.bodyScroll} > ${m.vw})`)
  if (m.nameClipped !== true) fail(`long name is not truncated (ellipsis not active)`)
  console.log('long name is truncated and the layout fits the viewport')

  // B. mark the doc protected, go to Sign view — the unlock prompt must appear
  await evaluate(`(window.__signerStore.setState((s) => ({ docs: s.docs.map((d) => ({ ...d, encrypted: true })) })), true)`)
  await evaluate(`(${S}.setView('sign'), true)`)
  await waitFor(`!!document.querySelector('.modal-veil .confirm-dialog')`, 'unlock prompt in sign view')
  const title = await evaluate(`document.querySelector('.modal-veil .confirm-dialog h2')?.textContent || ''`)
  console.log('sign-view unlock prompt shown:', JSON.stringify(title))
  if (!/protect/i.test(title)) fail(`unexpected dialog in sign view: ${title}`)

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
