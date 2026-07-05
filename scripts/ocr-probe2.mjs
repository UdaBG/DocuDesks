// Probe 2: run the tesseract core glue directly in the page (no worker) to
// see whether instantiation itself hangs in this Chromium.
import { spawn } from 'node:child_process'
import electronPath from 'electron'

const PORT = 9251
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
  if (r.result?.exceptionDetails) return 'THREW: ' + JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails).slice(0, 400)
  return r.result?.result?.value
}

try {
  await send('Page.enable')
  await sleep(2500)
  console.log(
    'core in page:',
    await evaluate(`(async () => {
      await new Promise((res, rej) => {
        const s = document.createElement('script')
        s.src = new URL('ocr/tesseract-core-simd-lstm.wasm.js', document.baseURI).href
        s.onload = res
        s.onerror = () => rej(new Error('script load failed'))
        document.head.append(s)
      })
      if (typeof TesseractCore !== 'function') return 'glue loaded but no TesseractCore'
      const result = await Promise.race([
        TesseractCore({}).then(() => 'instantiated OK'),
        new Promise((r) => setTimeout(() => r('TIMEOUT after 15s'), 15000)),
      ])
      return result
    })()`),
  )
} finally {
  child.kill()
}
