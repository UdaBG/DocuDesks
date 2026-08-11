// Isolate the blank-render bug: fresh open+render (no prior doc lifecycle)
// vs render after the app's normal addFiles (open/close for page count first).
// node scripts/probe-blankpdf2.mjs <pdf-path>
import { spawn } from 'node:child_process'
import electronPath from 'electron'

const PDF = process.argv[2] ?? 'C:\\Users\\udbhlk\\Downloads\\Final_Results_released_on_23062026_16072026_and_21072026.pdf'
const PORT = 9295
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
const consoleMsgs = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')
    consoleMsgs.push(`[${m.params.type}] ${text}`)
  }
}
const send = (method, params = {}) =>
  new Promise((res) => {
    pending.set(++id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 900))
  return r.result?.result?.value
}

try {
  await send('Page.enable')
  await send('Runtime.enable')
  for (let i = 0; i < 40; i++) {
    const ok = await evaluate(`!!window.__renderProbe`).catch(() => false)
    if (ok) break
    await sleep(500)
  }

  // A. completely fresh open + render, page 1 — before ANY other doc lifecycle
  const a = await evaluate(`(async () => JSON.stringify(await window.__renderProbe(${JSON.stringify(PDF)}, 0)))()`)
  console.log('A fresh render p1:', a, '| console:', consoleMsgs.splice(0).join(' ; ') || '(clean)')

  // B. immediately render again (same shared worker, prior task destroyed)
  const b = await evaluate(`(async () => JSON.stringify(await window.__renderProbe(${JSON.stringify(PDF)}, 0)))()`)
  console.log('B second render p1:', b, '| console:', consoleMsgs.splice(0).join(' ; ') || '(clean)')

  // C. page 5 (different page, images shared across pages)
  const c = await evaluate(`(async () => JSON.stringify(await window.__renderProbe(${JSON.stringify(PDF)}, 4)))()`)
  console.log('C fresh render p5:', c, '| console:', consoleMsgs.splice(0).join(' ; ') || '(clean)')
} catch (e) {
  console.error('ERROR:', e.message)
} finally {
  child.kill()
}
