// Open the custom color picker popover and screenshot + verify it applies.
import { spawn } from 'node:child_process'
import { mkdir, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import electronPath from 'electron'

const SHOT_DIR = path.resolve(process.argv[2] ?? 'e2e-shots')
const PORT = 9233
await mkdir(SHOT_DIR, { recursive: true })
const samples = (await readdir('samples')).filter((f) => f.endsWith('.pdf')).map((f) => path.resolve('samples', f))
const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, samples[0]], {
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

await send('Page.enable')
await waitFor(`!!window.__signerStore && !!window.__editStore`, 'stores')
await waitFor(`window.__signerStore.getState().docs.length >= 1`, 'doc')
await evaluate(`(window.__signerStore.getState().setView('edit'), true)`)
await evaluate(`(window.__editStore.getState().setTool('pen'), true)`)
await waitFor(`!!document.querySelector('.swatch.custom')`, 'custom swatch')
await evaluate(`(document.querySelector('.swatch.custom').click(), true)`)
await waitFor(`!!document.querySelector('.color-popover')`, 'popover open')

// pick a spot in the SV square + move hue, then check the style updated
await evaluate(`(() => {
  const sv = document.querySelector('.cp-sv')
  const r = sv.getBoundingClientRect()
  const ev = (type, x, y) => sv.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, buttons: 1, clientX: x, clientY: y }))
  ev('pointerdown', r.left + r.width * 0.8, r.top + r.height * 0.3)
  ev('pointerup', r.left + r.width * 0.8, r.top + r.height * 0.3)
  return true
})()`)
await evaluate(`(() => {
  const hue = document.querySelector('.cp-hue')
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  set.call(hue, '140')
  hue.dispatchEvent(new Event('change', { bubbles: true }))
  hue.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await sleep(300)
const stroke = await evaluate(`window.__editStore.getState().style.stroke`)
console.log('stroke after picking:', stroke)
const r = await send('Page.captureScreenshot', { format: 'png' })
await writeFile(path.join(SHOT_DIR, 'e06-color-picker.png'), Buffer.from(r.result.data, 'base64'))
console.log('shot: e06-color-picker.png')

// outside click closes
await evaluate(`(document.querySelector('.stage').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })), true)`)
await sleep(200)
const closed = await evaluate(`!document.querySelector('.color-popover')`)
console.log('popover closed on outside click:', closed)
ws.close()
child.kill()
console.log('PICKER TEST DONE')
