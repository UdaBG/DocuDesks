// E2E for the edit-mode rework: real (trusted) clicks + typing via CDP Input,
// full font list, retype accuracy, pen variants, eraser, image watermark.
// node scripts/edit-shot2.mjs <outDir> <shotDir>
import { spawn } from 'node:child_process'
import { mkdir, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import electronPath from 'electron'

const OUT_DIR = path.resolve(process.argv[2] ?? 'e2e-out-edit2')
const SHOT_DIR = path.resolve(process.argv[3] ?? 'e2e-shots')
const PORT = 9229
await mkdir(OUT_DIR, { recursive: true })
await mkdir(SHOT_DIR, { recursive: true })

const samples = (await readdir('samples')).filter((f) => f.endsWith('.pdf')).map((f) => path.resolve('samples', f))
const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, samples[0]], {
  stdio: 'ignore',
  env: { ...process.env, SIGNER_OUTPUT_DIR: OUT_DIR, VITE_DEV_SERVER_URL: '' },
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
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(path.join(SHOT_DIR, name), Buffer.from(r.result.data, 'base64'))
  console.log('shot:', name)
}
const waitFor = async (expr, label, ms = 20000) => {
  const start = Date.now()
  for (;;) {
    if (await evaluate(expr)) return
    if (Date.now() - start > ms) throw new Error('timeout: ' + label)
    await sleep(300)
  }
}

async function realClick(fx, fy) {
  const pt = await evaluate(
    `(() => { const r = document.querySelector('.edit-overlay').getBoundingClientRect(); return { x: r.left + ${fx} * r.width, y: r.top + ${fy} * r.height } })()`,
  )
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
}

const HELPERS = `window.__drag = (points) => {
  const el = document.querySelector('.edit-overlay')
  const r = el.getBoundingClientRect()
  const ev = (type, fx, fy) => el.dispatchEvent(new PointerEvent(type, {
    bubbles: true, pointerId: 1, pointerType: 'mouse', pressure: 0.5, buttons: 1,
    clientX: r.left + fx * r.width, clientY: r.top + fy * r.height,
  }))
  ev('pointerdown', points[0][0], points[0][1])
  for (let i = 1; i < points.length; i++) ev('pointermove', points[i][0], points[i][1])
  const last = points[points.length - 1]
  ev('pointerup', last[0], last[1])
}; true`

