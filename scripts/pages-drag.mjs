// Regression: drag a page chip to reorder pages; single undo entry; plain
// click still selects.
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import electronPath from 'electron'

const SHOT_DIR = path.resolve(process.argv[2] ?? 'e2e-shots')
const PORT = 9235
await mkdir(SHOT_DIR, { recursive: true })
const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, path.resolve('samples/Service_Agreement.pdf')], {
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

await send('Page.enable')
await waitFor(`!!window.__signerStore && !!window.__editStore`, 'stores')
await waitFor(`window.__signerStore.getState().docs.length >= 1`, 'doc')
await evaluate(`(window.__signerStore.getState().setView('edit'), true)`)
await waitFor(`!!document.querySelector('.pages-strip')`, 'strip')
const docId = await evaluate(`window.__signerStore.getState().docs[0].id`)
const S = () => `window.__editStore.getState().sessions['${docId}']`

// grow to 4 pages
await evaluate(`(window.__editStore.getState().addBlankPage('${docId}', 1), true)`)
await evaluate(`(window.__editStore.getState().addBlankPage('${docId}', 2), true)`)
await waitFor(`document.querySelectorAll('.page-chip').length === 4`, '4 chips')
const before = await evaluate(`${S()}.pages.map(p => p.id)`)
const undoBefore = await evaluate(`${S()}.undo.length`)

// drag chip 0 to land after chip 2 (final index 2)
await evaluate(`(() => {
  const chips = [...document.querySelectorAll('.page-chip')]
  const r0 = chips[0].getBoundingClientRect()
  const r2 = chips[2].getBoundingClientRect()
  const ev = (el, type, x) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, buttons: 1, clientX: x, clientY: r0.top + 5 }))
  ev(chips[0], 'pointerdown', r0.left + 5)
  ev(chips[0], 'pointermove', r0.left + 20)
  ev(chips[0], 'pointermove', r2.right - 2)
  ev(chips[0], 'pointerup', r2.right - 2)
  return true
})()`)
await sleep(300)
const after = await evaluate(`${S()}.pages.map(p => p.id)`)
const pageIndex = await evaluate(`${S()}.pageIndex`)
const undoAfter = await evaluate(`${S()}.undo.length`)
console.log('order before:', JSON.stringify(before))
console.log('order after :', JSON.stringify(after))
const expected = [before[1], before[2], before[0], before[3]]
if (JSON.stringify(after) !== JSON.stringify(expected)) fail('drag reorder produced wrong order')
if (pageIndex !== 2) fail(`pageIndex should follow the moved page (got ${pageIndex})`)
if (undoAfter !== undoBefore + 1) fail(`expected exactly one history entry (got +${undoAfter - undoBefore})`)

// one undo restores the original order
await evaluate(`(window.__editStore.getState().undo('${docId}'), true)`)
const restored = await evaluate(`${S()}.pages.map(p => p.id)`)
if (JSON.stringify(restored) !== JSON.stringify(before)) fail('undo did not restore order')

// plain click (no drag) still selects a page
await evaluate(`(() => {
  const chip = document.querySelectorAll('.page-chip')[1]
  const r = chip.getBoundingClientRect()
  const ev = (type) => chip.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, buttons: 1, clientX: r.left + 5, clientY: r.top + 5 }))
  ev('pointerdown'); ev('pointerup')
  chip.click()
  return true
})()`)
await sleep(200)
const selIdx = await evaluate(`${S()}.pageIndex`)
if (selIdx !== 1) fail(`plain click did not select page (pageIndex=${selIdx})`)

const shot = await send('Page.captureScreenshot', { format: 'png' })
await writeFile(path.join(SHOT_DIR, 'e09-pages-drag.png'), Buffer.from(shot.result.data, 'base64'))
ws.close()
child.kill()
console.log(process.exitCode ? 'PAGES DRAG FAILED' : 'PAGES DRAG PASSED')
