// Screenshot the signature studio tabs. node scripts/studio-shot.mjs <shotDir>
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import electronPath from 'electron'

const SHOT_DIR = path.resolve(process.argv[2] ?? 'e2e-shots')
await mkdir(SHOT_DIR, { recursive: true })
const PORT = 9225
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

for (let i = 0; i < 40; i++) {
  if (await evaluate(`!!window.__signerStore`)) break
  await sleep(400)
}
await evaluate(`(window.__signerStore.getState().openStudio(), true)`)
await sleep(500)

// draw two strokes programmatically on the draw canvas
await evaluate(`(() => {
  const canvas = document.querySelector('.draw-paper canvas')
  const rect = canvas.getBoundingClientRect()
  const fire = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, {
    bubbles: true, pointerId: 1, pointerType: 'mouse', pressure: 0.5,
    clientX: rect.left + x, clientY: rect.top + y, buttons: 1,
  }))
  fire('pointerdown', 60, 150)
  for (let i = 0; i <= 40; i++) {
    const t = i / 40
    fire('pointermove', 60 + t * 420, 150 + Math.sin(t * Math.PI * 3) * 55 - t * 20)
  }
  fire('pointerup', 480, 130)
  return true
})()`)
await sleep(500)
await shot('06-studio-draw.png')

// type tab with a real name
await evaluate(`(document.querySelectorAll('.studio-tab')[2].click(), true)`)
await sleep(300)
await evaluate(`(() => {
  const input = document.querySelector('.type-input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, 'Uda Bhagya')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await sleep(1200)
await shot('07-studio-type.png')

ws.close()
child.kill()
console.log('STUDIO SHOTS DONE')
