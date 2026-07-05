// Regression: styling an open retype box from the panel must not discard it,
// and colors (swatch + custom picker) must apply to the object.
import { spawn } from 'node:child_process'
import { mkdir, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import electronPath from 'electron'

const SHOT_DIR = path.resolve(process.argv[2] ?? 'e2e-shots')
const PORT = 9234
await mkdir(SHOT_DIR, { recursive: true })
const samples = (await readdir('samples')).filter((f) => f.endsWith('.pdf')).map((f) => path.resolve('samples', f))
const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, samples[0]], {
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

await send('Page.enable')
await waitFor(`!!window.__signerStore && !!window.__editStore`, 'stores')
await waitFor(`window.__signerStore.getState().docs.length >= 1`, 'doc')
await evaluate(`(window.__signerStore.getState().setView('edit'), true)`)
await waitFor(`!!document.querySelector('.edit-overlay')`, 'overlay')
const docId = await evaluate(`window.__signerStore.getState().docs[0].id`)
const S = () => `window.__editStore.getState().sessions['${docId}']`

// retype the title -> textarea open + focused
await evaluate(`(window.__editStore.getState().setTool('retype'), true)`)
await evaluate(`(() => {
  const el = document.querySelector('.edit-overlay')
  const r = el.getBoundingClientRect()
  const ev = (type) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, buttons: 1, clientX: r.left + 0.25 * r.width, clientY: r.top + 0.115 * r.height }))
  ev('pointerdown'); ev('pointerup')
  return true
})()`)
await waitFor(`${S()}.editingId`, 'editing')

// move focus into the panel like a real click on a color swatch would
await evaluate(`(() => {
  const sw = [...document.querySelectorAll('.right-panel .swatch')].find(s => s.getAttribute('aria-label') === '#bb3a30')
  sw.focus(); sw.click()
  return true
})()`)
await sleep(300)
let state = await evaluate(`(() => { const s = ${S()}; const o = s.objects.find(x => x.kind === 'text'); return { n: s.objects.length, color: o?.color, editing: !!s.editingId } })()`)
console.log('after panel swatch click:', JSON.stringify(state))
if (state.n !== 2) fail(`box was discarded during styling (objects=${state.n})`)
if (state.color !== '#bb3a30') fail(`swatch color not applied: ${state.color}`)

// custom picker: open popover, drag SV, verify object color follows
await evaluate(`(() => { const b = document.querySelector('.right-panel .swatch.custom'); b.focus(); b.click(); return true })()`)
await waitFor(`!!document.querySelector('.color-popover')`, 'popover')
await evaluate(`(() => {
  const sv = document.querySelector('.cp-sv')
  const r = sv.getBoundingClientRect()
  const ev = (type, x, y) => sv.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, buttons: 1, clientX: x, clientY: y }))
  ev('pointerdown', r.left + r.width * 0.9, r.top + r.height * 0.15)
  ev('pointerup', r.left + r.width * 0.9, r.top + r.height * 0.15)
  return true
})()`)
await sleep(250)
state = await evaluate(`(() => { const s = ${S()}; const o = s.objects.find(x => x.kind === 'text'); return { n: s.objects.length, color: o?.color } })()`)
console.log('after custom picker:', JSON.stringify(state))
if (state.n !== 2) fail(`box lost during custom picking (objects=${state.n})`)
if (!state.color || state.color === '#bb3a30') fail(`custom color not applied: ${state.color}`)

// commit by clicking the page — styled box must persist (fingerprint changed)
await evaluate(`(() => {
  const el = document.querySelector('.edit-overlay')
  const r = el.getBoundingClientRect()
  const ev = (type) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, buttons: 1, clientX: r.left + 0.5 * r.width, clientY: r.top + 0.9 * r.height }))
  ev('pointerdown'); ev('pointerup')
  return true
})()`)
await sleep(300)
state = await evaluate(`(() => { const s = ${S()}; return { n: s.objects.length, editing: !!s.editingId } })()`)
console.log('after commit:', JSON.stringify(state))
if (state.n !== 2) fail(`styled retype did not persist (objects=${state.n})`)
if (state.editing) fail('editing state not cleared')

const eyedrop = await evaluate(`'EyeDropper' in window`)
console.log('EyeDropper API available:', eyedrop)

// ---- in-app "sample from document" fallback (what the Tauri shell uses) ----
await evaluate(`(window.__forceInAppSample = true, true)`)
await evaluate(`(window.__editStore.getState().select('${docId}', null), true)`)
await evaluate(`(window.__editStore.getState().setTool('pen'), true)`)
await evaluate(`(() => { const b = document.querySelector('.right-panel .swatch.custom'); b.focus(); b.click(); return true })()`)
await waitFor(`!!document.querySelector('.color-popover')`, 'popover for sampling')
await evaluate(`(document.querySelector('.cp-eyedrop').click(), true)`)
await waitFor(`window.__editStore.getState().sampling`, 'sampling mode on')

// find a genuinely dark pixel of the title on the rendered canvas
const target = await evaluate(`(() => {
  const c = document.querySelector('.canvas-holder canvas')
  const ctx = c.getContext('2d')
  const y0 = Math.floor(c.height * 0.09), x0 = Math.floor(c.width * 0.10)
  const d = ctx.getImageData(x0, y0, Math.floor(c.width * 0.35), Math.floor(c.height * 0.05))
  for (let y = 0; y < d.height; y += 2) for (let x = 0; x < d.width; x += 2) {
    const i = (y * d.width + x) * 4
    if (0.3 * d.data[i] + 0.59 * d.data[i + 1] + 0.11 * d.data[i + 2] < 60) {
      return { fx: (x0 + x) / c.width, fy: (y0 + y) / c.height }
    }
  }
  return null
})()`)
if (!target) fail('no dark pixel found to sample')
console.log('sampling target:', JSON.stringify(target))

// hover first: the magnifier loupe must appear with a hex readout
await evaluate(`(() => {
  const el = document.querySelector('.edit-overlay')
  const r = el.getBoundingClientRect()
  el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: r.left + ${target.fx} * r.width, clientY: r.top + ${target.fy} * r.height }))
  return true
})()`)
await sleep(250)
const loupeInfo = await evaluate(`(() => { const l = document.querySelector('.loupe'); return l ? document.querySelector('.loupe-hex').textContent : null })()`)
console.log('loupe visible with hex:', loupeInfo)
if (!loupeInfo) fail('magnifier loupe did not appear while sampling')
{
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(path.join(SHOT_DIR, 'e08-loupe.png'), Buffer.from(shot.result.data, 'base64'))
  console.log('shot: e08-loupe.png')
}

await evaluate(`(() => {
  const el = document.querySelector('.edit-overlay')
  const r = el.getBoundingClientRect()
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, buttons: 1, clientX: r.left + ${target.fx} * r.width, clientY: r.top + ${target.fy} * r.height }))
  return true
})()`)
await sleep(300)
const sampled = await evaluate(`window.__editStore.getState().style.stroke`)
const stillOpen = await evaluate(`!!document.querySelector('.color-popover')`)
const samplingOff = await evaluate(`!window.__editStore.getState().sampling`)
console.log('in-app sampled stroke:', sampled, '| popover open:', stillOpen, '| sampling off:', samplingOff)
const lum = parseInt(sampled.slice(1, 3), 16) * 0.3 + parseInt(sampled.slice(3, 5), 16) * 0.59 + parseInt(sampled.slice(5, 7), 16) * 0.11
if (sampled === '#2f45c4') fail('sample did not apply (stroke still default)')
if (lum > 120) fail(`sampled color too light (${sampled}) — expected dark title ink`)
if (!stillOpen) fail('popover closed during sampling')
if (!samplingOff) fail('sampling mode stuck on')

const r2 = await send('Page.captureScreenshot', { format: 'png' })
await writeFile(path.join(SHOT_DIR, 'e07-picker-style.png'), Buffer.from(r2.result.data, 'base64'))
ws.close()
child.kill()
console.log(process.exitCode ? 'PICKER REGRESSION FAILED' : 'PICKER REGRESSION PASSED')
