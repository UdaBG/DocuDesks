// Regression: the on-box quick colour chip (phones). It appears on the active
// text box while typing, opens the mixer, and recolours the WHOLE box; on
// desktop it is absent (the panel is used instead).
// node scripts/color-chip.mjs
import { spawn } from 'node:child_process'
import path from 'node:path'
import electronPath from 'electron'

const PORT = 9265
const sample = path.resolve('samples', 'Leave_Request_Amara_Perera.pdf')
const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, sample], {
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
const touch = (type, pts) =>
  send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y]) => ({ x, y })) })
const rectOf = (sel) =>
  evaluate(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })()`)
const fail = (msg) => {
  console.error('FAIL:', msg)
  process.exitCode = 1
}
const S = `window.__signerStore.getState()`
const E = `window.__editStore.getState()`

try {
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true })
  await waitFor(`!!window.__signerStore && !!window.__editStore`, 'stores')
  await waitFor(`${S}.docs.length >= 1`, 'doc')
  await evaluate(`(${S}.setView('edit'), true)`)
  await waitFor(`!!document.querySelector('.edit-overlay')`, 'overlay')
  await sleep(500)
  const docId = await evaluate(`${S}.docs[0].id`)

  // create a text box (tap), type into it
  await evaluate(`(${E}.setTool('text'), true)`)
  const ov = await rectOf('.edit-overlay')
  await touch('touchStart', [[ov.x + ov.w * 0.35, ov.y + ov.h * 0.4]])
  await sleep(30)
  await touch('touchEnd', [])
  await waitFor(`${E}.sessions['${docId}'] && ${E}.sessions['${docId}'].editingId`, 'text box open')
  await evaluate(`(() => {
    const el = document.querySelector('.eo-textarea')
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    set.call(el, 'Total')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)

  // 1. the chip is visible WHILE TYPING
  await waitFor(`!!document.querySelector('.eo-colorchip-btn')`, 'colour chip visible while typing')
  console.log('chip visible while typing')

  // ensure the textarea is focused (as it is while typing)
  await evaluate(`(document.querySelector('.eo-textarea')?.focus(), true)`)
  const focusedBefore = await evaluate(`(document.activeElement?.className || '').includes('eo-textarea')`)
  if (!focusedBefore) fail('textarea not focused before opening the mixer')

  // 2. tapping the chip opens the mixer AND drops the keyboard (blurs the
  // textarea) while keeping the box in edit mode
  await evaluate(`(() => {
    const b = document.querySelector('.eo-colorchip-btn')
    b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'touch' }))
    return true
  })()`)
  await waitFor(`!!document.querySelector('.eo-colorchip .color-popover')`, 'mixer opens from chip')
  const stillFocused = await evaluate(`(document.activeElement?.className || '').includes('eo-textarea')`)
  const stillOpen = await evaluate(`!!${E}.sessions['${docId}'].editingId`)
  console.log('mixer opened; textarea blurred (keyboard dropped):', !stillFocused, '; box still open:', stillOpen)
  if (stillFocused) fail('keyboard was not dropped — textarea still focused, mixer will be occluded')
  if (!stillOpen) fail('box closed when the mixer opened (blur guard failed)')

  // 3. choosing a colour recolours the WHOLE box
  await evaluate(`(() => {
    const inp = document.querySelector('.color-popover .cp-hex')
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(inp, '#b03060')
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(300)
  const color = await evaluate(`(() => {
    const s = ${E}.sessions['${docId}']
    return s.objects.find(o => o.kind === 'text')?.color
  })()`)
  console.log('text color after mixer:', color)
  if ((color ?? '').toLowerCase() !== '#b03060') fail(`whole-box color not applied: ${color}`)
  // the box must still be open (styling keeps editing)
  const stillEditing = await evaluate(`!!${E}.sessions['${docId}'].editingId`)
  if (!stillEditing) fail('the text box closed when using the colour chip')

  // 4. on DESKTOP width the chip is absent (panel is used instead)
  await evaluate(`(() => { document.querySelector('.eo-textarea')?.blur(); return true })()`)
  await sleep(200)
  await send('Emulation.clearDeviceMetricsOverride')
  await sleep(400)
  // select the box on desktop
  await evaluate(`(${E}.select('${docId}', ${E}.sessions['${docId}'].objects.find(o => o.kind === 'text').id), true)`)
  await sleep(300)
  const chipOnDesktop = await evaluate(`!!document.querySelector('.eo-colorchip-btn')`)
  console.log('chip present on desktop:', chipOnDesktop)
  if (chipOnDesktop) fail('colour chip should not appear on desktop (panel is used)')

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
