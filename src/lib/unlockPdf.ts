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
    factoryPromise = new Promise<QpdfFactory>((resolve, reject) => {
      const existing = (window as unknown as { Module?: QpdfFactory }).Module
      if (existing) return resolve(existing)
      const s = document.createElement('script')
      s.src = `${base}qpdf.js`
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
export async function unlockPdf(bytes: Uint8Array, password = ''): Promise<Uint8Array> {
  const factory = await loadFactory()
  const base = new URL('qpdf/', document.baseURI).href
  const qpdf = await factory({ locateFile: () => `${base}qpdf.wasm` })
  const inPath = '/in.pdf'
  const outPath = '/out.pdf'
  qpdf.FS.writeFile(inPath, bytes)
  try {
    const code = qpdf.callMain(['--decrypt', `--password=${password}`, inPath, outPath])
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
