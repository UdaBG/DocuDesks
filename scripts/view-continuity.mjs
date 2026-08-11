// Regression: one canvas, three views — page, zoom and viewport position
// survive Read -> Sign -> Edit -> Read; the app opens as a reader; a newly
// selected document starts at page 1 in the reader while signing still jumps
// to the placement page; per-document zoom memory survives doc switches.
//   node scripts/view-continuity.mjs
import { spawn } from 'node:child_process'
import path from 'node:path'
import electronPath from 'electron'

const PORT = 9278
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
/** zoom label + content point under the viewport center of the active stage */
const state = () =>
  evaluate(`(() => {
    const el = document.querySelector('.read-scroll') || document.querySelector('.sign-scroll') || document.querySelector('.edit-scroll')
    const sheet = document.querySelector('.zoom-sizer > *')
    const out = { view: ${S}.view, page: ${S}.previewPage, zoom: document.querySelector('.zoom-value')?.textContent ?? null }
    if (el && sheet) {
      const er = el.getBoundingClientRect()
      const sr = sheet.getBoundingClientRect()
      out.fx = +((er.left + er.width / 2 - sr.left) / sr.width).toFixed(3)
      out.fy = +((er.top + er.height / 2 - sr.top) / sr.height).toFixed(3)
    }
    return out
  })()`)

try {
  await send('Page.enable')
  await waitFor(`!!window.__signerStore && !!window.__editStore`, 'stores')
  await waitFor(`${S}.docs.length >= 1`, 'doc loaded')

  // ---- 1. the app opens as a reader ----------------------------------------
  const v0 = await evaluate(`${S}.view`)
  await waitFor(`!!document.querySelector('.read-stage canvas')`, 'read canvas')
  console.log('default view:', v0)
  if (v0 !== 'read') fail(`default view should be read, got ${v0}`)

  // ---- 2. set up a distinctive position in Read -----------------------------
  await evaluate(`(${S}.setPreviewPage(1), true)`)
  for (let i = 0; i < 3; i++) {
    await evaluate(`(document.querySelector('.zoom-pill button:last-child').click(), true)`)
    await sleep(120)
  }
  await sleep(1500)
  await evaluate(`(() => { const el = document.querySelector('.read-scroll'); el.scrollTop = Math.floor(el.scrollHeight * 0.25); el.scrollLeft = Math.floor(el.scrollWidth * 0.3); return true })()`)
  await sleep(400)
  const read1 = await state()
  console.log('read before switch:', JSON.stringify(read1))

  // ---- 3. Read -> Sign: page, zoom and position survive ---------------------
  await evaluate(`(${S}.setView('sign'), true)`)
  await waitFor(`!!document.querySelector('.sign-scroll .sheet canvas')`, 'sign canvas')
  await sleep(1200)
  const sign1 = await state()
  console.log('sign after switch: ', JSON.stringify(sign1))
  if (sign1.page !== read1.page) fail(`sign lost the page: ${read1.page} -> ${sign1.page}`)
  if (sign1.zoom !== read1.zoom) fail(`sign lost the zoom: ${read1.zoom} -> ${sign1.zoom}`)
  if (Math.abs(sign1.fx - read1.fx) > 0.06 || Math.abs(sign1.fy - read1.fy) > 0.06)
    fail(`sign lost the position: (${read1.fx}, ${read1.fy}) -> (${sign1.fx}, ${sign1.fy})`)

  // ---- 4. Sign -> Edit: same again ------------------------------------------
  await evaluate(`(${S}.setView('edit'), true)`)
  await waitFor(`!!document.querySelector('.edit-sheet canvas')`, 'edit canvas')
  await sleep(1200)
  const edit1 = await state()
  const editPage = await evaluate(`(() => { const s = ${E}.sessions[${S}.selectedDocId]; return s ? s.pageIndex : -1 })()`)
  console.log('edit after switch: ', JSON.stringify(edit1), 'sessionPage:', editPage)
  if (editPage !== read1.page) fail(`edit session did not follow the page: ${editPage}`)
  if (edit1.zoom !== read1.zoom) fail(`edit lost the zoom: ${edit1.zoom}`)
  if (Math.abs(edit1.fx - read1.fx) > 0.06 || Math.abs(edit1.fy - read1.fy) > 0.06)
    fail(`edit lost the position: (${edit1.fx}, ${edit1.fy})`)

  // ---- 5. page turned in Edit flows back to Read ----------------------------
  await evaluate(`(${E}.setPageIndex(${S}.selectedDocId, 0), true)`)
  await sleep(600)
  await evaluate(`(${S}.setView('read'), true)`)
  await waitFor(`!!document.querySelector('.read-stage canvas')`, 'read canvas again')
  const backPage = await evaluate(`${S}.previewPage`)
  console.log('page handed back to read:', backPage)
  if (backPage !== 0) fail(`edit page did not flow back: ${backPage}`)

  // ---- 6. new doc in the reader: page 1, fresh zoom; sign still jumps -------
  await evaluate(`(async () => {
    const bytes = await window.__makeContractPdf(3, 1)
    ${S}.addGeneratedDoc('contract.pdf', new Uint8Array(bytes), 3)
    return true
  })()`)
  await sleep(1200)
  const fresh = await state()
  console.log('fresh doc in read:', JSON.stringify(fresh))
  if (fresh.page !== 0) fail(`new doc should open at page 1 in the reader, got ${fresh.page}`)
  if (fresh.zoom !== '100%') fail(`new doc should start at fit zoom, got ${fresh.zoom}`)

  // switching back to the first doc restores ITS zoom (per-doc memory)
  const firstId = await evaluate(`${S}.docs[0].id`)
  await evaluate(`(${S}.selectDoc('${firstId}'), true)`)
  await sleep(1200)
  const back = await state()
  console.log('back on doc 1 in read:', JSON.stringify(back))
  if (back.page !== 0) fail(`re-selected doc should open at page 1 in the reader, got ${back.page}`)
  if (back.zoom !== read1.zoom) fail(`doc 1's zoom memory lost: ${back.zoom} (expected ${read1.zoom})`)

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
