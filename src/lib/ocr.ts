import { createWorker, type Worker } from 'tesseract.js'
import type { PDFPageProxy } from 'pdfjs-dist'

/**
 * OCR for scanned documents — pages with no text layer.
 *
 * The recognizer (tesseract.js, bundled in public/ocr with the compact "fast"
 * English model so the app works offline) turns the page bitmap into words
 * with boxes; a raster pass on the same bitmap finds ruled lines, which in a
 * scan are pixels rather than vector strokes. Both are converted to PDF
 * points, bottom-left origin, in the same shape the text-layer paths use —
 * smart detect and retype consume them without knowing the page was a scan.
 */

/** A recognized word: `y` is the (approximate) baseline, like pdf.js text. */
export interface OcrPiece {
  str: string
  x: number
  y: number
  w: number
  h: number
}

/** A horizontal ruled line found in the bitmap, in PDF points. */
export interface OcrLine {
  x: number
  y: number
  w: number
}

export interface OcrPageResult {
  pieces: OcrPiece[]
  lines: OcrLine[]
}

interface Bbox {
  x0: number
  y0: number
  x1: number
  y1: number
}

let workerPromise: Promise<Worker> | null = null

function log(entry: string): void {
  const w = window as unknown as { __ocrLog?: string[] }
  ;(w.__ocrLog ??= []).push(entry)
}

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    const base = new URL('ocr/', document.baseURI).href
    workerPromise = createWorker('eng', 1, {
      workerPath: `${base}worker.min.js`,
      corePath: `${base}tesseract-core-simd-lstm.wasm.js`,
      langPath: base.slice(0, -1),
      gzip: true,
      // run the worker from its real URL: a blob-wrapped worker loses its
      // script directory, and the emscripten glue then cannot locate the wasm
      workerBlobURL: false,
      logger: (m) => log(`${m.status} ${Math.round((m.progress ?? 0) * 100)}%`),
      errorHandler: (e: unknown) => log(`error: ${String(e)}`),
    })
    // a failed init (e.g. no WASM SIMD) must not poison later attempts
    workerPromise.catch(() => {
      workerPromise = null
    })
  }
  return workerPromise
}

/** Automation probe: recognize a tiny synthetic image, report the outcome. */
export async function ocrSelfTest(): Promise<string> {
  try {
    const c = document.createElement('canvas')
    c.width = 300
    c.height = 80
    const g = c.getContext('2d')!
    g.fillStyle = '#fff'
    g.fillRect(0, 0, 300, 80)
    g.fillStyle = '#000'
    g.font = '32px Arial'
    g.fillText('HELLO 123', 20, 50)
    const w = await getWorker()
    const { data } = await w.recognize(c, {}, { blocks: true, text: true })
    return 'ok: ' + JSON.stringify(data.text)
  } catch (e) {
    return 'ERR: ' + String(e)
  }
}

/** True when a page's text layer is too empty to be useful — i.e. a scan. */
export function isScannedText(pieces: { str: string }[]): boolean {
  return pieces.reduce((n, p) => n + p.str.trim().length, 0) < 8
}

export async function ocrPage(page: PDFPageProxy): Promise<OcrPageResult> {
  const base = page.getViewport({ scale: 1 })
  const scale = Math.min(3, Math.max(1.5, 1800 / base.width))
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  await page.render({ canvas, canvasContext: ctx, viewport }).promise

  const lines = detectRasterLines(canvas, scale, base.height)

  const worker = await getWorker()
  const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false })
  const pieces: OcrPiece[] = []
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const word of line.words ?? []) {
          const str = (word.text ?? '').trim()
          if (!str || word.confidence < 35) continue
          const b = word.bbox as Bbox
          const hPt = (b.y1 - b.y0) / scale
          pieces.push({
            str,
            x: b.x0 / scale,
            // bbox spans ascender..descender; the baseline sits a bit above
            // the bottom, and the nominal font size is smaller than the bbox
            y: base.height - b.y1 / scale + hPt * 0.18,
            w: (b.x1 - b.x0) / scale,
            h: hPt * 0.8,
          })
        }
      }
    }
  }
  return { pieces, lines }
}

/**
 * Ruled lines in a scan are ink pixels: find long thin horizontal dark runs.
 * Text rows break at inter-letter gaps and stacked glyph rows exceed the
 * thickness cap, so genuine lines survive both filters.
 */
function detectRasterLines(canvas: HTMLCanvasElement, scale: number, pageH: number): OcrLine[] {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const { width, height } = canvas
  const data = ctx.getImageData(0, 0, width, height).data
  const minLen = Math.floor(width * 0.06)
  const segs: { x0: number; x1: number; y: number }[] = []
  for (let y = 0; y < height; y++) {
    let run = 0
    const row = y * width
    for (let x = 0; x <= width; x++) {
      let dark = false
      if (x < width) {
        const i = (row + x) * 4
        dark = data[i + 3] > 100 && 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < 140
      }
      if (dark) run++
      else {
        if (run >= minLen) segs.push({ x0: x - run, x1: x, y })
        run = 0
      }
    }
  }
  // merge vertically adjacent segments into lines; drop thick ones (images,
  // filled bars, text blocks)
  const used = new Uint8Array(segs.length)
  const lines: OcrLine[] = []
  const maxThickness = Math.max(4, height * 0.004)
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue
    used[i] = 1
    let { x0, x1 } = segs[i]
    const yTop = segs[i].y
    let yBot = segs[i].y
    for (let j = i + 1; j < segs.length; j++) {
      if (used[j]) continue
      const s = segs[j]
      if (s.y - yBot > 2) break // segs are in y order
      if (Math.min(x1, s.x1) - Math.max(x0, s.x0) > (x1 - x0) * 0.6) {
        used[j] = 1
        yBot = s.y
        x0 = Math.min(x0, s.x0)
        x1 = Math.max(x1, s.x1)
      }
    }
    if (yBot - yTop + 1 <= maxThickness) {
      lines.push({ x: x0 / scale, y: pageH - (yTop + yBot) / 2 / scale, w: (x1 - x0) / scale })
    }
  }
  return lines
}
