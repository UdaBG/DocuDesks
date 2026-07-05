// Diagnostic: what input events reach the page during a synthesized pinch?
import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import path from 'node:path'

const PORT = 9242
const EXE = path.resolve('src-tauri/target/release/signer.exe')
const samples = (await readdir('samples')).filter((f) => f.endsWith('.pdf')).map((f) => path.resolve('samples', f))
const child = spawn(EXE, [samples[0]], {
  stdio: 'ignore',
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let wsUrl
for (let i = 0; i < 60 && !wsUrl; i++) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    wsUrl = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))?.webSocketDebuggerUrl
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
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500))
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

await send('Page.enable')
await waitFor(`!!window.__signerStore`, 'store')
await evaluate(`(window.__signerStore.getState().setView('edit'), true)`)
await waitFor(`!!document.querySelector('.edit-scroll')`, 'edit view')
await sleep(500)

// install event spies
await evaluate(`(() => {
  window.__events = []
  const spy = (type) => window.addEventListener(type, (e) => {
    window.__events.push({ type, ctrl: !!e.ctrlKey, dy: e.deltaY, pt: e.pointerType, touches: e.touches?.length })
  }, { capture: true, passive: false })
  ;['wheel', 'pointerdown', 'pointermove', 'pointerup', 'touchstart', 'touchmove', 'gesturestart'].forEach(spy)
  return true
})()`)

const center = await evaluate(`(() => { const r = document.querySelector('.edit-scroll').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)

// 1. default pinch synthesis
let res = await send('Input.synthesizePinchGesture', { x: center.x, y: center.y, scaleFactor: 1.5, relativeSpeed: 300 })
console.log('synthesizePinchGesture response:', JSON.stringify(res.error ?? 'ok'))
await sleep(600)
let events = await evaluate(`(() => { const e = window.__events; window.__events = []; return e.slice(0, 30) })()`)
console.log('events (default source):', JSON.stringify(events))

// 2. raw touch-event pinch via dispatchTouchEvent
const seq = []
for (let i = 0; i <= 8; i++) {
  const spread = 40 + i * 25
  seq.push([
    { x: center.x - spread, y: center.y },
    { x: center.x + spread, y: center.y },
  ])
}
await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: seq[0].map((p, idx) => ({ ...p, id: idx })) })
for (let i = 1; i <= 8; i++) {
  await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: seq[i].map((p, idx) => ({ ...p, id: idx })) })
  await sleep(16)
}
await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
await sleep(600)
events = await evaluate(`(() => { const e = window.__events; window.__events = []; return e.slice(0, 40) })()`)
console.log('events (raw touch):', JSON.stringify(events))
const zoomVal = await evaluate(`document.querySelector('.zoom-pill .zoom-value').textContent`)
console.log('zoom after raw touch pinch:', zoomVal)
if (zoomVal === '100%') {
  console.error('FAIL: touch pinch did not zoom')
  process.exitCode = 1
} else {
  console.log('TOUCH PINCH PASSED')
}

ws.close()
child.kill()
