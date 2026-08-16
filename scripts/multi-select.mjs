// Regression: document multi-select. Hold a card to enter selection mode
// (checkboxes + select-all + bulk bar), bulk duplicate, bulk remove with a
// single undo restoring everything, and bulk protect saving N encrypted
// copies with one password.
//   node scripts/multi-select.mjs
import { spawn } from 'node:child_process'
import { mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import electronPath from 'electron'

const OUT = path.resolve('e2e-out-multisel')
const PORT = 9291
await mkdir(OUT, { recursive: true })
const samples = ['Service_Agreement.pdf', 'Reference_Letter.pdf'].map((f) => path.resolve('samples', f))
const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, ...samples], {
  stdio: 'ignore',
  env: { ...process.env, VITE_DEV_SERVER_URL: '', SIGNER_OUTPUT_DIR: OUT },
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
const holdFirstCard = async () => {
  await evaluate(`(() => {
    const el = document.querySelector('.doc-main')
    const r = el.getBoundingClientRect()
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 995, button: 0, buttons: 1, isPrimary: true, clientX: r.left + 20, clientY: r.top + 10 }))
    return true
  })()`)
  await sleep(650) // past the 450ms hold threshold
  await evaluate(`(() => {
    const el = document.querySelector('.doc-main')
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 995, button: 0, isPrimary: true }))
    return true
  })()`)
}

try {
  await send('Page.enable')
  await waitFor(`!!window.__signerStore`, 'store')
  await waitFor(`${S}.docs.length === 2`, 'docs loaded')

  // ---- 1. hold enters selection mode with that doc ticked -------------------
  await holdFirstCard()
  await waitFor(`!!document.querySelector('.bulk-actions')`, 'selection mode')
  const start = await evaluate(`(() => ({
    checks: document.querySelectorAll('.doc-check').length,
    on: document.querySelectorAll('.doc-check.on').length,
  }))()`)
  console.log('selection started:', JSON.stringify(start))
  if (start.checks !== 2 || start.on !== 1) fail(`expected 2 checkboxes / 1 ticked, got ${JSON.stringify(start)}`)

  // ---- 2. select all, bulk duplicate -----------------------------------------
  await evaluate(`(() => { [...document.querySelectorAll('.panel-head .ghost-btn')].find((b) => b.textContent.length).click(); return true })()`)
  await sleep(200)
  if ((await evaluate(`document.querySelectorAll('.doc-check.on').length`)) !== 2) fail('select all did not tick everything')
  await evaluate(`(() => { [...document.querySelectorAll('.bulk-actions .ghost-btn')][1].click(); return true })()`)
  await waitFor(`${S}.docs.length === 4`, 'bulk duplicate')
  console.log('bulk duplicate: 2 -> 4 docs')
  if (await evaluate(`!!document.querySelector('.bulk-actions')`)) fail('selection mode should exit after a bulk action')

  // ---- 3. bulk remove + single undo ------------------------------------------
  await holdFirstCard()
  await waitFor(`!!document.querySelector('.bulk-actions')`, 'selection mode again')
  await evaluate(`(() => { [...document.querySelectorAll('.panel-head .ghost-btn')].find((b) => b.textContent.length).click(); return true })()`)
  await sleep(200)
  await evaluate(`(() => { [...document.querySelectorAll('.bulk-actions .ghost-btn')][2].click(); return true })()`)
  await waitFor(`${S}.docs.length === 0`, 'bulk remove')
  console.log('bulk remove: all gone')
  await evaluate(`(${S}.restoreRemoved(), true)`)
  await waitFor(`${S}.docs.length === 4`, 'single undo restores all')
  console.log('one undo restored all 4')

  // ---- 4. bulk protect: one password, N encrypted copies ---------------------
  await evaluate(`(${S}.removeDocs(${S}.docs.slice(2).map((d) => d.id)), true)`)
  await waitFor(`${S}.docs.length === 2`, 'back to 2 docs')
  await holdFirstCard()
  await waitFor(`!!document.querySelector('.bulk-actions')`, 'selection mode for protect')
  await evaluate(`(() => { [...document.querySelectorAll('.panel-head .ghost-btn')].find((b) => b.textContent.length).click(); return true })()`)
  await sleep(200)
  await evaluate(`(() => { [...document.querySelectorAll('.bulk-actions .ghost-btn')][0].click(); return true })()`)
  await waitFor(`document.querySelectorAll('.protect-field input').length === 2`, 'protect dialog')
  const title = await evaluate(`document.querySelector('.confirm-dialog h2').textContent`)
  console.log('dialog title:', title)
  if (!/2/.test(title)) fail(`bulk title should mention 2 documents: "${title}"`)
  for (const idx of [0, 1]) {
    await evaluate(`(() => {
      const el = document.querySelectorAll('.protect-field input')[${idx}]
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      set.call(el, 'bulk-pass-9')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
  }
  await evaluate(`(() => { [...document.querySelectorAll('.confirm-dialog .btn-primary')].pop().click(); return true })()`)
  await waitFor(`document.body.textContent.includes('2')  && !document.querySelector('.protect-field input')`, 'bulk protect finished', 60000)
  // order-agnostic: two *_protected.pdf files written by THIS run
  const names = (await readdir(OUT)).filter((f) => f.includes('_protected'))
  let fresh = 0
  for (const f of names) {
    const s = await stat(path.join(OUT, f))
    if (Date.now() - s.mtimeMs < 120_000) fresh++
  }
  console.log('protected copies on disk:', JSON.stringify(names), 'fresh:', fresh)
  if (fresh < 2) fail(`expected two freshly protected copies, found ${fresh}`)
  console.log('two protected copies saved with one password')

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
