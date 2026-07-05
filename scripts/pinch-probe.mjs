// Verify trackpad pinch reaches the page in the Tauri build: synthesize a real
// pinch gesture through the browser input pipeline and check the zoom changed.
import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import path from 'node:path'

const PORT = 9241
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
await waitFor(`window.__signerStore.getState().docs.length >= 1`, 'doc')
await evaluate(`(window.__signerStore.getState().setView('edit'), true)`)
await waitFor(`!!document.querySelector('.zoom-sizer')`, 'edit view')
await sleep(800)

const before = await evaluate(`document.querySelector('.zoom-sizer').getBoundingClientRect().width`)
const center = await evaluate(`(() => { const r = document.querySelector('.edit-scroll').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
const res = await send('Input.synthesizePinchGesture', {
  x: center.x,
  y: center.y,
  scaleFactor: 1.6,
  relativeSpeed: 400,
})
if (res.error) console.log('pinch synth error:', JSON.stringify(res.error))
await sleep(900)
const after = await evaluate(`document.querySelector('.zoom-sizer').getBoundingClientRect().width`)
const zoomVal = await evaluate(`document.querySelector('.zoom-pill .zoom-value').textContent`)
console.log('pinch gesture:', before, '->', after, '| zoom display:', zoomVal)
if (after > before * 1.15) console.log('PINCH REACHES THE PAGE: OK')
else {
  console.error('FAIL: pinch gesture did not zoom')
  process.exitCode = 1
}
ws.close()
child.kill()
