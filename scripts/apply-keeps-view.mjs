// Regression: "Apply to stack" must not throw away the user's view — zoom,
// scroll position and current page survive the rev bump (previously all three
// reset, dumping the user at page 1 fit-zoom after every apply).
// node scripts/apply-keeps-view.mjs
import { spawn } from 'node:child_process'
import path from 'node:path'
import electronPath from 'electron'

const PORT = 9303
const sample = path.resolve('samples', 'Service_Agreement.pdf')
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
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800))
  return r.result?.result?.value
}
const waitFor = async (expr, label, ms = 25000) => {
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
  await waitFor(`${S}.docs.length === 1 && ${S}.docs[0].pageCount >= 2`, 'multi-page doc')
  const docId = await evaluate(`${S}.docs[0].id`)
  await evaluate(`(${S}.setView('edit'), true)`)
  await waitFor(`!!document.querySelector('.edit-overlay')`, 'edit overlay')
  await sleep(500)

  // go to page 2, zoom in twice, scroll down, add an edit
  await evaluate(`(${E}.setPageIndex('${docId}', 1), true)`)
  await sleep(600)
  await evaluate(`(document.querySelector('.zoom-pill button:last-child').click(), true)`)
  await sleep(250)
  await evaluate(`(document.querySelector('.zoom-pill button:last-child').click(), true)`)
  await sleep(900)
  await evaluate(`(() => { const el = document.querySelector('.edit-scroll'); el.scrollTop = 300; el.scrollLeft = 40; return true })()`)
  await sleep(400)
  const before = JSON.parse(await evaluate(`(() => {
    const el = document.querySelector('.edit-scroll')
    return JSON.stringify({ zoom: document.querySelector('.zoom-value').textContent, top: el.scrollTop, left: el.scrollLeft, page: ${E}.sessions['${docId}'].pageIndex })
  })()`))
  console.log('before apply:', JSON.stringify(before))
  if (before.page !== 1) fail('setup: expected page index 1')
  await evaluate(`(() => {
    const s = ${E}.sessions['${docId}']
    const pageId = s.pages[s.pageIndex].id
    ${E}.addObject('${docId}', { id: 'kv1', pageId, kind: 'text', x: 0.2, y: 0.3, w: 0.4, text: 'Keep my view', fontId: 'std:helvetica', sizePt: 14, color: '#1c1c1e', bold: false, italic: false, underline: false, strike: false, highlight: null })
    return true
  })()`)

  // apply to stack (rev bump) via the real button
  await evaluate(`(document.querySelectorAll('.edit-actionbar .ab-actions .ghost-btn')[document.querySelector('.edit-actionbar .ab-actions .ghost-btn') ? 0 : 0], true)`)
  await evaluate(`(() => {
    const btns = [...document.querySelectorAll('.edit-actionbar .ab-actions button')]
    const apply = btns.find(b => !b.className.includes('btn-primary') && !b.textContent.includes('Print'))
    apply.click(); return true
  })()`)
  await waitFor(`${S}.docs[0].rev >= 1`, 'rev bumped', 30000)
  await sleep(1600)

  const after = JSON.parse(await evaluate(`(() => {
    const el = document.querySelector('.edit-scroll')
    return JSON.stringify({ zoom: document.querySelector('.zoom-value').textContent, top: el.scrollTop, left: el.scrollLeft, page: ${E}.sessions['${docId}'] ? ${E}.sessions['${docId}'].pageIndex : -1 })
  })()`))
  console.log('after apply: ', JSON.stringify(after))
  if (after.zoom !== before.zoom) fail(`zoom reset by apply (${before.zoom} -> ${after.zoom})`)
  if (after.page !== before.page) fail(`page reset by apply (${before.page} -> ${after.page})`)
  if (Math.abs(after.top - before.top) > 40) fail(`scroll lost by apply (top ${before.top} -> ${after.top})`)

  // the baked edit must actually be in the doc (apply still works)
  const text = await evaluate(`(async () => window.__pdfText(${S}.docs[0].bytes))()`)
  if (!text.includes('Keep my view')) fail('apply did not bake the edit')
  console.log('edit baked into the document')

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
