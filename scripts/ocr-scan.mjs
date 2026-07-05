// Regression: OCR gives smart detect and retype eyes on scanned documents.
// A "scan" (text rasterized into an image, no text layer) must (1) yield a
// smart-detect placement near its "Signature:" label + ruled line, and
// (2) let retype recognize a clicked word, with the cover matching the
// scan's off-white paper instead of pure white.
// node scripts/ocr-scan.mjs <shotDir>
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import electronPath from 'electron'

const SHOT_DIR = path.resolve(process.argv[2] ?? 'e2e-shots')
const PORT = 9247
await mkdir(SHOT_DIR, { recursive: true })

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
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 900))
  return r.result?.result?.value
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(path.join(SHOT_DIR, name), Buffer.from(r.result.data, 'base64'))
  console.log('shot:', name)
}
const waitFor = async (expr, label, ms = 45000) => {
  const start = Date.now()
  for (;;) {
    if (await evaluate(expr)) return
    if (Date.now() - start > ms) throw new Error('timeout: ' + label)
    await sleep(400)
  }
}
const fail = (msg) => {
  console.error('FAIL:', msg)
  process.exitCode = 1
}
const S = `window.__signerStore.getState()`
const E = `window.__editStore.getState()`

// the fake scan: 16 lines, "Signature:" label with a ruled line at index 14
const LINES = [
  'ACME CORPORATION',
  'Annual Leave Request',
  '',
  'Employee name: Amara Perera',
  'Employee ID: EMP-1040',
  'Department: Engineering',
  'Leave type: Annual',
  'From: 2026-08-03',
  'To: 2026-08-14',
  'Reason: Family holiday',
  '',
  '',
  'I confirm the information above is accurate.',
  '',
  'Signature:',
  '',
]

try {
  await send('Page.enable')
  await waitFor(`!!window.__signerStore && !!window.__editStore && !!window.__makeScannedPdf`, 'hooks')

  await evaluate(`(async () => {
    const bytes = await window.__makeScannedPdf(${JSON.stringify(LINES)}, 14)
    await ${S}.addFiles([{ name: 'fake-scan.pdf', bytes: new Uint8Array(bytes) }])
  })()`)
  await waitFor(`${S}.docs.length === 1 && ${S}.docs[0].status !== 'error'`, 'scan loaded')

  // ---- 1. smart detect must find the signature spot on the scan -----------
  await evaluate(`(${S}.setMode('smart'), true)`)
  await waitFor(`${S}.detecting === false && ${S}.docs[0].smart !== undefined`, 'detection finished')
  const smart = await evaluate(`JSON.stringify(${S}.docs[0].smart)`)
  console.log('smart placement on scan:', smart)
  const pl = JSON.parse(smart)
  if (!pl) fail('smart detect found nothing on the scanned page')
  else {
    // the label row sits at canvas y=1056/1684 -> frac 0.63; the rule just below
    if (pl.yb < 0.55 || pl.yb > 0.85) fail(`placement yb ${pl.yb} not near the signature line`)
    if (pl.x > 0.55) fail(`placement x ${pl.x} not near the label/line`)
  }
  await sleep(400)
  await shot('01-smart-on-scan.png')

  // ---- 2. retype on the scan: OCR the clicked word -------------------------
  await evaluate(`(${S}.setView('edit'), true)`)
  await waitFor(`!!document.querySelector('.edit-overlay')`, 'edit overlay')
  await evaluate(`(${E}.setTool('retype'), true)`)
  // "Department:" row: canvas y baseline 160+5*64=480, word x ~120..270
  const fx = 190 / 1190
  const fy = (480 - 10) / 1684
  await evaluate(`(() => {
    const el = document.querySelector('.edit-overlay')
    const r = el.getBoundingClientRect()
    const ev = (type) => el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerId: 1, pointerType: 'mouse', pressure: 0.5, buttons: 1,
      clientX: r.left + ${fx} * r.width, clientY: r.top + ${fy} * r.height,
    }))
    ev('pointerdown'); ev('pointerup')
    return true
  })()`)
  const docId = await evaluate(`${S}.docs[0].id`)
  await waitFor(`${E}.sessions['${docId}'] && ${E}.sessions['${docId}'].editingId`, 'retype box open (OCR)')
  const state = await evaluate(`(() => {
    const s = ${E}.sessions['${docId}']
    const textObj = s.objects.find(o => o.id === s.editingId)
    const cover = s.objects.find(o => o.kind === 'whiteout')
    return JSON.stringify({ text: textObj?.text, fill: cover?.fill, color: textObj?.color })
  })()`)
  console.log('retype on scan:', state)
  const st = JSON.parse(state)
  if (!/department/i.test(st.text ?? '')) fail(`OCR text should contain "Department", got "${st.text}"`)
  if (!st.fill || st.fill.toLowerCase() === '#ffffff') fail(`cover should match scan paper tone, got ${st.fill}`)
  else {
    const v = parseInt(st.fill.slice(1), 16)
    const [r, g, b] = [(v >> 16) & 255, (v >> 8) & 255, v & 255]
    if (Math.abs(r - 244) > 14 || Math.abs(g - 241) > 14 || Math.abs(b - 232) > 14) {
      fail(`cover tone ${st.fill} far from the scan's #f4f1e8 paper`)
    }
  }
  await shot('02-retype-on-scan.png')

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
