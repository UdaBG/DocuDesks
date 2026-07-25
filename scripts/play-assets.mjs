// Generate the Play Store listing assets into store-assets/:
//   icon-512.png                 (copied from build/icon.png)
//   feature-graphic-1024x500.png (brand banner, real app fonts)
//   phone-1..4 (1080x2400)       (real UI at 360x800 @3x)
// node scripts/play-assets.mjs
import { spawn } from 'node:child_process'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import electronPath from 'electron'

const OUT = path.resolve('store-assets')
const PORT = 9287
await mkdir(OUT, { recursive: true })
await copyFile('build/icon.png', path.join(OUT, 'icon-512.png'))
console.log('icon-512.png (copied, already 512x512)')

// store shots must not show the dev machine's accumulated test signatures —
// stash the real file, start clean, restore afterwards
const sigFile = path.join(process.env.APPDATA, 'DocuDesk', 'signatures.json')
const hadSigs = existsSync(sigFile)
if (hadSigs) await copyFile(sigFile, sigFile + '.bak-shots')
await mkdir(path.dirname(sigFile), { recursive: true })
await writeFile(sigFile, '[]')

const samples = ['Leave_Request_Amara_Perera.pdf', 'Leave_Request_Kasun_Fernando.pdf', 'Service_Agreement.pdf'].map(
  (f) => path.resolve('samples', f),
)
const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, ...samples], {
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
const waitFor = async (expr, label, ms = 25000) => {
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
  await waitFor(`!!window.__signerStore && ${S}.docs.length >= 3`, 'docs loaded')
  const docId = await evaluate(`${S}.docs[0].id`)

  // a handsome flowing signature to show off
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

  // phone frame: 360x640 at 3x -> 1080x1920 (exact 9:16 — Play's safest
  // ratio: within the 2:1 listing limit AND promo-eligible)
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 3, mobile: true })
  await sleep(900)

  // 1. Sign view with the placed signature
  await evaluate(`(${S}.setMode('manual'), true)`)
  await evaluate(`(${S}.addExtraStamp({ x: 0.42, yb: 0.86, w: 0.34 }), true)`)
  await evaluate(`(document.querySelectorAll('.mobile-nav .mobile-tab')[1]?.click(), true)`)
  await sleep(1400)
  await shot('phone-1-sign.png')

  // 2. Edit view with content
  await evaluate(`(${S}.setView('edit'), true)`)
  await waitFor(`!!document.querySelector('.edit-overlay')`, 'edit overlay')
  await evaluate(`(() => {
    const pageId = ${E}.sessions['${docId}'].pages[0].id
    ${E}.addObject('${docId}', { id: 'sa1', pageId, kind: 'text', x: 0.12, y: 0.62, w: 0.5, text: 'Approved — HR', fontId: 'std:helvetica', sizePt: 16, color: '#1c7c54', bold: true, italic: false, underline: false, strike: false, highlight: null })
    ${E}.addObject('${docId}', { id: 'sa2', pageId, kind: 'rect', x: 0.09, y: 0.585, w: 0.56, h: 0.075, stroke: '#1c7c54', strokeWidthPt: 2, fill: null, opacity: 1, rot: -3 })
    ${E}.setTool('select'); ${E}.select('${docId}', 'sa2')
    return true
  })()`)
  await sleep(1200)
  await shot('phone-2-edit.png')

  // 3. Signatures tab with the saved signature
  await evaluate(`(${S}.setView('sign'), true)`)
  await sleep(500)
  await evaluate(`(document.querySelectorAll('.mobile-nav .mobile-tab')[2]?.click(), true)`)
  await sleep(800)
  await shot('phone-3-signatures.png')

  // 4. Documents tab with the stack
  await evaluate(`(document.querySelectorAll('.mobile-nav .mobile-tab')[0]?.click(), true)`)
  await sleep(600)
  await shot('phone-4-documents.png')

  // feature graphic 1024x500 — drawn in-page so the real brand fonts render
  await send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 500, deviceScaleFactor: 1, mobile: false })
  await sleep(400)
  await evaluate(`(() => {
    const d = document.createElement('div')
    d.id = 'play-banner'
    d.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;gap:56px;background:linear-gradient(120deg,#101527 0%,#1b2447 55%,#2438a8 130%)'
    d.innerHTML = \`
      <svg width="150" height="150" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 2c3.5 2.6 5.5 5.8 5.5 9.4 0 2.8-1.6 6-5.5 10.6-3.9-4.6-5.5-7.8-5.5-10.6C6.5 7.8 8.5 4.6 12 2Z" fill="#ffffff"/>
        <circle cx="12" cy="11" r="1.5" fill="#2438a8"/>
        <path d="M12 12.5V19" stroke="#2438a8" stroke-width="1.4" stroke-linecap="round"/>
      </svg>
      <div>
        <div style="font-family:'Great Vibes',cursive;font-size:110px;line-height:1;color:#ffffff">DocuDesk</div>
        <div style="font-family:'Schibsted Grotesk',sans-serif;font-size:30px;font-weight:600;color:rgba(255,255,255,.92);margin-top:14px">Sign one, sign them all.</div>
        <div style="font-family:'Schibsted Grotesk',sans-serif;font-size:20px;font-weight:500;letter-spacing:.04em;color:#d8b45a;margin-top:12px">Free · Offline · No ads</div>
      </div>\`
    document.body.appendChild(d)
    return true
  })()`)
  await sleep(700)
  await shot('feature-graphic-1024x500.png')
  await evaluate(`(document.getElementById('play-banner')?.remove(), true)`)

  console.log('ALL ASSETS WRITTEN to store-assets/')
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
