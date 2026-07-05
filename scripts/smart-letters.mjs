// Regression: smart detect on letter-style documents (sign-off convention and
// Word-style drawn signature lines).
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import electronPath from 'electron'

const SHOT_DIR = path.resolve(process.argv[2] ?? 'e2e-shots')
const PORT = 9236
await mkdir(SHOT_DIR, { recursive: true })
const files = ['samples/Reference_Letter.pdf', 'samples/SigLine_Letter.pdf'].map((f) => path.resolve(f))
const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, ...files], {
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
const waitFor = async (expr, label, ms = 30000) => {
  const start = Date.now()
  for (;;) {
    if (await evaluate(expr)) return
    if (Date.now() - start > ms) throw new Error('timeout: ' + label)
    await sleep(300)
  }
}
const fail = (msg) => {
  console.error('FAIL:', msg)
  process.exitCode = 1
}

await send('Page.enable')
await waitFor(`!!window.__signerStore`, 'store')
await waitFor(`window.__signerStore.getState().docs.length >= 2`, 'docs')
await evaluate(`(window.__signerStore.getState().setMode('smart'), true)`)
await waitFor(
  `(() => { const s = window.__signerStore.getState(); return !s.detecting && s.docs.every(d => d.smart !== undefined) })()`,
  'detection',
)
const results = await evaluate(
  `window.__signerStore.getState().docs.map(d => ({ name: d.name, smart: d.smart }))`,
)
console.log(JSON.stringify(results, null, 1))

const letter = results.find((r) => r.name.includes('Reference_Letter'))
const sigline = results.find((r) => r.name.includes('SigLine_Letter'))
if (!letter?.smart) fail('sign-off letter: nothing detected')
else {
  // expected: above the typed name PARKER MCLEAN (name top ≈ 221pt from bottom → yb ≈ 0.737)
  if (letter.smart.yb < 0.68 || letter.smart.yb > 0.78) fail(`letter spot yb=${letter.smart.yb.toFixed(3)} not in the closing→name gap`)
  if (letter.smart.x > 0.2) fail(`letter spot x=${letter.smart.x.toFixed(3)} not at the left margin`)
}
if (!sigline?.smart) fail('Word-style sig line: nothing detected')
else {
  // expected: on the drawn line at y=470pt → yb ≈ 1 - 472/841.89 ≈ 0.439
  if (Math.abs(sigline.smart.yb - 0.439) > 0.04) fail(`sig-line spot yb=${sigline.smart.yb.toFixed(3)} not on the drawn line`)
}

// visual check of the second doc's proposal
await evaluate(`(() => { const s = window.__signerStore.getState(); s.selectDoc(s.docs.find(d => d.name.includes('SigLine')).id); return true })()`)
await sleep(1000)
const shot = await send('Page.captureScreenshot', { format: 'png' })
await writeFile(path.join(SHOT_DIR, 'e10-smart-letters.png'), Buffer.from(shot.result.data, 'base64'))
ws.close()
child.kill()
console.log(process.exitCode ? 'SMART LETTERS FAILED' : 'SMART LETTERS PASSED')
