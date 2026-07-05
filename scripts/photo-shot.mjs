// Drive the Photo tab with a synthesized "photo of a signature on paper".
// node scripts/photo-shot.mjs <shotDir>
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import electronPath from 'electron'

const SHOT_DIR = path.resolve(process.argv[2] ?? 'e2e-shots')
await mkdir(SHOT_DIR, { recursive: true })
const PORT = 9226
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
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500))
  return r.result?.result?.value
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(path.join(SHOT_DIR, name), Buffer.from(r.result.data, 'base64'))
  console.log('shot:', name)
}

for (let i = 0; i < 40; i++) {
  if (await evaluate(`!!window.__signerStore`)) break
  await sleep(400)
}
await evaluate(`(window.__signerStore.getState().openStudio(), true)`)
await sleep(300)
await evaluate(`(document.querySelectorAll('.studio-tab')[1].click(), true)`)
await sleep(300)

// Synthesize a realistic "phone photo": warm paper with a lighting gradient,
// a soft shadow band, sensor noise, ruled line, and a dark-blue signature.
await evaluate(`(async () => {
  const c = document.createElement('canvas'); c.width = 1000; c.height = 600
  const ctx = c.getContext('2d')
  const g = ctx.createLinearGradient(0, 0, 1000, 600)
  g.addColorStop(0, '#efe7d8'); g.addColorStop(0.5, '#e2d9c6'); g.addColorStop(1, '#cfc4ac')
  ctx.fillStyle = g; ctx.fillRect(0, 0, 1000, 600)
  const sh = ctx.createRadialGradient(820, 520, 60, 820, 520, 420)
  sh.addColorStop(0, 'rgba(70,60,40,0.35)'); sh.addColorStop(1, 'rgba(70,60,40,0)')
  ctx.fillStyle = sh; ctx.fillRect(0, 0, 1000, 600)
  const noise = ctx.getImageData(0, 0, 1000, 600)
  for (let i = 0; i < noise.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 14
    noise.data[i] += n; noise.data[i + 1] += n; noise.data[i + 2] += n
  }
  ctx.putImageData(noise, 0, 0)
  ctx.strokeStyle = 'rgba(90,80,60,0.5)'; ctx.lineWidth = 2
  ctx.beginPath(); ctx.moveTo(120, 430); ctx.lineTo(880, 430); ctx.stroke()
  ctx.strokeStyle = '#252e56'; ctx.lineCap = 'round'
  ctx.lineWidth = 7
  ctx.beginPath(); ctx.moveTo(160, 400)
  ctx.bezierCurveTo(230, 180, 300, 430, 380, 300)
  ctx.bezierCurveTo(450, 180, 490, 420, 610, 330)
  ctx.bezierCurveTo(700, 260, 760, 400, 850, 290)
  ctx.stroke()
  ctx.lineWidth = 4
  ctx.beginPath(); ctx.moveTo(380, 360); ctx.quadraticCurveTo(500, 480, 700, 380); ctx.stroke()
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85))
  const file = new File([blob], 'signature-photo.jpg', { type: 'image/jpeg' })
  const dt = new DataTransfer(); dt.items.add(file)
  const input = document.querySelector('input[type=file][accept="image/*"]')
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return true
})()`)
await sleep(1800) // debounce + extraction
await shot('08-photo-extract.png')

ws.close()
child.kill()
console.log('PHOTO SHOT DONE')
