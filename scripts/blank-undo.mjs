// Regression: blank pages render blank immediately and inherit the document's
// page size (even blank-after-blank); document removal shows an undo toast and
// Ctrl+Z restores the document together with its edit session.
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import electronPath from 'electron'

const SHOT_DIR = path.resolve(process.argv[2] ?? 'e2e-shots')
const PORT = 9239
await mkdir(SHOT_DIR, { recursive: true })

// a US-Letter document (612x792) — the samples are A4, which would mask the bug
const letterPdf = await (async () => {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([612, 792])
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  page.drawText('Letter sized test document', { x: 60, y: 720, size: 16, font })
  return pdf.save()
})()
const letterPath = path.join(os.tmpdir(), 'signer-letter-size.pdf')
await writeFile(letterPath, letterPdf)

const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, letterPath, path.resolve('samples/Service_Agreement.pdf')], {
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
const waitFor = async (expr, label, ms = 30000) => {
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
const S = () => `window.__signerStore.getState()`
const E = () => `window.__editStore.getState()`

await send('Page.enable')
await waitFor(`!!window.__signerStore && !!window.__editStore`, 'stores')
await waitFor(`${S()}.docs.length >= 2`, 'docs')
const letterId = await evaluate(`${S()}.docs.find(d => d.name.includes('letter-size')).id`)

// --- blank pages -----------------------------------------------------------
await evaluate(`(${S()}.selectDoc('${letterId}'), true)`)
await evaluate(`(${S()}.setView('edit'), true)`)
await waitFor(`!!document.querySelector('.canvas-holder canvas')`, 'page rendered')

await evaluate(`(${E()}.addBlankPage('${letterId}', 0), true)`)
await sleep(500)
const blankState = await evaluate(`(() => {
  const holder = document.querySelector('.canvas-holder')
  const s = ${E()}.sessions['${letterId}']
  return {
    holderChildren: holder.children.length,
    isBlankClass: holder.className.includes('blank-page'),
    blank1: s.pages[1].src,
  }
})()`)
console.log('after first blank:', JSON.stringify(blankState))
if (blankState.holderChildren !== 0) fail('blank page still shows the old canvas (stale child)')
if (!blankState.isBlankClass) fail('blank styling missing')
if (Math.round(blankState.blank1.wPt) !== 612 || Math.round(blankState.blank1.hPt) !== 792) {
  fail(`first blank has wrong size: ${JSON.stringify(blankState.blank1)}`)
}

// blank after blank must keep the Letter size (was falling back to A4)
await evaluate(`(${E()}.addBlankPage('${letterId}', 1), true)`)
await sleep(400)
const blank2 = await evaluate(`${E()}.sessions['${letterId}'].pages[2].src`)
console.log('blank-after-blank:', JSON.stringify(blank2))
if (Math.round(blank2.wPt) !== 612 || Math.round(blank2.hPt) !== 792) {
  fail(`blank-after-blank has wrong size: ${JSON.stringify(blank2)}`)
}
console.log('blank page rendering + sizing: OK')

// leave a real edit in the session so undo must restore it
await evaluate(`(${E()}.pushHistory('${letterId}'), ${E()}.addObject('${letterId}', {
  id: 'test-rect', pageId: ${E()}.sessions['${letterId}'].pages[0].id, kind: 'rect',
  x: 0.2, y: 0.2, w: 0.2, h: 0.1, stroke: '#bb3a30', strokeWidthPt: 2, fill: null, opacity: 1,
}), true)`)

// --- removal undo ------------------------------------------------------------
await evaluate(`(${S()}.setView('sign'), true)`)
await evaluate(`(${S()}.removeDoc('${letterId}'), true)`)
await sleep(300)
if ((await evaluate(`${S()}.docs.length`)) !== 1) fail('doc not removed')
if (!(await evaluate(`!!document.querySelector('.undo-toast')`))) fail('undo toast missing')
console.log('toast shown after removal: OK')

// Ctrl+Z restores doc + its edit session
await evaluate(`(window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true })), true)`)
await sleep(300)
const restored = await evaluate(`(() => {
  const s = ${S()}
  const es = ${E()}.sessions['${letterId}']
  return {
    docs: s.docs.length,
    index0: s.docs[0].id === '${letterId}',
    session: es ? { pages: es.pages.length, objects: es.objects.length } : null,
  }
})()`)
console.log('after Ctrl+Z:', JSON.stringify(restored))
if (restored.docs !== 2 || !restored.index0) fail('Ctrl+Z did not restore the document at its position')
if (!restored.session || restored.session.pages !== 3 || restored.session.objects !== 1) {
  fail('edit session (pages/objects) was not recovered')
}
console.log('removal undo with session recovery: OK')

// --- clear-all undo -----------------------------------------------------------
await evaluate(`(${S()}.clearDocs(), true)`)
await sleep(300)
const toastText = await evaluate(`document.querySelector('.undo-toast-text')?.textContent ?? ''`)
console.log('clear toast:', toastText)
if ((await evaluate(`${S()}.docs.length`)) !== 0) fail('clear did not clear')
await evaluate(`(document.querySelector('.undo-toast-btn').click(), true)`)
await sleep(300)
if ((await evaluate(`${S()}.docs.length`)) !== 2) fail('undo did not restore cleared documents')
console.log('clear-all undo: OK')

ws.close()
child.kill()
console.log(process.exitCode ? 'BLANK+UNDO FAILED' : 'BLANK+UNDO PASSED')
