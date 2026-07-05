// Connect to the running app, install input-event spies, then poll until the
// user performs a trackpad pinch and dump exactly what the page received.
const PORT = 9243
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let wsUrl
for (let i = 0; i < 120 && !wsUrl; i++) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    wsUrl = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))?.webSocketDebuggerUrl
  } catch {}
  if (!wsUrl) await sleep(1000)
}
if (!wsUrl) {
  console.log('APP NOT REACHABLE')
  process.exit(1)
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
  return r.result?.result?.value
}

await evaluate(`(() => {
  if (window.__spyInstalled) return true
  window.__spyInstalled = true
  window.__events = []
  const push = (o) => { if (window.__events.length < 300) window.__events.push(o) }
  window.addEventListener('wheel', (e) => push({ t: 'wheel', ctrl: e.ctrlKey, shift: e.shiftKey, dx: Math.round(e.deltaX), dy: Math.round(e.deltaY), mode: e.deltaMode }), { capture: true, passive: true })
  window.addEventListener('pointerdown', (e) => push({ t: 'pdown', pt: e.pointerType }), { capture: true })
  window.addEventListener('pointermove', (e) => { if (e.pointerType !== 'mouse') push({ t: 'pmove', pt: e.pointerType }) }, { capture: true })
  window.addEventListener('touchstart', (e) => push({ t: 'touchstart', n: e.touches.length }), { capture: true, passive: true })
  window.addEventListener('keydown', (e) => { if (e.key === 'Control') push({ t: 'ctrl-down' }) }, { capture: true })
  return true
})()`)
console.log('SPY INSTALLED — waiting for trackpad pinch...')

for (let i = 0; i < 120; i++) {
  await sleep(2000)
  const events = await evaluate(`(() => { const e = window.__events; if (e.length) window.__events = []; return e })()`)
  if (events && events.length) {
    const interesting = events.some((e) => e.t === 'wheel' || e.t.startsWith('touch') || e.pt === 'touch')
    if (!interesting) continue // clicks/mouse noise — keep waiting for the pinch
    console.log('CAPTURED', events.length, 'EVENTS:')
    console.log(JSON.stringify(events.slice(0, 60)))
    await sleep(2500)
    const more = await evaluate(`(() => { const e = window.__events; window.__events = []; return e })()`)
    if (more?.length) console.log('MORE:', JSON.stringify(more.slice(0, 60)))
    break
  }
}
ws.close()
console.log('SPY DONE')
