// Quick check: the Licenses/Attributions modal opens from the top bar and
// shows the component list plus the full license texts.
// node scripts/licenses-check.mjs
import { spawn } from 'node:child_process'
import path from 'node:path'
import electronPath from 'electron'

const PORT = 9279
const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], {
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

try {
  await send('Page.enable')
  await waitFor(`!!document.querySelector('.topbar-info')`, 'info button')
  await evaluate(`(document.querySelector('.topbar-info').click(), true)`)
  await waitFor(`!!document.querySelector('.modal.licenses')`, 'licenses modal open')
  const info = await evaluate(`(() => {
    const items = document.querySelectorAll('.lic-list li').length
    const texts = document.querySelectorAll('.lic-text summary').length
    const hasOFL = [...document.querySelectorAll('.lic-text summary')].some(s => /Open Font/i.test(s.textContent))
    const hasApache = [...document.querySelectorAll('.lic-text summary')].some(s => /Apache/i.test(s.textContent))
    const hasQpdf = [...document.querySelectorAll('.lic-name')].some(n => /qpdf/i.test(n.textContent))
    const overflow = document.documentElement.scrollWidth <= window.innerWidth + 1
    return { items, texts, hasOFL, hasApache, hasQpdf, noOverflow: overflow }
  })()`)
  console.log('licenses modal:', JSON.stringify(info))
  if (info.items < 15) fail(`expected the full component list, got ${info.items}`)
  if (info.texts < 3) fail(`expected 3 license texts, got ${info.texts}`)
  if (!info.hasOFL) fail('OFL license text missing')
  if (!info.hasApache) fail('Apache license text missing')
  if (!info.hasQpdf) fail('qpdf attribution missing')

  // close on veil click
  await evaluate(`(document.querySelector('.modal-veil').click(), true)`)
  await waitFor(`!document.querySelector('.modal.licenses')`, 'modal closes')
  console.log('modal closes on veil click')

  // phone: the top-bar button is hidden (no room at 360dp) and the Documents
  // panel head carries it instead
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 2, mobile: true })
  await sleep(600)
  const mobile = await evaluate(`(() => {
    const top = document.querySelector('.topbar-info')
    const hidden = !top || getComputedStyle(top).display === 'none'
    const inDocs = !!document.querySelector('.docs-panel .panel-head .icon-btn')
    return JSON.stringify({ hidden, inDocs })
  })()`)
  console.log('mobile placement:', mobile)
  const m = JSON.parse(mobile)
  if (!m.hidden) fail('top-bar licenses button should hide at 360dp')
  if (!m.inDocs) fail('licenses button missing from the Documents panel head on mobile')
  await evaluate(`(document.querySelector('.docs-panel .panel-head .icon-btn').click(), true)`)
  await waitFor(`!!document.querySelector('.modal.licenses')`, 'licenses modal opens on mobile')
  console.log('licenses modal opens from the Documents panel on mobile')

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
