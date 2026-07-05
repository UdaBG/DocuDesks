// Open given PDFs in the app and screenshot the preview. node scripts/preview.mjs <shot.png> <pdf...>
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import electronPath from 'electron'

const [shotFile, ...pdfs] = process.argv.slice(2)
const PORT = 9224
const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, ...pdfs.map((p) => path.resolve(p))], {
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

for (let i = 0; i < 40; i++) {
  const n = await evaluate(`window.__signerStore ? window.__signerStore.getState().docs.length : 0`)
  if (n >= pdfs.length) break
  await sleep(400)
}
await sleep(1200)
const shot = await send('Page.captureScreenshot', { format: 'png' })
await writeFile(shotFile, Buffer.from(shot.data, 'base64'))
console.log('shot:', shotFile)
ws.close()
child.kill()
