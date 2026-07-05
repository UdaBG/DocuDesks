// Probe queryLocalFonts support in the running (Tauri/WebView2) app window.
const PORT = 9231
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let wsUrl
for (let i = 0; i < 30 && !wsUrl; i++) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    wsUrl = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))?.webSocketDebuggerUrl
  } catch {}
  if (!wsUrl) await sleep(500)
}
if (!wsUrl) {
  console.log('no debug target (app not running with port)')
  process.exit(0)
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
// no activation
let result = await send('Runtime.evaluate', {
  expression: `(async () => {
    if (!window.queryLocalFonts) return 'API missing'
    try { return 'faces: ' + (await window.queryLocalFonts()).length } catch (e) { return 'denied: ' + e.message }
  })()`,
  awaitPromise: true,
  returnByValue: true,
})
console.log('no activation ->', result.result?.result?.value)

// with activation: a trusted click, then query from within the activation window
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 400, y: 400, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 400, y: 400, button: 'left', clickCount: 1 })
result = await send('Runtime.evaluate', {
  expression: `(async () => {
    try { return 'faces: ' + (await window.queryLocalFonts()).length } catch (e) { return 'denied: ' + e.message }
  })()`,
  awaitPromise: true,
  returnByValue: true,
})
console.log('with activation ->', result.result?.result?.value)
ws.close()
