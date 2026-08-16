/**
 * Remove owner-password protection from a PDF, offline, with qpdf compiled to
 * WebAssembly (bundled in public/qpdf). Owner-only protection lets a file be
 * viewed but forbids editing; qpdf `--decrypt` rewrites a byte-faithful
 * unprotected equivalent so the rest of the app can rebuild it.
 *
 * The glue is a classic emscripten UMD (uses document.currentScript, guarded
 * node require) — loaded via a <script> tag from the app's own origin, not
 * bundled, exactly like the OCR runtime.
 */

interface QpdfFS {
  writeFile(path: string, data: Uint8Array): void
  readFile(path: string): Uint8Array
  unlink(path: string): void
}
interface QpdfInstance {
  callMain(args: string[]): number
  FS: QpdfFS
}
type QpdfFactory = (opts: { locateFile: () => string }) => Promise<QpdfInstance>

let factoryPromise: Promise<QpdfFactory> | null = null

function loadFactory(): Promise<QpdfFactory> {
  if (!factoryPromise) {
    const base = new URL('qpdf/', document.baseURI).href
    // ?v=<appVersion>: same-URL public asset, cache-busted per app version
    const v = `?v=${__APP_VERSION__}`
    factoryPromise = new Promise<QpdfFactory>((resolve, reject) => {
      const existing = (window as unknown as { Module?: QpdfFactory }).Module
      if (existing) return resolve(existing)
      const s = document.createElement('script')
      s.src = `${base}qpdf.js${v}`
      s.onload = () => {
        const mod = (window as unknown as { Module?: QpdfFactory }).Module
        if (mod) resolve(mod)
        else reject(new Error('qpdf module did not load'))
      }
      s.onerror = () => reject(new Error('failed to load qpdf.js'))
      document.head.appendChild(s)
    })
    factoryPromise.catch(() => {
      factoryPromise = null
    })
  }
  return factoryPromise
}

/** qpdf CLI exit codes: 0 = ok, 3 = warnings but output written; both usable. */
const OK_CODES = new Set([0, 3])

/**
 * Decrypt `bytes`, returning unprotected PDF bytes. `password` is only needed
 * for files that also carry a user (open) password — owner-only protection
 * decrypts with the empty default. Throws if qpdf cannot open the file (e.g.
 * a real open password is required or the input is corrupt).
 */
async function runQpdf(bytes: Uint8Array, args: string[]): Promise<Uint8Array> {
  const factory = await loadFactory()
  const base = new URL('qpdf/', document.baseURI).href
  const qpdf = await factory({ locateFile: () => `${base}qpdf.wasm?v=${__APP_VERSION__}` })
  const inPath = '/in.pdf'
  const outPath = '/out.pdf'
  qpdf.FS.writeFile(inPath, bytes)
  try {
    const code = qpdf.callMain([...args, inPath, outPath])
    if (!OK_CODES.has(code)) {
      throw new Error(`qpdf exited ${code}`)
    }
    // copy out of the emscripten heap before it is freed
    return new Uint8Array(qpdf.FS.readFile(outPath))
  } finally {
    try {
      qpdf.FS.unlink(inPath)
    } catch {
      /* already gone */
    }
    try {
      qpdf.FS.unlink(outPath)
    } catch {
      /* never written on failure */
    }
  }
}

export async function unlockPdf(bytes: Uint8Array, password = ''): Promise<Uint8Array> {
  return runQpdf(bytes, ['--decrypt', `--password=${password}`])
}

/**
 * Encrypt `bytes` so the output requires `password` to open (the password is
 * used as both the user and owner password — one secret, full control).
 * AES-256 by default; 128-bit (still AES) only for very old readers.
 */
export async function encryptPdf(
  bytes: Uint8Array,
  password: string,
  bits: 128 | 256 = 256,
): Promise<Uint8Array> {
  const args =
    bits === 256
      ? ['--encrypt', password, password, '256', '--']
      : ['--encrypt', password, password, '128', '--use-aes=y', '--']
  return runQpdf(bytes, args)
}
