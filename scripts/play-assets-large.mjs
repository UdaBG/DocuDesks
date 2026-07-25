// Large-format Play listing screenshots (tablet / Chromebook / Android XR):
// five 2560x1440 (exact 16:9, sides >=1080) desktop-layout shots into
// store-assets/large/. The same files satisfy the 7", 10", Chromebook and XR
// sections. Real app UI; the dev machine's signatures are stashed and restored.
// node scripts/play-assets-large.mjs
import { spawn } from 'node:child_process'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import electronPath from 'electron'

const OUT = path.resolve('store-assets', 'large')
const PORT = 9291
const OUT_DIR = path.join(os.tmpdir(), 'signer-large-out')
await mkdir(OUT, { recursive: true })
await rm(OUT_DIR, { recursive: true, force: true })
await mkdir(OUT_DIR, { recursive: true })

const sigFile = path.join(process.env.APPDATA, 'DocuDesk', 'signatures.json')
const hadSigs = existsSync(sigFile)
if (hadSigs) await copyFile(sigFile, sigFile + '.bak-shots')
await mkdir(path.dirname(sigFile), { recursive: true })
await writeFile(sigFile, '[]')

const samples = [
  'Leave_Request_Amara_Perera.pdf',
  'Leave_Request_Kasun_Fernando.pdf',
  'Leave_Request_Nadeesha_Silva.pdf',
  'SigLine_Letter.pdf',
].map((f) => path.resolve('samples', f))
const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, ...samples], {
  stdio: 'ignore',
  env: { ...process.env, VITE_DEV_SERVER_URL: '', SIGNER_OUTPUT_DIR: OUT_DIR },
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
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(path.join(OUT, name), Buffer.from(r.result.data, 'base64'))
  console.log('shot:', name)
}
const S = `window.__signerStore.getState()`
const E = `window.__editStore.getState()`

try {
  await send('Page.enable')
  await waitFor(`!!window.__signerStore && ${S}.docs.length >= 4`, 'docs loaded')
  const docs = JSON.parse(await evaluate(`JSON.stringify(${S}.docs.map(d => ({ id: d.id, name: d.name })))`))
  const amara = docs.find((d) => d.name.includes('Amara')).id
  const letter = docs.find((d) => d.name.includes('SigLine')).id

  // 2560x1440 = desktop three-panel layout at 1280x720 css, 2x
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 2, mobile: false })
  await sleep(800)

  // the flowing demo signature
  await evaluate(`(() => {
    const c = document.createElement('canvas'); c.width = 420; c.height = 150
    const g = c.getContext('2d'); g.strokeStyle = '#26357c'; g.lineWidth = 6; g.lineCap = 'round'; g.lineJoin = 'round'
    g.beginPath(); g.moveTo(18, 108)
    g.bezierCurveTo(60, 20, 110, 130, 165, 62)
    g.bezierCurveTo(205, 14, 235, 120, 300, 82)
    g.bezierCurveTo(345, 56, 375, 70, 402, 48)
    g.stroke()
    g.lineWidth = 3.4
    g.beginPath(); g.moveTo(30, 124); g.quadraticCurveTo(210, 142, 396, 118); g.stroke()
    ${S}.addSignature({ name: 'A. Perera', dataUrl: c.toDataURL('image/png'), width: c.width, height: c.height })
    return true
  })()`)

  // 1. Sign view, manual stamp placed on the leave request
  await evaluate(`(${S}.selectDoc('${amara}'), ${S}.setMode('manual'), true)`)
  await evaluate(`(${S}.addExtraStamp({ x: 0.42, yb: 0.86, w: 0.3 }), true)`)
  await sleep(1500)
  await shot('large-1-sign.png')

  // 2. Smart detect finds the signature line on the letter
  await evaluate(`(${S}.selectDoc('${letter}'), ${S}.setMode('smart'), true)`)
  await waitFor(`${S}.docs.every(d => d.status !== 'detecting')`, 'detection done')
  await sleep(1200)
  await shot('large-2-smart.png')

  // 3. Edit view with content
  await evaluate(`(${S}.selectDoc('${amara}'), ${S}.setView('edit'), true)`)
  await waitFor(`!!document.querySelector('.edit-overlay')`, 'edit overlay')
  await evaluate(`(() => {
    const s = ${E}.sessions['${amara}']
    if (!s) return false
    const pageId = s.pages[0].id
    ${E}.addObject('${amara}', { id: 'lg1', pageId, kind: 'text', x: 0.12, y: 0.62, w: 0.5, text: 'Approved — HR', fontId: 'std:helvetica', sizePt: 16, color: '#1c7c54', bold: true, italic: false, underline: false, strike: false, highlight: null })
    ${E}.addObject('${amara}', { id: 'lg2', pageId, kind: 'rect', x: 0.09, y: 0.585, w: 0.56, h: 0.075, stroke: '#1c7c54', strokeWidthPt: 2, fill: null, opacity: 1, rot: -3 })
    ${E}.setTool('select'); ${E}.select('${amara}', 'lg2')
    return true
  })()`)
  await sleep(1200)
  await shot('large-3-edit.png')

  // 4. Signature studio, Type tab with the script-font grid
  await evaluate(`(${S}.setView('sign'), ${S}.openStudio(), true)`)
  await waitFor(`!!document.querySelector('.studio-tabs')`, 'studio open')
  await evaluate(`(document.querySelectorAll('.studio-tab')[2].click(), true)`)
  await sleep(400)
  await evaluate(`(() => {
    const el = document.querySelector('.studio input[type="text"]')
    if (!el) return false
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(el, 'Amara Perera'); el.dispatchEvent(new Event('input', { bubbles: true })); return true
  })()`)
  await sleep(700)
  await shot('large-4-studio.png')
  await evaluate(`(${S}.closeStudio(), true)`)

  // 5. Bulk result: sign all, success card up
  await sleep(300)
  await evaluate(`${S}.signAll()`)
  await waitFor(`${S}.result && ${S}.result.signed >= 3`, 'signed all', 60000)
  await sleep(600)
  await shot('large-5-result.png')

  console.log('LARGE SHOTS WRITTEN to store-assets/large/')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
  await sleep(500)
  if (hadSigs) {
    await copyFile(sigFile + '.bak-shots', sigFile)
    await rm(sigFile + '.bak-shots', { force: true })
  } else {
    await rm(sigFile, { force: true })
  }
  console.log('signatures restored')
}
