// Regression: the Android file-pick safety net (window.__androidPickedFiles).
// Tauri's Android plugin can lose pick results when the activity is
// recreated behind the document picker; MainActivity forwards every result
// to this hook, which must add PDFs, de-duplicate double deliveries, and
// ignore non-PDF/empty targets (save-dialog creations).
// node scripts/pick-net.mjs
import { spawn } from 'node:child_process'
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import electronPath from 'electron'

const PORT = 9257
const TMP = path.join(os.tmpdir(), 'signer-picknet')
await mkdir(TMP, { recursive: true })
// a non-PDF and an empty file — both must be ignored by the net
const textFile = path.join(TMP, 'not-a-pdf.txt')
const emptyFile = path.join(TMP, 'fresh-save.pdf')
await writeFile(textFile, 'hello world, definitely not a pdf')
await writeFile(emptyFile, '')

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
const fail = (msg) => {
  console.error('FAIL:', msg)
  process.exitCode = 1
}
const S = `window.__signerStore.getState()`
const sample = path.resolve('samples', 'Leave_Request_Amara_Perera.pdf').replace(/\\/g, '\\\\')
const sample2 = path.resolve('samples', 'Leave_Request_Kasun_Fernando.pdf').replace(/\\/g, '\\\\')

try {
  await send('Page.enable')
  await waitFor(`!!window.__signerStore && !!window.__androidPickedFiles`, 'hooks')

  // 1. a real PDF arrives through the net -> added
  await evaluate(`window.__androidPickedFiles(["${sample}"])`)
  await waitFor(`${S}.docs.length === 1`, 'net-delivered pick added')
  console.log('net pick added:', await evaluate(`${S}.docs[0].name`))

  // 2. the SAME file again (double delivery: normal path + net) -> no dup
  await evaluate(`window.__androidPickedFiles(["${sample}"])`)
  await sleep(1200)
  const n2 = await evaluate(`${S}.docs.length`)
  console.log('docs after double delivery:', n2)
  if (n2 !== 1) fail(`double delivery duplicated the document (${n2} docs)`)

  // 3. non-PDF and empty (save-dialog creation) -> both ignored, no error docs
  await evaluate(`window.__androidPickedFiles(["${textFile.replace(/\\/g, '\\\\')}", "${emptyFile.replace(/\\/g, '\\\\')}"])`)
  await sleep(1200)
  const n3 = await evaluate(`${S}.docs.length`)
  console.log('docs after junk delivery:', n3)
  if (n3 !== 1) fail(`non-PDF/empty targets leaked into the list (${n3} docs)`)

  // 4. a second real PDF -> added alongside
  await evaluate(`window.__androidPickedFiles(["${sample2}"])`)
  await waitFor(`${S}.docs.length === 2`, 'second pick added')
  console.log('second net pick added')

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
