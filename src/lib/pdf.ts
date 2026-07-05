import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFWorker } from 'pdfjs-dist'
// Inline the worker so it also runs when the packaged app is loaded from file://
import PdfWorkerCtor from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline'

// One worker thread for the app's lifetime, shared by every document.
// Individual documents are cleaned up with `task.destroy()`, which — because
// the worker is passed in explicitly rather than owned by the task — tears
// down only that document's state and leaves the worker alive.
const workerPort = new PdfWorkerCtor()
const sharedWorker: PDFWorker = new pdfjs.PDFWorker({
  port: workerPort as unknown as null, // .d.ts mistypes `port`; a Worker is what it wants
})

export interface OpenedPdf {
  doc: PDFDocumentProxy
  close(): Promise<void>
}

/**
 * Open a PDF with pdf.js. pdf.js transfers the buffer to its worker, so we
 * always hand it a copy and keep the original bytes untouched.
 */
export async function openPdf(bytes: Uint8Array): Promise<OpenedPdf> {
  const task = pdfjs.getDocument({ data: bytes.slice(), worker: sharedWorker })
  const doc = await task.promise
  return {
    doc,
    close: () => task.destroy().catch(() => {}),
  }
}

export async function getPageCount(bytes: Uint8Array): Promise<number> {
  const { doc, close } = await openPdf(bytes)
  const n = doc.numPages
  await close()
  return n
}

export interface RenderedPage {
  canvas: HTMLCanvasElement
  /** CSS pixels */
  width: number
  height: number
}

/**
 * Cheap check for password/permission protection: /Encrypt lives in the
 * trailer dictionary, which sits at the tail (and, for linearized files, is
 * mirrored near the head). A scan of those regions is enough to warn the
 * user — it never blocks anything.
 */
export function looksEncrypted(bytes: Uint8Array): boolean {
  const probe = (from: number, to: number): boolean => {
    let s = ''
    for (let i = Math.max(0, from); i < Math.min(bytes.length, to); i++) {
      s += String.fromCharCode(bytes[i])
    }
    return s.includes('/Encrypt')
  }
  return probe(bytes.length - 4096, bytes.length) || probe(0, 2048)
}

/**
 * Render one page to a canvas that fits inside maxWidth x maxHeight CSS px,
 * at device-pixel-ratio resolution for crisp text.
 */
export async function renderPage(
  doc: PDFDocumentProxy,
  pageIndex: number,
  maxWidth: number,
  maxHeight: number,
  maxDpr = 2,
  maxPixels = Number.POSITIVE_INFINITY,
): Promise<RenderedPage> {
  const page = await doc.getPage(pageIndex + 1)
  const base = page.getViewport({ scale: 1 })
  const fit = Math.min(maxWidth / base.width, maxHeight / base.height)
  // render at full device resolution while the backing store stays inside
  // the pixel budget — high-DPI phones get crisp zoom, huge zoomed desktop
  // pages degrade gracefully instead of exhausting memory
  const budgetDpr = Math.sqrt(maxPixels / (base.width * fit * (base.height * fit)))
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr, budgetDpr)
  const viewport = page.getViewport({ scale: fit * dpr })
  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  canvas.style.width = `${Math.floor(viewport.width / dpr)}px`
  canvas.style.height = `${Math.floor(viewport.height / dpr)}px`
  const ctx = canvas.getContext('2d')!
  await page.render({ canvas, canvasContext: ctx, viewport }).promise
  return { canvas, width: Math.floor(viewport.width / dpr), height: Math.floor(viewport.height / dpr) }
}
