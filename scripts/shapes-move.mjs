// Regression: stroke-only (unfilled) shapes must be movable by grabbing their
// INTERIOR with the select tool — SVG's default hit-testing only hits the
// painted stroke, which made hollow rects/ellipses feel immovable.
// node scripts/shapes-move.mjs
import { spawn } from 'node:child_process'
import path from 'node:path'
import electronPath from 'electron'

const PORT = 9285
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
const fail = (msg) => {
  console.error('FAIL:', msg)
  process.exitCode = 1
}
const S = `window.__signerStore.getState()`
const E = `window.__editStore.getState()`

try {
  await send('Page.enable')
  await waitFor(`!!window.__signerStore && !!window.__editStore`, 'stores')
  await waitFor(`${S}.docs.length >= 1`, 'doc')
  const docId = await evaluate(`${S}.docs[0].id`)
  await evaluate(`(${S}.setView('edit'), true)`)
  await waitFor(`!!document.querySelector('.edit-overlay')`, 'edit overlay')
  await sleep(500)

  // an UNFILLED rect and ellipse, plus a rotated unfilled rect
  await evaluate(`(() => {
    const pageId = ${E}.sessions['${docId}'].pages[0].id
    ${E}.addObject('${docId}', { id: 'mr1', pageId, kind: 'rect', x: 0.2, y: 0.2, w: 0.25, h: 0.15, stroke: '#bb3a30', strokeWidthPt: 2, fill: null, opacity: 1 })
    ${E}.addObject('${docId}', { id: 'me1', pageId, kind: 'ellipse', x: 0.55, y: 0.2, w: 0.2, h: 0.12, stroke: '#26357c', strokeWidthPt: 2, fill: null, opacity: 1 })
    ${E}.addObject('${docId}', { id: 'mr2', pageId, kind: 'rect', x: 0.3, y: 0.55, w: 0.25, h: 0.12, stroke: '#1c7c54', strokeWidthPt: 2, fill: null, opacity: 1, rot: 45 })
    ${E}.setTool('select')
    return true
  })()`)
  await sleep(300)

  const dragInterior = async (objId, fx, fy) => {
    return evaluate(`(() => {
      const ov = document.querySelector('.edit-overlay'); const r = ov.getBoundingClientRect()
      const cx = r.left + ${fx} * r.width, cy = r.top + ${fy} * r.height
      const el = document.elementFromPoint(cx, cy)
      if (!el || !el.closest('svg')) return 'no-svg-hit'
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 5, pointerType: 'mouse', buttons: 1, clientX: cx, clientY: cy }))
      ov.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 5, pointerType: 'mouse', buttons: 1, clientX: cx + 40, clientY: cy + 30 }))
      ov.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 5, pointerType: 'mouse' }))
      return 'dragged'
    })()`)
  }

  // 1. hollow rect: grab dead centre (NOT the stroke)
  const r1 = await dragInterior('mr1', 0.2 + 0.125, 0.2 + 0.075)
  const rectAfter = JSON.parse(await evaluate(`JSON.stringify(${E}.sessions['${docId}'].objects.find(o => o.id === 'mr1'))`))
  console.log(`hollow rect: ${r1}; x 0.200 -> ${rectAfter.x.toFixed(3)}`)
  if (r1 !== 'dragged') fail(`rect interior did not hit an SVG element (${r1})`)
  if (Math.abs(rectAfter.x - 0.2) < 0.01) fail('hollow rect did not move when grabbed by its interior')

  // 2. hollow ellipse: grab centre
  const r2 = await dragInterior('me1', 0.55 + 0.1, 0.2 + 0.06)
  const ellAfter = JSON.parse(await evaluate(`JSON.stringify(${E}.sessions['${docId}'].objects.find(o => o.id === 'me1'))`))
  console.log(`hollow ellipse: ${r2}; x 0.550 -> ${ellAfter.x.toFixed(3)}`)
  if (Math.abs(ellAfter.x - 0.55) < 0.01) fail('hollow ellipse did not move when grabbed by its interior')

  // 3. ROTATED hollow rect: its centre is rotation-invariant — grab there
  const r3 = await dragInterior('mr2', 0.3 + 0.125, 0.55 + 0.06)
  const rotAfter = JSON.parse(await evaluate(`JSON.stringify(${E}.sessions['${docId}'].objects.find(o => o.id === 'mr2'))`))
  console.log(`rotated hollow rect: ${r3}; x 0.300 -> ${rotAfter.x.toFixed(3)} (rot ${rotAfter.rot})`)
  if (Math.abs(rotAfter.x - 0.3) < 0.01) fail('rotated hollow rect did not move when grabbed by its interior')
  if (rotAfter.rot !== 45) fail('rotation changed during a plain move')

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
}