try {
  await send('Page.enable')
  await waitFor(`!!window.__signerStore && !!window.__editStore`, 'stores')
  await waitFor(`window.__signerStore.getState().docs.length >= 1`, 'doc loaded')
  await evaluate(`(window.__signerStore.getState().setView('edit'), true)`)
  await waitFor(`!!document.querySelector('.edit-overlay')`, 'edit overlay')
  await evaluate(HELPERS)
  const docId = await evaluate(`window.__signerStore.getState().docs[0].id`)
  const E = (fn) => evaluate(`(window.__editStore.getState().${fn}, true)`)
  const objects = () => evaluate(`window.__editStore.getState().sessions['${docId}'].objects.map(o => ({kind:o.kind, text:o.text, font:o.fontId, size:o.sizePt, bold:o.bold}))`)

  // ---- 1. font list via Local Font Access
  const fontCount = await evaluate(
    `window.queryLocalFonts ? (async () => { try { return (await window.queryLocalFonts()).length } catch (e) { return 'ERR:' + e.message } })() : 'unsupported'`,
  )
  console.log('queryLocalFonts faces:', fontCount)

  // ---- 2. TEXT TOOL with real trusted input (the focus-steal regression)
  await E(`setTool('text')`)
  await realClick(0.55, 0.62)
  await sleep(400)
  const taAlive = await evaluate(`!!document.querySelector('.eo-textarea')`)
  console.log('text tool: textarea survives real click =', taAlive)
  await send('Input.insertText', { text: 'Typed with real keys' })
  await sleep(300)
  await realClick(0.2, 0.8) // click away -> commits (second click of text tool while editing)
  await sleep(300)
  console.log('after text:', JSON.stringify(await objects()))

  // ---- 3. RETYPE with real click: full-run join + font match + tool stays
  await E(`setTool('retype')`)
  await realClick(0.25, 0.115)
  await waitFor(`!!document.querySelector('.eo-textarea')`, 'retype textarea')
  const retyped = await evaluate(`(() => { const s = window.__editStore.getState().sessions['${docId}']; const o = s.objects.find(x => x.id === s.editingId); return { text: o.text, font: o.fontId, size: o.sizePt, bold: o.bold } })()`)
  console.log('retype grabbed:', JSON.stringify(retyped))
  await send('Input.insertText', { text: ' — OK' })
  await sleep(250)
  await realClick(0.2, 0.8)
  await sleep(250)
  console.log('tool after retype:', await evaluate(`window.__editStore.getState().tool`))

  // ---- 4. pen variants
  await E(`setStyle({ pen: 'marker', stroke: '#bb3a30' })`)
  await E(`setTool('pen')`)
  await evaluate(`window.__drag([[0.12,0.5],[0.2,0.46],[0.28,0.53],[0.36,0.47]])`)
  await E(`setStyle({ pen: 'highlight', stroke: '#ffe066' })`)
  await evaluate(`window.__drag([[0.36,0.34],[0.7,0.34]])`)
  const beforeErase = await evaluate(`window.__editStore.getState().sessions['${docId}'].objects.length`)

  // ---- 5. eraser removes the marker stroke
  await E(`setTool('erase')`)
  await evaluate(`window.__drag([[0.1,0.5],[0.2,0.48],[0.3,0.5]])`)
  const afterErase = await evaluate(`window.__editStore.getState().sessions['${docId}'].objects.length`)
  console.log('eraser: objects', beforeErase, '->', afterErase)

  // ---- 6. bold/underline/highlight on the typed text via store patch
  await evaluate(`(() => {
    const st = window.__editStore.getState()
    const s = st.sessions['${docId}']
    const o = s.objects.find(x => x.kind === 'text' && x.text.startsWith('Typed'))
    st.updateObject('${docId}', o.id, { bold: true, underline: true, highlight: '#ffe066' })
    return true
  })()`)

  // ---- 7. image watermark (generated logo-ish canvas)
  await evaluate(`(() => {
    const c = document.createElement('canvas'); c.width = 300; c.height = 300
    const ctx = c.getContext('2d')
    ctx.strokeStyle = '#2f45c4'; ctx.lineWidth = 16
    ctx.beginPath(); ctx.arc(150, 150, 110, 0, Math.PI * 2); ctx.stroke()
    ctx.font = '900 130px Arial'; ctx.fillStyle = '#2f45c4'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('S', 150, 160)
    window.__editStore.getState().setWatermark('${docId}', {
      kind: 'image', text: '', sizePt: 56, color: '#bb3a30',
      image: { dataUrl: c.toDataURL('image/png'), w: 300, h: 300 },
      scale: 0.35, opacity: 0.15, angleDeg: 0, tile: false,
    })
    return true
  })()`)
  await sleep(700)
  await shot('e03-edit-v2.png')

  // ---- 8. save + reopen
  await evaluate(`(document.querySelector('.actionbar .btn-primary').click(), true)`)
  await waitFor(`!!window.__editStore.getState().savedPath`, 'saved')
  const saved = await evaluate(`window.__editStore.getState().savedPath`)
  console.log('saved:', saved)
  await evaluate(`window.__signerStore.getState().addFromPaths([${JSON.stringify(saved)}])`)
  await waitFor(`window.__signerStore.getState().docs.length >= 2`, 'reopened')
  await evaluate(`(() => {
    const s = window.__signerStore.getState()
    const d = s.docs.find(d => d.name.includes('_edited'))
    s.setView('sign'); s.selectDoc(d.id); s.setPreviewPage(0)
    return true
  })()`)
  await sleep(1200)
  await shot('e04-edited-v2-output.png')
} finally {
  ws.close()
  child.kill()
}
console.log('EDIT V2 E2E DONE')
