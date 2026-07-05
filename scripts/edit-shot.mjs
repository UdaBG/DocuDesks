// E2E for edit mode: real pointer gestures for each tool, watermark, page ops,
// save through the UI, then reopen the saved file to verify baked content.
// node scripts/edit-shot.mjs <outDir> <shotDir>
import { spawn } from 'node:child_process'
import { mkdir, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import electronPath from 'electron'

const OUT_DIR = path.resolve(process.argv[2] ?? 'e2e-out-edit')
const SHOT_DIR = path.resolve(process.argv[3] ?? 'e2e-shots')
const PORT = 9228
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

// helper injected once: dispatch a pointer drag on the edit overlay
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

  // pen stroke
  await E(`setTool('pen')`)
  await evaluate(`window.__drag([[0.12,0.52],[0.16,0.46],[0.2,0.55],[0.25,0.47],[0.3,0.54],[0.35,0.48],[0.4,0.52]])`)
  // rectangle
  await E(`setTool('rect')`)
  await evaluate(`window.__drag([[0.55,0.44],[0.85,0.55]])`)
  // arrow
  await E(`setTool('arrow')`)
  await evaluate(`window.__drag([[0.48,0.66],[0.72,0.59]])`)
  // whiteout over the "Reason" value
  await E(`setTool('whiteout')`)
  await evaluate(`window.__drag([[0.36,0.455],[0.7,0.492]])`)
  // text box
  await E(`setTool('text')`)
  await evaluate(`window.__drag([[0.56,0.62],[0.56,0.62]])`)
  await sleep(300)
  await evaluate(`(() => {
    const ta = document.querySelector('.eo-textarea')
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, 'Reviewed by HR')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.blur()
    return true
  })()`)
  await sleep(200)

  // retype the title
  await E(`setTool('retype')`)
  await evaluate(`window.__drag([[0.2,0.115],[0.2,0.115]])`)
  await waitFor(`!!document.querySelector('.eo-textarea')`, 'retype textarea')
  await evaluate(`(() => {
    const ta = document.querySelector('.eo-textarea')
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, 'Annual Leave Request — APPROVED')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.blur()
    return true
  })()`)
  await sleep(200)

  // watermark + pages
  await E(`setWatermark('${docId}', { text: 'APPROVED', sizePt: 64, color: '#17804d', opacity: 0.14, angleDeg: 30, tile: false })`)
  await E(`addBlankPage('${docId}', 0)`)
  await E(`setPageIndex('${docId}', 0)`)
  await E(`duplicatePage('${docId}', 0)`)
  await E(`setPageIndex('${docId}', 0)`)
  await sleep(900)
  await shot('e01-edit-mode.png')

  const before = await evaluate(`window.__editStore.getState().savedPath`)
  await evaluate(`(document.querySelector('.actionbar .btn-primary').click(), true)`)
  await waitFor(
    `window.__editStore.getState().savedPath && window.__editStore.getState().savedPath !== ${JSON.stringify(before)}`,
    'saved',
  )
  const saved = await evaluate(`window.__editStore.getState().savedPath`)
  console.log('saved edited pdf:', saved)

  // reopen the output and inspect it in sign view
  await evaluate(`window.__signerStore.getState().addFromPaths([${JSON.stringify(saved)}])`)
  await waitFor(`window.__signerStore.getState().docs.length >= 2`, 'edited doc loaded')
  await evaluate(`(() => {
    const s = window.__signerStore.getState()
    const d = s.docs.find(d => d.name.includes('_edited'))
    s.setView('sign'); s.selectDoc(d.id); s.setPreviewPage(0)
    return true
  })()`)
  await sleep(1200)
  await shot('e02-edited-output.png')
  const pages = await evaluate(
    `window.__signerStore.getState().docs.find(d => d.name.includes('_edited')).pageCount`,
  )
  console.log('edited output pages:', pages, '(expected 3)')
} finally {
  ws.close()
  child.kill()
}
console.log('EDIT E2E DONE')
