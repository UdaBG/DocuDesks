// Regression: in-place updates must load the previous version's user data.
// An update is exactly "new code + old data dir" (the installers carry no
// migration), so this seeds data files as an older version wrote them and
// runs the CURRENT code against them — no installation involved. The user's
// real files are backed up and restored.
// node scripts/update-data.mjs
import { spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import electronPath from 'electron'

const PORT = 9283
const dataDir = path.join(process.env.APPDATA, 'DocuDesk')
await mkdir(dataDir, { recursive: true })
const sigFile = path.join(dataDir, 'signatures.json')
const setFile = path.join(dataDir, 'settings.json')

// back up the real files
const backups = []
for (const f of [sigFile, setFile]) {
  if (existsSync(f)) {
    await copyFile(f, f + '.bak-updatetest')
    backups.push(f)
  }
}

// a tiny valid signature PNG (2x1 blue pixel)
const dataUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADUlEQVR4nGNgYPj/HwADAgH/p+FGhwAAAABJRU5ErkJggg=='
// seed EXACTLY the schema every version since 0.1.0 has written (git-proven
// unchanged), plus an unknown settings key a future version might add
const seededSig = { id: 'upd-test-1', name: 'Update survivor', dataUrl, width: 2, height: 1, createdAt: 1700000000000 }
await writeFile(sigFile, JSON.stringify([seededSig]))
await writeFile(setFile, JSON.stringify({ language: 'sv', someFutureSetting: 123 }))

const OUT_DIR = path.join(process.env.TEMP ?? '.', 'signer-update-out')
await rm(OUT_DIR, { recursive: true, force: true })
await mkdir(OUT_DIR, { recursive: true })
const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], {
  stdio: 'ignore',
  env: { ...process.env, VITE_DEV_SERVER_URL: '', SIGNER_OUTPUT_DIR: OUT_DIR },
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fail = (msg) => {
  console.error('FAIL:', msg)
  process.exitCode = 1
}
try {
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
  const S = `window.__signerStore.getState()`

  await send('Page.enable')
  await waitFor(`!!window.__signerStore && ${S}.signatures.length >= 0`, 'store')
  await waitFor(`${S}.signatures.some(s => s.id === 'upd-test-1')`, 'seeded signature loaded')
  const sig = JSON.parse(await evaluate(`JSON.stringify(${S}.signatures.find(s => s.id === 'upd-test-1'))`))
  console.log('seeded signature loaded:', sig.name, `(${sig.width}x${sig.height})`)
  if (sig.dataUrl !== dataUrl) fail('signature dataUrl was altered on load')

  const lang = await evaluate(`${S}.language`)
  console.log('language from old settings applied:', lang)
  if (lang !== 'sv') fail(`old settings language not applied (got ${lang})`)

  // the app must still be fully functional: open a sample and sign with the
  // SEEDED (old-version) signature
  await evaluate(`(async () => {
    const bytes = new Uint8Array(await window.signer.readFile(${JSON.stringify(path.resolve('samples', 'Leave_Request_Amara_Perera.pdf'))}))
    await ${S}.addFiles([{ name: 'u.pdf', bytes }])
    return true
  })()`)
  await waitFor(`${S}.docs.length === 1 && ${S}.docs[0].status !== 'error'`, 'doc opened')
  await evaluate(`(${S}.setMode('manual'), ${S}.setActiveSignature('upd-test-1'), true)`)
  await evaluate(`(${S}.addExtraStamp({ x: 0.5, yb: 0.7, w: 0.3 }), true)`)
  await evaluate(`${S}.signAll()`)
  await waitFor(`${S}.result && ${S}.result.signed === 1`, 'signed with the seeded signature', 40000)
  console.log('signed 1 document using the old-version signature')

  // changing a setting must PRESERVE unknown keys from newer/older versions
  await evaluate(`${S}.setLanguage('en')`)
  await sleep(600)
  const savedSettings = JSON.parse(await readFile(setFile, 'utf8'))
  console.log('settings after in-app change:', JSON.stringify(savedSettings))
  if (savedSettings.someFutureSetting !== 123) fail('unknown settings key was dropped on save')
  if (savedSettings.language !== 'en') fail('language change not persisted')

  console.log(process.exitCode ? 'DONE WITH FAILURES' : 'ALL CHECKS PASSED')
} catch (e) {
  console.error('ERROR:', e.message)
  process.exitCode = 1
} finally {
  child.kill()
  await sleep(500)
  // restore the user's real files
  for (const f of [sigFile, setFile]) {
    if (backups.includes(f)) {
      await copyFile(f + '.bak-updatetest', f)
      await rm(f + '.bak-updatetest', { force: true })
    } else {
      await rm(f, { force: true })
    }
  }
  console.log('user data restored')
}
