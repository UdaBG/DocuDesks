// Regression: smart detect on long contracts.
//  A) a strong "Signature:" label on an EARLY page beats a bare ruled line on
//     the last page (the old +3/page bonus inverted this on long docs)
//  B) "Detect again" re-runs detection after a manual override
// node scripts/smart-contract.mjs
import { spawn } from 'node:child_process'
import electronPath from 'electron'

const PORT = 9305
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
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800))
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
const S = `window.__signerStore.getState()`

try {
  await send('Page.enable')
  await waitFor(`!!window.__signerStore && !!window.__makeContractPdf`, 'hooks')

  // 12-page contract; the true signature label on page 3 (index 2)
  await evaluate(`(async () => {
    const bytes = new Uint8Array(await window.__makeContractPdf(12, 2))
    await ${S}.addFiles([{ name: 'contract.pdf', bytes }])
    return true
  })()`)
  await waitFor(`${S}.docs.length === 1`, 'doc added')
  await evaluate(`(${S}.setView('sign'), true)`) // the app now opens in Read; the hint lives in Sign
  const docId = await evaluate(`${S}.docs[0].id`)
  await evaluate(`(${S}.setMode('smart'), true)`)
  await waitFor(`${S}.docs[0].smart !== undefined && !${S}.detecting`, 'detection done', 60000)

  const smart = JSON.parse(await evaluate(`JSON.stringify(${S}.docs[0].smart)`))
  console.log('proposal:', JSON.stringify(smart))
  if (!smart) fail('no spot proposed at all')
  const page = smart.anchor === 'first' ? 0 : smart.anchor === 'last' ? 11 : Math.min(smart.pageIndex, 11)
  console.log('proposed page index:', page)
  if (page !== 2) fail(`proposal should land on the labelled page 3 (index 2), got ${page}`)

  // B. override the placement (as a drag would), then Detect again re-proposes
  await evaluate(`(window.__signerStore.setState((s) => ({ docs: s.docs.map((d) => d.id === '${docId}' ? { ...d, override: { anchor: 'custom', pageIndex: 0, x: 0.1, yb: 0.2, w: 0.3 } } : d) })), true)`)
  await waitFor(`!!${S}.docs[0].override`, 'override set')
  await waitFor(`!!document.querySelector('.hint-btn')`, 'redetect button visible')
  await evaluate(`(document.querySelector('.hint-btn').click(), true)`)
  await waitFor(`${S}.docs[0].smart !== undefined && !${S}.detecting`, 're-detection done', 60000)
  const after = JSON.parse(await evaluate(`JSON.stringify({ smart: ${S}.docs[0].smart, override: ${S}.docs[0].override ?? null })`))
  console.log('after redetect:', JSON.stringify(after))
  if (!after.smart) fail('redetect produced no proposal')
  if (after.override) fail('redetect should clear the manual override')

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
