// Regression: every edit tool announces its name + what it does in the hint
// bar while active (the icon-only toolbar confused new closed-test users).
// node scripts/tool-hints.mjs
import { spawn } from 'node:child_process'
import path from 'node:path'
import electronPath from 'electron'

const PORT = 9307
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
const E = `window.__editStore.getState()`

try {
  await send('Page.enable')
  await waitFor(`!!window.__signerStore && !!window.__editStore`, 'stores')
  await waitFor(`${S}.docs.length === 1`, 'doc')
  await evaluate(`(${S}.setView('edit'), true)`)
  await waitFor(`!!document.querySelector('.edit-overlay')`, 'edit overlay')
  await sleep(400)

  const tools = ['text', 'pen', 'rect', 'ellipse', 'line', 'arrow', 'erase', 'whiteout']
  for (const tool of tools) {
    await evaluate(`(${E}.setTool('${tool}'), true)`)
    await sleep(250)
    const hint = await evaluate(`document.querySelector('.stage-hint')?.textContent ?? ''`)
    const ok = hint.length > 10 && hint.includes('·')
    console.log(`${tool}: ${ok ? 'OK' : 'MISSING'} — "${hint.slice(0, 60)}"`)
    if (!ok) fail(`no hint for tool ${tool}`)
  }

  // select shows no tool hint (default state stays quiet)
  await evaluate(`(${E}.setTool('select'), true)`)
  await sleep(250)
  const selHint = await evaluate(`document.querySelector('.stage-hint')?.textContent ?? ''`)
  console.log(`select: "${selHint}"`)
  if (selHint.includes('·')) fail('select tool should not show a tool hint')

  // retype keeps its richer OCR-aware hint
  await evaluate(`(${E}.setTool('retype'), true)`)
  await sleep(400)
  const reHint = await evaluate(`document.querySelector('.stage-hint')?.textContent ?? ''`)
  console.log(`retype: "${reHint.slice(0, 60)}"`)
  if (reHint.length < 10) fail('retype lost its hint')

  // the hint announces, then steps aside — it must not bury the document
  await sleep(4600)
  const gone = await evaluate(`document.querySelector('.stage-hint')?.textContent ?? ''`)
  console.log(`after timeout: "${gone}"`)
  if (gone.length > 0) fail('tool hint should auto-hide after ~4.5s')
  // re-arming the same tool family announces again
  await evaluate(`(${E}.setTool('pen'), true)`)
  await sleep(250)
  const again = await evaluate(`document.querySelector('.stage-hint')?.textContent ?? ''`)
  if (!again.includes('·')) fail('activating a tool should re-announce the hint')
  console.log('re-announce on tool change: OK')

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
