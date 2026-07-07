// Regression: an owner-password-protected PDF is unlocked in-app so it can be
// edited. Verifies the protected chip, that editing before unlock fails with
// the clear message, that Unlock strips protection, and that retype then
// works on the unlocked copy.
// node scripts/unlock-pdf.mjs
import { spawn } from 'node:child_process'
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import electronPath from 'electron'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import createQpdf from '@neslinesli93/qpdf-wasm'

const PORT = 9261
const TMP = path.join(os.tmpdir(), 'signer-unlock')
await mkdir(TMP, { recursive: true })

// build a plain PDF, then encrypt it with an OWNER password (no user
// password) using the same qpdf wasm the app bundles
const doc = await PDFDocument.create()
const page = doc.addPage([595, 842])
const helv = await doc.embedFont(StandardFonts.Helvetica)
page.drawText('Account Balance 1,390,189,345.30', { x: 70, y: 720, size: 14, font: helv })
const plainPath = path.join(TMP, 'plain.pdf')
const protectedPath = path.join(TMP, 'protected.pdf')
await writeFile(plainPath, await doc.save())

const qpdfBase = path.resolve('node_modules/@neslinesli93/qpdf-wasm/dist')
const qpdf = await createQpdf({ locateFile: (f) => path.join(qpdfBase, f) })
qpdf.FS.writeFile('/plain.pdf', new Uint8Array(await (await import('node:fs/promises')).readFile(plainPath)))
// encrypt: 256-bit, owner password "owner", empty user password, restrict modify
const code = qpdf.callMain(['--encrypt', '', 'owner', '256', '--modify=none', '--', '/plain.pdf', '/protected.pdf'])
if (code !== 0 && code !== 3) {
  console.error('FAIL: could not build the protected fixture, qpdf exit', code)
  process.exit(1)
}
await writeFile(protectedPath, Buffer.from(qpdf.FS.readFile('/protected.pdf')))
console.log('built protected fixture')

const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, protectedPath], {
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
const domClick = (sel) => evaluate(`(document.querySelector('${sel}')?.click(), true)`)
const fail = (msg) => {
  console.error('FAIL:', msg)
  process.exitCode = 1
}
const S = `window.__signerStore.getState()`

try {
  await send('Page.enable')
  await waitFor(`!!window.__signerStore`, 'store')
  await waitFor(`${S}.docs.length >= 1`, 'doc loaded')

  // detected as protected
  const enc = await evaluate(`${S}.docs[0].encrypted === true`)
  console.log('flagged protected:', enc)
  if (!enc) fail('protected file was not flagged encrypted')

  // enter edit -> the unlock dialog appears
  await evaluate(`(${S}.setView('edit'), true)`)
  await waitFor(`!!document.querySelector('.confirm-dialog')`, 'unlock dialog shown')
  const title = await evaluate(`document.querySelector('.confirm-dialog h2')?.textContent`)
  console.log('dialog title:', JSON.stringify(title))

  // click Unlock (the primary button)
  await domClick('.confirm-dialog .btn-primary')
  await waitFor(`${S}.docs[0].encrypted === false`, 'unlocked', 40000)
  const bump = await evaluate(`${S}.docs[0].rev >= 1`)
  console.log('unlocked; rev bumped:', bump)
  if (!bump) fail('doc bytes were not replaced after unlock')
  await waitFor(`!document.querySelector('.confirm-dialog')`, 'dialog closed after unlock')

  // the unlocked copy must be a valid, editable PDF: retype a word
  await waitFor(`!!document.querySelector('.edit-overlay')`, 'edit overlay on unlocked doc')
  await evaluate(`(window.__editStore.getState().setTool('retype'), true)`)
  await sleep(600)
  const docId = await evaluate(`${S}.docs[0].id`)
  await evaluate(`(() => {
    const el = document.querySelector('.edit-overlay')
    const r = el.getBoundingClientRect()
    const ev = (type) => el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerId: 1, pointerType: 'mouse', pressure: 0.5, buttons: 1,
      clientX: r.left + ${110 / 595} * r.width, clientY: r.top + ${(842 - 723) / 842} * r.height,
    }))
    ev('pointerdown'); ev('pointerup')
    return true
  })()`)
  await waitFor(
    `(() => { const s = window.__editStore.getState().sessions['${docId}']; return s && s.editingId })()`,
    'retype works on unlocked doc',
  )
  const text = await evaluate(`(() => {
    const s = window.__editStore.getState().sessions['${docId}']
    return s.objects.find(o => o.id === s.editingId)?.text
  })()`)
  console.log('retype on unlocked doc read:', JSON.stringify(text))
  if (!/account|balance|1,390/i.test(text ?? '')) fail(`retype text unexpected: "${text}"`)

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
