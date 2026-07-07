// Regression: the Android file-pick safety net must NOT re-import the app's
// own save output. The mobile save path sets window.__signerSavingUntil (a
// suppression window) and records the saved URI in __signerSavedUris; the net
// (window.__androidPickedFiles) skips both. Open picks arriving outside a save
// are still added, so the lost-pick net keeps working.
// node scripts/save-suppress.mjs
import { spawn } from 'node:child_process'
import { copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import electronPath from 'electron'

const PORT = 9273
const TMP = path.join(os.tmpdir(), 'signer-savesuppress')
await mkdir(TMP, { recursive: true })
const src = path.resolve('samples', 'Leave_Request_Amara_Perera.pdf')
// distinct copies so the store's dedupe never masks a real add/skip
const g1 = path.join(TMP, 'saved-output.pdf')
const g2 = path.join(TMP, 'saved-by-uri.pdf')
const g3 = path.join(TMP, 'a-real-open.pdf')
await copyFile(src, g1)
await copyFile(src, g2)
await copyFile(src, g3)
const esc = (p) => p.replace(/\\/g, '\\\\')

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

try {
  await send('Page.enable')
  await waitFor(`!!window.__signerStore && !!window.__androidPickedFiles`, 'hooks')

  // 1. a save is in flight -> the created file is NOT re-imported
  await evaluate(`(window.__signerSavingUntil = Date.now() + 8000, true)`)
  await evaluate(`window.__androidPickedFiles(["${esc(g1)}"])`)
  await sleep(1500)
  const n1 = await evaluate(`${S}.docs.length`)
  console.log('docs after net delivery during save window:', n1)
  if (n1 !== 0) fail(`save output was re-imported despite the suppression window (${n1} docs)`)

  // 2. window expires -> the same net delivery is now honoured (net still works)
  await evaluate(`(window.__signerSavingUntil = 0, true)`)
  await evaluate(`window.__androidPickedFiles(["${esc(g1)}"])`)
  await waitFor(`${S}.docs.length === 1`, 'pick added after window expired')
  console.log('pick added once the save window expired')

  // 3. an exact saved URI is skipped even with no active window
  await evaluate(`(window.__signerSavedUris = new Set(["${esc(g2)}"]), true)`)
  await evaluate(`window.__androidPickedFiles(["${esc(g2)}"])`)
  await sleep(1500)
  const n3 = await evaluate(`${S}.docs.length`)
  console.log('docs after delivering a recorded saved URI:', n3)
  if (n3 !== 1) fail(`a recorded saved URI was re-imported (${n3} docs)`)

  // 4. a genuine open (not saved, no window) is still added
  await evaluate(`window.__androidPickedFiles(["${esc(g3)}"])`)
  await waitFor(`${S}.docs.length === 2`, 'genuine open still added')
  console.log('genuine open still added alongside')

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
