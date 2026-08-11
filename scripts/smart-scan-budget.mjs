// Regression: smart detection on multi-page SCANNED documents.
// 1. The OCR budget: a 5-page scan with the signature on the last page must
//    resolve in seconds (OCR the likely pages, stop at real evidence) — not
//    OCR every page up front (minutes of silence on a phone).
// 2. Manual -> Smart re-triggers detection for docs whose last pass found
//    nothing (found spots and manual overrides are kept).
//   node scripts/smart-scan-budget.mjs
import { spawn } from 'node:child_process'
import electronPath from 'electron'

const PORT = 9276
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
const waitFor = async (expr, label, ms = 60000) => {
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
  await waitFor(`!!window.__signerStore`, 'store')

  // ---- 1. budgeted OCR: 5-page scan, signature on the LAST page ------------
  await evaluate(`(async () => {
    const bytes = await window.__makeScannedPdfPages(5, 4)
    ${S}.addGeneratedDoc('scan5.pdf', new Uint8Array(bytes), 5)
    return true
  })()`)
  await waitFor(`${S}.docs.length === 1`, 'doc added')
  const t0 = Date.now()
  await evaluate(`(${S}.setMode('smart'), true)`)
  await waitFor(`!${S}.detecting && ${S}.docs[0].smart !== undefined`, 'detection done', 90000)
  const elapsed = Date.now() - t0
  const smart = await evaluate(`${S}.docs[0].smart`)
  console.log(`5-page scan detected in ${(elapsed / 1000).toFixed(1)}s:`, JSON.stringify(smart))
  if (!smart) fail('signature spot on the last scan page not found')
  else if (smart.pageIndex !== 4) fail(`expected page 4, got ${smart.pageIndex}`)
  if (elapsed > 30000) fail(`detection too slow (${elapsed}ms) — OCR budget not effective`)
  const jumped = await evaluate(`${S}.previewPage`)
  if (jumped !== 4) fail(`previewPage should jump to the found page, got ${jumped}`)

  // ---- 2. manual -> smart re-runs docs that found nothing ------------------
  await evaluate(`(async () => {
    const bytes = await window.__makeScannedPdfPages(1, -1)
    ${S}.addGeneratedDoc('blank-scan.pdf', new Uint8Array(bytes), 1)
    return true
  })()`)
  await waitFor(`${S}.docs.length === 2`, 'second doc')
  await waitFor(`!${S}.detecting && ${S}.docs[1].smart !== undefined`, 'second detection', 90000)
  const none = await evaluate(`${S}.docs[1].smart`)
  if (none !== null) fail(`featureless scan should find nothing, got ${JSON.stringify(none)}`)
  const st = await evaluate(`${S}.docs[1].status`)
  if (st !== 'no-target') fail(`expected no-target status, got ${st}`)

  await evaluate(`(${S}.setMode('manual'), true)`)
  await sleep(200)
  // the synchronous part of setMode('smart') must reset the empty verdicts
  const resetNow = await evaluate(`(() => { ${S}.setMode('smart'); return ${S}.docs[1].smart === undefined })()`)
  console.log('manual->smart resets empty verdict for re-analysis:', resetNow)
  if (!resetNow) fail('switching back to smart did not queue a re-detection')
  await waitFor(`!${S}.detecting && ${S}.docs[1].smart !== undefined`, 're-detection', 90000)
  const again = await evaluate(`${S}.docs[1].smart`)
  console.log('re-detection verdict:', JSON.stringify(again))
  // the found spot on doc 0 must have survived the retry cycle
  const kept = await evaluate(`${S}.docs[0].smart?.pageIndex`)
  if (kept !== 4) fail(`doc 0's found spot was lost on re-trigger: ${kept}`)

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
