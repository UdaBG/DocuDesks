// Probe: which OCR asset-loading mechanisms work inside packaged Electron?
import { spawn } from 'node:child_process'
import electronPath from 'electron'

const PORT = 9249
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
  if (r.result?.exceptionDetails) return 'THREW: ' + JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails).slice(0, 300)
  return r.result?.result?.value
}

try {
  await send('Page.enable')
  await sleep(3000)
  console.log('baseURI:', await evaluate(`document.baseURI`))
  console.log(
    'fetch worker.min.js:',
    await evaluate(`fetch(new URL('ocr/worker.min.js', document.baseURI).href).then(r => 'status ' + r.status + ' len ' + r.headers.get('content-length')).catch(e => 'FAIL: ' + e.message)`),
  )
  console.log(
    'fetch traineddata:',
    await evaluate(`fetch(new URL('ocr/eng.traineddata.gz', document.baseURI).href).then(r => r.arrayBuffer()).then(b => 'ok bytes ' + b.byteLength).catch(e => 'FAIL: ' + e.message)`),
  )
  console.log(
    'direct Worker(file://):',
    await evaluate(`new Promise((res) => {
      try {
        const w = new Worker(new URL('ocr/worker.min.js', document.baseURI).href)
        w.onerror = (e) => res('worker error: ' + e.message)
        setTimeout(() => res('worker constructed, no error in 1.5s'), 1500)
      } catch (e) { res('THREW: ' + e.message) }
    })`),
  )
  console.log(
    'XHR worker.min.js:',
    await evaluate(`new Promise((res) => {
      const x = new XMLHttpRequest()
      x.open('GET', new URL('ocr/worker.min.js', document.baseURI).href)
      x.responseType = 'arraybuffer'
      x.onload = () => res('ok bytes ' + x.response.byteLength)
      x.onerror = () => res('XHR FAIL status ' + x.status)
      x.send()
    })`),
  )

  // full self-test with progress log
  const testPromise = evaluate(`window.__ocrSelfTest()`)
  let done = false
  void testPromise.then(() => (done = true))
  for (let i = 0; i < 30 && !done; i++) {
    await sleep(2000)
    console.log(`log @${(i + 1) * 2}s:`, JSON.stringify(await evaluate(`window.__ocrLog ?? []`)))
  }
  console.log('selfTest:', await testPromise)
} finally {
  child.kill()
}
