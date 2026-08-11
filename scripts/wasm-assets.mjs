// Regression: pdf.js's wasm image decoders must be bundled and reachable.
// Without them, JBIG2/CCITT-fax and JPEG2000 scans render BLANK with only a
// "Dependent image isn't ready yet" warning (the decode fails silently in the
// worker). Checks the built assets exist and that the app resolves + fetches
// them from its real base URI with a valid wasm magic number.
// node scripts/wasm-assets.mjs
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import electronPath from 'electron'

const fail = (msg) => {
  console.error('FAIL:', msg)
  process.exitCode = 1
}

// 1. built assets present
const needed = ['jbig2.wasm', 'jbig2_nowasm_fallback.js', 'openjpeg.wasm', 'openjpeg_nowasm_fallback.js', 'qcms_bg.wasm']
for (const f of needed) {
  try {
    const b = await readFile(`dist/pdfjs-wasm/${f}`)
    if (f.endsWith('.wasm') && !(b[0] === 0 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d)) {
      fail(`dist/pdfjs-wasm/${f} lacks the \\0asm magic`)
    }
  } catch {
    fail(`dist/pdfjs-wasm/${f} missing from the build`)
  }
}
console.log('built assets present')

// 2. the running app can fetch them from its own base URI
const PORT = 9301
const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], {
  stdio: 'ignore',
  env: { ...process.env, VITE_DEV_SERVER_URL: '' },
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
try {
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
  for (let i = 0; i < 40; i++) {
    const ok = await evaluate(`!!window.__signerStore`).catch(() => false)
    if (ok) break
    await sleep(500)
  }
  const res = await evaluate(`(async () => {
    const url = new URL('pdfjs-wasm/jbig2.wasm', document.baseURI).href
    const r = await fetch(url)
    const b = new Uint8Array(await r.arrayBuffer())
    return JSON.stringify({ url, ok: r.ok !== false, bytes: b.length, magic: b[0] === 0 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d })
  })()`)
  console.log('in-app fetch:', res)
  const j = JSON.parse(res)
  if (!j.magic || j.bytes < 1000) fail('app could not fetch a valid jbig2.wasm from its base URI')
  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
