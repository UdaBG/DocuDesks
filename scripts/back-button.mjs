// Regression: the Android back-button ladder (window.__handleBackButton).
// Each press peels one layer: overlay → text box (keyboard) → tool → selection
// → unsaved prompt → double-press-to-exit. Driven on desktop; the Android side
// only relays the press and honours the 'exit' return.
// node scripts/back-button.mjs
import { spawn } from 'node:child_process'
import path from 'node:path'
import electronPath from 'electron'

const PORT = 9289
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
const BACK = `window.__handleBackButton()`

try {
  await send('Page.enable')
  await waitFor(`!!window.__signerStore && !!window.__handleBackButton`, 'hooks')
  await waitFor(`${S}.docs.length === 1`, 'doc')
  const docId = await evaluate(`${S}.docs[0].id`)

  // overlay layer: studio open -> back closes it
  await evaluate(`(${S}.openStudio(), true)`)
  const r0 = await evaluate(BACK)
  const studioAfter = await evaluate(`${S}.studioOpen`)
  console.log(`studio: ${r0}, open=${studioAfter}`)
  if (r0 !== 'handled' || studioAfter) fail('back did not close the signature studio')

  // typing layer: open a text box, back commits it
  await evaluate(`(${S}.setView('edit'), true)`)
  await waitFor(`!!document.querySelector('.edit-overlay')`, 'edit overlay')
  await sleep(400)
  await evaluate(`(${E}.setTool('text'), true)`)
  await evaluate(`(() => {
    const el = document.querySelector('.edit-overlay'); const r = el.getBoundingClientRect()
    const ev = (t) => el.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: r.left + r.width*0.3, clientY: r.top + r.height*0.4 }))
    ev('pointerdown'); ev('pointerup'); return true
  })()`)
  await waitFor(`${E}.sessions['${docId}'].editingId`, 'text box open')
  await evaluate(`(() => {
    const el = document.querySelector('.eo-textarea')
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    set.call(el, 'Back test'); el.dispatchEvent(new Event('input', { bubbles: true })); return true
  })()`)
  const r1 = await evaluate(BACK)
  await sleep(300)
  const editingAfter = await evaluate(`${E}.sessions['${docId}'].editingId`)
  console.log(`typing: ${r1}, editingId=${editingAfter}`)
  if (r1 !== 'handled' || editingAfter) fail('back did not close the text box')

  // tool layer: still on text tool -> back returns to select
  const r2 = await evaluate(BACK)
  const toolAfter = await evaluate(`${E}.tool`)
  console.log(`tool: ${r2}, tool=${toolAfter}`)
  if (r2 !== 'handled' || toolAfter !== 'select') fail('back did not return the tool to select')

  // selection layer: select the box -> back deselects
  const objId = await evaluate(`${E}.sessions['${docId}'].objects.find(o => o.kind === 'text')?.id`)
  await evaluate(`(${E}.select('${docId}', '${objId}'), true)`)
  const r3 = await evaluate(BACK)
  const selAfter = await evaluate(`${E}.sessions['${docId}'].selectedId`)
  console.log(`selection: ${r3}, selectedId=${selAfter}`)
  if (r3 !== 'handled' || selAfter) fail('back did not deselect')

  // unsaved layer: edits exist -> back opens the Stay/Leave prompt
  const r4 = await evaluate(BACK)
  const promptOpen = await evaluate(`${S}.exitPrompt`)
  const dialogShown = await evaluate(`!!document.querySelector('.confirm-dialog')`)
  console.log(`unsaved: ${r4}, prompt=${promptOpen}, dialog=${dialogShown}`)
  if (r4 !== 'handled' || !promptOpen || !dialogShown) fail('back did not raise the unsaved-changes prompt')

  // back on the prompt = Stay
  const r5 = await evaluate(BACK)
  const promptAfter = await evaluate(`${S}.exitPrompt`)
  console.log(`prompt back: ${r5}, prompt=${promptAfter}`)
  if (r5 !== 'handled' || promptAfter) fail('back on the prompt should dismiss it (stay)')

  // clear the unsaved work -> double-press to exit
  await evaluate(`(${E}.dropSession('${docId}'), true)`)
  const r6 = await evaluate(BACK)
  const toast = await evaluate(`${S}.backToast`)
  console.log(`first press: ${r6}, toast=${toast}`)
  if (r6 !== 'handled' || !toast) fail('first back should show the press-again toast')
  const r7 = await evaluate(BACK)
  console.log(`second press: ${r7}`)
  if (r7 !== 'exit') fail(`second back within the window should exit (got ${r7})`)

  // and after the window expires, it must NOT exit
  await sleep(2300)
  const r8 = await evaluate(BACK)
  console.log(`press after window: ${r8}`)
  if (r8 !== 'handled') fail('a press after the 2s window must not exit')

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
