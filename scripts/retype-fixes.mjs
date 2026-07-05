// Regression: thin-text retype color fidelity, empty-retype = delete line,
// and edit-view zoom.
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import electronPath from 'electron'

const SHOT_DIR = path.resolve(process.argv[2] ?? 'e2e-shots')
const PORT = 9240
await mkdir(SHOT_DIR, { recursive: true })
const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, path.resolve('samples/Reference_Letter.pdf')], {
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
const S = () => `window.__signerStore.getState()`
const E = () => `window.__editStore.getState()`
const clickOverlay = (fx, fy) => `(() => {
  const el = document.querySelector('.edit-overlay')
  const r = el.getBoundingClientRect()
  const ev = (type) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, buttons: 1, clientX: r.left + ${fx} * r.width, clientY: r.top + ${fy} * r.height }))
  ev('pointerdown'); ev('pointerup')
  return true
})()`

await send('Page.enable')
await waitFor(`!!window.__signerStore && !!window.__editStore`, 'stores')
await waitFor(`${S()}.docs.length >= 1`, 'doc')
const docId = await evaluate(`${S()}.docs[0].id`)
await evaluate(`(${S()}.setView('edit'), true)`)
await waitFor(`!!document.querySelector('.canvas-holder canvas')`, 'rendered')

// 1. thin body text keeps its ink color (was going grey)
await evaluate(`(${E()}.setTool('retype'), true)`)
await evaluate(clickOverlay(0.18, 0.292))
await waitFor(`${E()}.sessions['${docId}'].editingId`, 'body retype')
const bodyColor = await evaluate(`(() => { const s = ${E()}.sessions['${docId}']; return s.objects.find(o => o.id === s.editingId).color })()`)
console.log('thin-text sampled color:', bodyColor)
const dist = (hex, r2, g2, b2) => {
  const v = parseInt(hex.slice(1), 16)
  return Math.abs((v >> 16) - r2) + Math.abs(((v >> 8) & 255) - g2) + Math.abs((v & 255) - b2)
}
if (dist(bodyColor, 0x17, 0x1c, 0x2b) > 60) fail(`body color drifted grey: ${bodyColor}`)
// discard unchanged box
await evaluate(`(document.querySelector('.eo-textarea').blur(), true)`)
await sleep(200)

// 1b. tight heading: the cover must not clip the line above
// 'Consultants' baseline y=738pt; 'First Up' above at y=760pt (leading 1.1em)
await evaluate(clickOverlay(0.16, 0.112))
await waitFor(`${E()}.sessions['${docId}'].editingId`, 'tight heading retype')
const cover = await evaluate(`(() => { const s = ${E()}.sessions['${docId}']; return s.objects.find(o => o.kind === 'whiteout') })()`)
const coverTopPt = (1 - cover.y) * 841.89
console.log('cover top (pt):', coverTopPt.toFixed(1), '— must stay below First Up descenders at ~753')
if (coverTopPt > 753.5) fail(`cover clips the line above (top=${coverTopPt.toFixed(1)}pt)`)
if (coverTopPt < 745) fail(`cover clamped too far (top=${coverTopPt.toFixed(1)}pt)`)
await evaluate(`(document.querySelector('.eo-textarea').blur(), true)`) // unchanged -> discards
await sleep(200)

// 2. empty a retype box = delete the line (cover stays)
await evaluate(clickOverlay(0.2, 0.088)) // the title of Reference_Letter
await waitFor(`${E()}.sessions['${docId}'].editingId`, 'title retype')
await evaluate(`(() => {
  const ta = document.querySelector('.eo-textarea')
  const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  set.call(ta, '')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  ta.blur()
  return true
})()`)
await sleep(250)
const afterEmpty = await evaluate(`(() => { const s = ${E()}.sessions['${docId}']; return { whiteouts: s.objects.filter(o => o.kind === 'whiteout').length, texts: s.objects.filter(o => o.kind === 'text').length } })()`)
console.log('after emptying retype:', JSON.stringify(afterEmpty))
if (afterEmpty.whiteouts !== 1 || afterEmpty.texts !== 0) fail('emptied retype must keep the cover and drop the text')

// apply and confirm the title is gone from the baked page
await evaluate(`(() => { const btns = [...document.querySelectorAll('.actionbar .ghost-btn')]; btns.find(b => b.textContent.includes('Apply')).click(); return true })()`)
await waitFor(`${S()}.docs[0].rev === 1`, 'applied')
await sleep(1200)
const titlePixel = await evaluate(`(() => {
  const c = document.querySelector('.canvas-holder canvas')
  const d = c.getContext('2d').getImageData(Math.round(c.width * 0.2), Math.round(c.height * 0.088), 1, 1).data
  return 0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2]
})()`)
console.log('title area luminance after apply:', Math.round(titlePixel))
if (titlePixel < 240) fail('title still visible after delete-by-retype')
console.log('delete-by-retype: OK')

// 3. zoom: buttons, ctrl+wheel, reset
const w0 = await evaluate(`document.querySelector('.edit-sheet').offsetWidth`)
await evaluate(`(() => { const btns = document.querySelectorAll('.zoom-pill button'); btns[2].click(); btns[2].click(); return true })()`)
await sleep(600)
const w1 = await evaluate(`document.querySelector('.edit-sheet').offsetWidth`)
console.log('zoom widths:', w0, '->', w1)
if (w1 < w0 * 1.2) fail('zoom-in buttons had no effect')
await evaluate(`(() => {
  const el = document.querySelector('.edit-scroll')
  el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100 }))
  return true
})()`)
await sleep(600)
const w2 = await evaluate(`document.querySelector('.edit-sheet').offsetWidth`)
if (w2 <= w1) fail('ctrl+wheel zoom had no effect')
// pinch burst: rapid fine-grained events must scale INSTANTLY via CSS,
// before any re-render settles
const pinch = await evaluate(`(() => {
  const el = document.querySelector('.edit-scroll')
  const before = document.querySelector('.zoom-sizer').getBoundingClientRect().width
  for (let i = 0; i < 4; i++) {
    el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -25 }))
  }
  const after = document.querySelector('.zoom-sizer').getBoundingClientRect().width
  return { before, after }
})()`)
console.log('pinch burst instant feedback:', JSON.stringify(pinch))
if (pinch.after <= pinch.before * 1.1) fail('pinch did not scale instantly (no smooth feedback)')
await sleep(600)
const scrollable = await evaluate(`(() => { const el = document.querySelector('.edit-scroll'); return el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight })()`)
if (!scrollable) fail('zoomed page is not pannable/scrollable')
await evaluate(`(document.querySelector('.zoom-pill .zoom-value').click(), true)`)
await sleep(600)
const w3 = await evaluate(`document.querySelector('.edit-sheet').offsetWidth`)
if (Math.abs(w3 - w0) > 4) fail(`reset did not return to fit (${w0} vs ${w3})`)
console.log('zoom in/out/reset + pan: OK')

ws.close()
child.kill()
console.log(process.exitCode ? 'RETYPE FIXES FAILED' : 'RETYPE FIXES PASSED')
