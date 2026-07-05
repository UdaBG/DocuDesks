// Verify the phone layout: emulate a 390x844 viewport in the real app via CDP
// and walk the bottom tabs. node scripts/mobile-shot.mjs <shotDir>
import { spawn } from 'node:child_process'
import { mkdir, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import electronPath from 'electron'

const SHOT_DIR = path.resolve(process.argv[2] ?? 'e2e-shots')
await mkdir(SHOT_DIR, { recursive: true })
const PORT = 9227
const samples = (await readdir('samples')).filter((f) => f.endsWith('.pdf')).map((f) => path.resolve('samples', f))
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
    pending.get(m.id)(m.result)
    pending.delete(m.id)
  }
}
const send = (method, params = {}) =>
  new Promise((res) => {
    pending.set(++id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression) =>
  (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(path.join(SHOT_DIR, name), Buffer.from(r.data, 'base64'))
  console.log('shot:', name)
}

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
})

for (let i = 0; i < 40; i++) {
  const n = await evaluate(`window.__signerStore ? window.__signerStore.getState().docs.length : 0`)
  if (n >= samples.length) break
  await sleep(400)
}

// a saved signature so the sign tab shows the overlay
await evaluate(`(() => {
  const c = document.createElement('canvas'); c.width = 600; c.height = 200
  const ctx = c.getContext('2d')
  ctx.strokeStyle = '#26357c'; ctx.lineWidth = 6; ctx.lineCap = 'round'
  ctx.beginPath(); ctx.moveTo(40, 140)
  ctx.bezierCurveTo(120, 20, 180, 185, 260, 85)
  ctx.bezierCurveTo(330, 10, 380, 165, 560, 55)
  ctx.stroke()
  window.__signerStore.getState().addSignature({ name: 'Mobile ink', dataUrl: c.toDataURL('image/png'), width: 600, height: 200 })
  return true
})()`)
await sleep(1200)
await shot('m01-sign.png')

await evaluate(`(document.querySelectorAll('.mobile-tab')[0].click(), true)`)
await sleep(400)
await shot('m02-docs.png')

await evaluate(`(document.querySelectorAll('.mobile-tab')[2].click(), true)`)
await sleep(400)
await shot('m03-sigs.png')

await evaluate(`(window.__signerStore.getState().openStudio(), true)`)
await sleep(400)
await evaluate(`(document.querySelectorAll('.studio-tab')[2].click(), true)`)
await evaluate(`(() => {
  const input = document.querySelector('.type-input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, 'Uda Bhagya')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await sleep(1200)
await shot('m04-studio.png')

ws.close()
child.kill()
console.log('MOBILE SHOTS DONE')
