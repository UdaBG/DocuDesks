// Regression: Protect PDF (sign view). The dialog encrypts the FINALIZED
// document (edits + stamps baked) with the bundled qpdf and saves a
// *_protected.pdf copy that: cannot be opened without the password, opens
// fine with it (page count intact), and mismatched passwords never enable
// the button.
//   node scripts/protect-pdf.mjs
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import electronPath from 'electron'

const OUT = path.resolve('e2e-out-protect')
const PORT = 9285
await mkdir(OUT, { recursive: true })
const sample = path.resolve('samples', 'Service_Agreement.pdf')
const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, sample], {
  stdio: 'ignore',
  env: { ...process.env, VITE_DEV_SERVER_URL: '', SIGNER_OUTPUT_DIR: OUT },
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
const S = `window.__signerStore.getState()`
const PW = 'hunter-2-secret'
const setInput = (index, value) => `(() => {
  const el = document.querySelectorAll('.protect-field input')[${index}]
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  set.call(el, ${JSON.stringify(value)})
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`

try {
  await send('Page.enable')
  await waitFor(`!!window.__signerStore`, 'store')
  await waitFor(`${S}.docs.length >= 1`, 'doc loaded')
  await evaluate(`(${S}.setView('sign'), true)`)
  await sleep(400)

  // ---- 1. open the dialog from the sign panel ------------------------------
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.right-panel button')].find((b) => b.textContent.includes('Protect'))
    btn.click()
    return true
  })()`)
  await waitFor(`document.querySelectorAll('.protect-field input').length === 2`, 'protect dialog open')

  // ---- 2. mismatched passwords never enable the action ----------------------
  await evaluate(setInput(0, PW))
  await evaluate(setInput(1, 'different'))
  await sleep(150)
  const blocked = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.confirm-dialog .btn-primary')].pop()
    return { disabled: btn.disabled, warned: !!document.querySelector('.protect-error') }
  })()`)
  console.log('mismatch state:', JSON.stringify(blocked))
  if (!blocked.disabled || !blocked.warned) fail('mismatched passwords must disable the action and warn')

  // ---- 3. protect & save -----------------------------------------------------
  await evaluate(setInput(1, PW))
  await sleep(150)
  await evaluate(`(() => { [...document.querySelectorAll('.confirm-dialog .btn-primary')].pop().click(); return true })()`)
  await waitFor(`document.body.textContent.includes('_protected.pdf')`, 'saved confirmation', 60000)
  const savedPath = path.join(OUT, 'Service_Agreement_protected.pdf')
  if (!existsSync(savedPath)) fail(`protected file missing: ${savedPath}`)
  console.log('protected copy saved')

  // ---- 4. it must NOT open without the password -----------------------------
  const noPw = await evaluate(`window.__renderProbe(${JSON.stringify(savedPath)}, 0).then(() => 'opened', (e) => 'rejected: ' + (e && e.message ? e.message.slice(0, 60) : e))`)
  console.log('open without password:', noPw)
  if (!String(noPw).startsWith('rejected')) fail('protected file opened WITHOUT the password')

  // ---- 5. it opens with the password (page count intact) --------------------
  const unlocked = await evaluate(`window.__unlockProbe(${JSON.stringify(savedPath)}, ${JSON.stringify(PW)})`)
  console.log('decrypted with password:', JSON.stringify(unlocked))
  if (unlocked.pages !== 2) fail(`expected 2 pages after decrypt, got ${unlocked.pages}`)

  // ---- 6. round-trip: adding the protected file prompts for its password ----
  await evaluate(`(document.querySelector('.confirm-dialog .btn-primary').click(), true)`) // Done
  await evaluate(`${S}.addFromPaths([${JSON.stringify(savedPath)}])`)
  await waitFor(`${S}.docs.length === 2`, 'protected file added')
  const lockedDoc = await evaluate(`(() => { const d = ${S}.docs[1]; return { id: d.id, status: d.status, locked: !!d.locked } })()`)
  console.log('added protected file:', JSON.stringify(lockedDoc))
  if (lockedDoc.status !== 'error' || !lockedDoc.locked) fail('protected file should land as locked')
  await evaluate(`(${S}.selectDoc('${lockedDoc.id}'), true)`)
  await waitFor(`document.querySelectorAll('.protect-field input').length === 1`, 'password prompt open')

  // wrong password stays locked and says so
  await evaluate(`(() => {
    const el = document.querySelector('.protect-field input')
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    set.call(el, 'nope')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await evaluate(`(() => { [...document.querySelectorAll('.confirm-dialog .btn-primary')].pop().click(); return true })()`)
  await waitFor(`!!document.querySelector('.protect-error')`, 'wrong-password message')
  const stillLocked = await evaluate(`!!${S}.docs[1].locked`)
  console.log('wrong password rejected, still locked:', stillLocked)
  if (!stillLocked) fail('wrong password must not unlock')

  // right password opens it for real
  await evaluate(`(() => {
    const el = document.querySelector('.protect-field input')
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    set.call(el, ${JSON.stringify(PW)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await evaluate(`(() => { [...document.querySelectorAll('.confirm-dialog .btn-primary')].pop().click(); return true })()`)
  await waitFor(`(() => { const d = ${S}.docs[1]; return d.status === 'ready' && !d.locked && d.pageCount === 2 })()`, 'unlocked and readable', 30000)
  await evaluate(`(${S}.setView('read'), true)`)
  await waitFor(`!!document.querySelector('.read-stage canvas')`, 'unlocked doc renders')
  console.log('round-trip: protected file opened in-app with its password')

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
