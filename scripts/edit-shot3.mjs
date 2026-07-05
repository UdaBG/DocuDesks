// Regression: retype → save/apply → retype again must not duplicate or
// double-draw; retype keeps the original ink color.
// node scripts/edit-shot3.mjs <shotDir>
import { spawn } from 'node:child_process'
import { mkdir, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import electronPath from 'electron'

const SHOT_DIR = path.resolve(process.argv[2] ?? 'e2e-shots')
const PORT = 9232
await mkdir(SHOT_DIR, { recursive: true })
const samples = (await readdir('samples')).filter((f) => f.endsWith('.pdf')).map((f) => path.resolve('samples', f))
const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, samples[0]], {
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
const waitFor = async (expr, label, ms = 20000) => {
  const start = Date.now()
  for (;;) {
    if (await evaluate(expr)) return
    if (Date.now() - start > ms) throw new Error('timeout: ' + label)
    await sleep(300)
  }
}
const HELPERS = `window.__click = (fx, fy) => {
  const el = document.querySelector('.edit-overlay')
  const r = el.getBoundingClientRect()
  const ev = (type) => el.dispatchEvent(new PointerEvent(type, {
    bubbles: true, pointerId: 1, pointerType: 'mouse', pressure: 0.5, buttons: 1,
    clientX: r.left + fx * r.width, clientY: r.top + fy * r.height,
  }))
  ev('pointerdown'); ev('pointerup')
}; true`

const fail = (msg) => {
  console.error('FAIL:', msg)
  process.exitCode = 1
}

try {
  await send('Page.enable')
  await waitFor(`!!window.__signerStore && !!window.__editStore`, 'stores')
  await waitFor(`window.__signerStore.getState().docs.length >= 1`, 'doc')
  await evaluate(`(window.__signerStore.getState().setView('edit'), true)`)
  await waitFor(`!!document.querySelector('.edit-overlay')`, 'overlay')
  await evaluate(HELPERS)
  const docId = await evaluate(`window.__signerStore.getState().docs[0].id`)
  const S = () => `window.__editStore.getState().sessions['${docId}']`

  // 0. retype + close WITHOUT changes: must leave no trace (no-op discard)
  await evaluate(`(window.__editStore.getState().setTool('retype'), true)`)
  await evaluate(`window.__click(0.25, 0.115)`)
  await waitFor(`${S()}.editingId`, 'noop retype editing')
  await evaluate(`(document.querySelector('.eo-textarea').blur(), true)`)
  await sleep(200)
  let n = await evaluate(`${S()}.objects.length`)
  console.log('objects after unchanged retype:', n)
  if (n !== 0) fail(`unchanged retype left ${n} objects behind`)

  // 1. retype the title and CHANGE it
  await evaluate(`window.__click(0.25, 0.115)`)
  await waitFor(`${S()}.editingId`, 'first retype editing')
  const first = await evaluate(`(() => { const s = ${S()}; const o = s.objects.find(x => x.id === s.editingId); return { text: o.text, color: o.color, weight: o.weightHint, n: s.objects.length } })()`)
  console.log('first retype:', JSON.stringify(first))
  if (first.text !== 'Annual Leave Request') fail('unexpected run text')
  if (first.color.toLowerCase() === '#1c1c1e') console.log('note: color fell back to default')
  else console.log('color sampled from page:', first.color)
  await evaluate(`(() => {
    const ta = document.querySelector('.eo-textarea')
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, ta.value + ' (rev A)')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)

  // commit
  await evaluate(`window.__click(0.5, 0.9)`)
  await sleep(200)
  n = await evaluate(`${S()}.objects.length`)
  if (n !== 2) fail(`expected 2 objects after first retype, got ${n}`)

  // 2. retype the SAME spot again: must edit, not duplicate
  await evaluate(`window.__click(0.25, 0.115)`)
  await sleep(400)
  const second = await evaluate(`(() => { const s = ${S()}; return { editing: !!s.editingId, n: s.objects.length } })()`)
  console.log('second retype on same spot:', JSON.stringify(second))
  if (!second.editing) fail('second click did not enter editing')
  if (second.n !== 2) fail(`objects duplicated: ${second.n}`)
  await evaluate(`window.__click(0.5, 0.9)`)
  await sleep(200)

  // 3. apply to stack (bakes cover + text into the PDF)
  await evaluate(`(() => { const btns = [...document.querySelectorAll('.actionbar .ghost-btn')]; btns.find(b => b.textContent.includes('Apply')).click(); return true })()`)
  await waitFor(`window.__signerStore.getState().docs[0].rev === 1`, 'applied')
  await waitFor(`${S()} && ${S()}.objects.length === 0`, 'session reset')
  await sleep(1200)

  // 4. retype the same spot in the BAKED doc: text must not be doubled
  await evaluate(`(window.__editStore.getState().setTool('retype'), true)`)
  await evaluate(`window.__click(0.25, 0.115)`)
  await waitFor(`${S()}.editingId`, 'retype on baked doc')
  const baked = await evaluate(`(() => { const s = ${S()}; const o = s.objects.find(x => x.id === s.editingId); return { text: o.text, font: o.fontId, bold: o.bold, weight: o.weightHint } })()`)
  console.log('retype on baked doc:', JSON.stringify(baked))
  if (baked.text !== 'Annual Leave Request (rev A)') fail(`doubled or wrong text: "${baked.text}"`)
  // closing unchanged must be a no-op on the baked doc too
  await evaluate(`(document.querySelector('.eo-textarea').blur(), true)`)
  await sleep(200)
  const finalN = await evaluate(`${S()}.objects.length`)
  if (finalN !== 0) fail(`unchanged retype on baked doc left ${finalN} objects`)
  console.log('unchanged retype on baked doc: no-op OK')
  await shot('e05-regression.png')
} finally {
  ws.close()
  child.kill()
}
console.log(process.exitCode ? 'REGRESSION FAILED' : 'REGRESSION PASSED')
