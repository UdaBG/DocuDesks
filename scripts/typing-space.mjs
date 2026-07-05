// Regression (phone emulation): while a text box is being edited, the
// footer action bar and the bottom nav must yield their vertical space to
// the document; they return when editing commits.
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import electronPath from 'electron'

const SHOT_DIR = path.resolve(process.argv[2] ?? 'e2e-shots')
const PORT = 9255
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
const waitFor = async (expr, label, ms = 30000) => {
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
const E = `window.__editStore.getState()`

try {
  await send('Page.enable')
  // her phone class: 360dp wide, keyboard-open height
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 740, deviceScaleFactor: 3, mobile: true })
  await waitFor(`!!window.__signerStore && !!window.__editStore`, 'stores')
  await waitFor(`${S}.docs.length >= 1`, 'doc loaded')
  await evaluate(`(${S}.setView('edit'), true)`)
  await waitFor(`!!document.querySelector('.edit-overlay')`, 'edit overlay')
  await sleep(500)

  const chrome0 = await evaluate(
    `JSON.stringify({ bar: !!document.querySelector('.actionbar'), nav: !!document.querySelector('.mobile-nav'), stage: Math.round(document.querySelector('.edit-stage').getBoundingClientRect().height) })`,
  )
  console.log('idle chrome:', chrome0)
  // at 360dp the top bar must be ONE row in edit view (brand+lang+toggle);
  // wrapping used to stretch the Sign/Edit toggle into a giant second row
  const topbarH = await evaluate(`Math.round(document.querySelector('.topbar').getBoundingClientRect().height)`)
  console.log('top bar height at 360dp (edit view):', topbarH)
  if (topbarH > 60) fail(`top bar is ${topbarH}px at 360dp — the view toggle wrapped to a second row`)
  await shot('01-360dp-idle.png')

  // open a text box (text tool click on empty area)
  await evaluate(`(${E}.setTool('text'), true)`)
  await evaluate(`(() => {
    const el = document.querySelector('.edit-overlay')
    const r = el.getBoundingClientRect()
    const ev = (type) => el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerId: 1, pointerType: 'mouse', pressure: 0.5, buttons: 1,
      clientX: r.left + 0.4 * r.width, clientY: r.top + 0.4 * r.height,
    }))
    ev('pointerdown'); ev('pointerup')
    return true
  })()`)
  const docId = await evaluate(`${S}.docs[0].id`)
  await waitFor(`${E}.sessions['${docId}'] && ${E}.sessions['${docId}'].editingId`, 'text box open')
  // simulate the keyboard shrinking the viewport as well
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 420, deviceScaleFactor: 3, mobile: true })
  await sleep(700)
  const chrome1 = await evaluate(
    `JSON.stringify({ bar: !!document.querySelector('.actionbar'), nav: !!document.querySelector('.mobile-nav'), pages: !!document.querySelector('.pages-strip'), pill: !!document.querySelector('.zoom-pill'), stage: Math.round(document.querySelector('.edit-stage').getBoundingClientRect().height) })`,
  )
  console.log('typing chrome:', chrome1)
  const c1 = JSON.parse(chrome1)
  if (c1.bar || c1.nav) fail(`footer/nav still visible while typing: ${chrome1}`)
  // floating chrome must hide only when the stage really is a thin strip
  if (c1.stage < 240 && (c1.pages || c1.pill)) {
    fail(`floating chrome still visible in short stage: ${chrome1}`)
  }
  if (c1.stage < 280) fail(`document strip only ${c1.stage}px while typing`)
  await shot('02-360dp-typing.png')

  // type something so the box survives the commit and the footer shows the
  // "Unsaved edits" chip — the state that used to stack it into three rows
  await evaluate(`(() => {
    const inp = document.querySelector('.eo-textarea')
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    set.call(inp, 'Note')
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 740, deviceScaleFactor: 3, mobile: true })
  await evaluate(`(() => { document.querySelector('.eo-textarea')?.blur(); return true })()`)
  await sleep(600)
  const chrome2 = await evaluate(
    `JSON.stringify({ bar: !!document.querySelector('.actionbar'), nav: !!document.querySelector('.mobile-nav'), chip: !!document.querySelector('.chip-amber') })`,
  )
  console.log('committed chrome:', chrome2)
  const c2 = JSON.parse(chrome2)
  if (!c2.bar || !c2.nav) fail(`footer/nav did not return after committing: ${chrome2}`)
  if (!c2.chip) fail('expected the Unsaved edits chip to be visible for this check')
  // footer must be exactly two compact rows — even WITH the edits chip
  const barH = await evaluate(`Math.round(document.querySelector('.actionbar').getBoundingClientRect().height)`)
  console.log('action bar height at 360dp with edits chip:', barH)
  if (barH > 105) fail(`action bar is ${barH}px tall at 360dp with edits — still stacking`)
  await shot('03-360dp-committed.png')

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
