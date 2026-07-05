import { OPS, type PDFPageProxy } from 'pdfjs-dist'
import type { Placement } from '../types'
import { isScannedText, ocrPage, type OcrPageResult } from './ocr'
import { openPdf } from './pdf'

/**
 * Signature-spot detection.
 *
 * Evidence, strongest first:
 *  1. AcroForm signature fields (fieldType "Sig") — exact rectangle known.
 *  2. Widget fields whose name mentions signing.
 *  3. Text labels ("Signature", "Unterschrift", "Firma", …) and ruled
 *     underscore lines — the classic "Signature: ___________" pattern.
 *  4. Letter sign-offs: "Sincerely," / "Regards," etc., ideally paired with a
 *     typed name below — the signature goes between them.
 *  5. Drawn (vector) horizontal lines — including Word's signature-line
 *     object, which exports as a graphic, not as underscore text.
 *  6. A standalone "X" marker beside a signing spot.
 *
 * Every candidate is scored; the best one wins. Later pages and the lower
 * half of a page get a bonus because that is where documents are signed.
 */

const LABELS: { re: RegExp; weight: number }[] = [
  // English
  { re: /\bsign(ature|ed by|ed|atory)?\b\s*(here)?/i, weight: 80 },
  { re: /\bauthori[sz]ed signature\b/i, weight: 88 },
  // German
  { re: /unterschrift/i, weight: 84 },
  // French ("signature" already matched above), Spanish / Italian / Portuguese
  { re: /\bfirmado?\b|\bfirma\b/i, weight: 82 },
  { re: /assinatura/i, weight: 82 },
  // Swedish / Norwegian / Danish
  { re: /underskrift|namnteckning|undertecknad/i, weight: 82 },
  // Dutch
  { re: /handtekening/i, weight: 82 },
  // Sinhala
  { re: /අත්සන/, weight: 82 },
]

const UNDERSCORE_LINE = /_{6,}/
const DOTTED_LINE = /\.{8,}/

/** Letter sign-offs in the app's supported languages (and then some). */
const CLOSINGS =
  /^(sincerely( yours)?|best regards|kind regards|warm(est)? regards|regards|yours (sincerely|faithfully|truly)|respectfully( yours)?|cordially|with (gratitude|appreciation|thanks)|thank you|mit freundlichen gr(ü|ue)(ß|ss)en|freundliche gr(ü|ue)(ß|ss)e|hochachtungsvoll|cordialement|bien (à|a) vous|salutations distingu(é|e)es|atentamente|saludos( cordiales)?|un saludo|cordiali saluti|med v(ä|a)nliga h(ä|a)lsningar|v(ä|a)nliga h(ä|a)lsningar|met vriendelijke groet(en)?)[,.]?$/i

/** A short typed name: 1–4 capitalised words, no digits. */
function nameLike(s: string): boolean {
  const t = s.trim()
  if (t.length < 2 || t.length > 42 || /\d/.test(t) || CLOSINGS.test(t)) return false
  return /^[A-ZÀ-Þ][\wÀ-ÿ.'-]*(?:\s+[\wÀ-ÿ.'-]+){0,3}$/u.test(t)
}

interface Candidate {
  pageIndex: number
  score: number
  /** proposed signature box in PDF units, bottom-left origin */
  x: number
  yBottom: number
  w: number
  /** vertical space available at the spot, as a fraction of page height */
  maxH?: number
}

function clampMaxH(gapPts: number, pageH: number): number {
  return Math.min(0.22, Math.max(0.03, gapPts / pageH))
}

interface TextPiece {
  str: string
  x: number
  y: number
  w: number
  h: number
}

interface HLine {
  x: number
  y: number
  w: number
}

type Matrix = [number, number, number, number, number, number]
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

function matMul(a: Matrix, b: Matrix): Matrix {
  // row-vector convention: applying `a` then `b`
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ]
}

function matApply(m: Matrix, x: number, y: number): [number, number] {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]]
}

/**
 * Extract horizontal drawn lines (strokes and hairline rectangles) and image
 * placements from the page's operator list, in page space.
 */
async function collectDrawings(page: PDFPageProxy): Promise<{ lines: HLine[]; images: { x: number; y: number; w: number; h: number }[] }> {
  const lines: HLine[] = []
  const images: { x: number; y: number; w: number; h: number }[] = []
  const opList = await page.getOperatorList()
  let ctm: Matrix = IDENTITY
  const stack: Matrix[] = []

  const addSegment = (x1: number, y1: number, x2: number, y2: number) => {
    const [ax, ay] = matApply(ctm, x1, y1)
    const [bx, by] = matApply(ctm, x2, y2)
    if (Math.abs(ay - by) < 1.6 && Math.abs(bx - ax) > 40) {
      lines.push({ x: Math.min(ax, bx), y: (ay + by) / 2, w: Math.abs(bx - ax) })
    }
  }

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i]
    const args = opList.argsArray[i]
    if (fn === OPS.save) stack.push(ctm)
    else if (fn === OPS.restore) ctm = stack.pop() ?? IDENTITY
    else if (fn === OPS.transform) ctm = matMul(args as Matrix, ctm)
    else if (fn === OPS.constructPath) {
      const [subOps, coords] = args as [number[], number[]]
      let ci = 0
      let cx = 0
      let cy = 0
      for (const op of subOps) {
        if (op === OPS.moveTo) {
          cx = coords[ci++]
          cy = coords[ci++]
        } else if (op === OPS.lineTo) {
          const nx = coords[ci++]
          const ny = coords[ci++]
          addSegment(cx, cy, nx, ny)
          cx = nx
          cy = ny
        } else if (op === OPS.curveTo) {
          ci += 4
          cx = coords[ci++]
          cy = coords[ci++]
        } else if (op === OPS.curveTo2 || op === OPS.curveTo3) {
          ci += 2
          cx = coords[ci++]
          cy = coords[ci++]
        } else if (op === OPS.rectangle) {
          const rx = coords[ci++]
          const ry = coords[ci++]
          const rw = coords[ci++]
          const rh = coords[ci++]
          // hairline filled rectangles are how many rules are drawn
          if (Math.abs(rh) < 2.5) addSegment(rx, ry + rh / 2, rx + rw, ry + rh / 2)
          cx = rx
          cy = ry
        }
      }
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      // images are drawn into the unit square transformed by the CTM
      const w = Math.hypot(ctm[0], ctm[1])
      const h = Math.hypot(ctm[2], ctm[3])
      const [ix, iy] = matApply(ctm, 0, 0)
      images.push({ x: Math.min(ix, ix + ctm[0]), y: Math.min(iy, iy + ctm[3]), w, h })
    }
  }
  return { lines, images }
}

export async function detectSignatureSpot(bytes: Uint8Array): Promise<Placement | null> {
  const { doc, close } = await openPdf(bytes)
  const candidates: Candidate[] = []
  try {
    for (let p = 0; p < doc.numPages; p++) {
      const page = await doc.getPage(p + 1)
      const view = page.getViewport({ scale: 1 })
      const pageW = view.width
      const pageH = view.height
      const pageBonus = p * 3 // prefer later pages

      // --- 1 & 2: form fields ---------------------------------------------
      const annotations = await page.getAnnotations()
      for (const a of annotations) {
        if (a.subtype !== 'Widget' || !Array.isArray(a.rect)) continue
        const [x1, y1, x2, y2] = a.rect as number[]
        const isSigField = a.fieldType === 'Sig'
        const nameHints = /sign|unterschrift|firma|assinatura|underskrift/i.test(
          String(a.fieldName ?? ''),
        )
        if (!isSigField && !nameHints) continue
        candidates.push({
          pageIndex: p,
          score: (isSigField ? 100 : 86) + pageBonus,
          x: Math.min(x1, x2),
          yBottom: Math.min(y1, y2),
          w: Math.max(Math.abs(x2 - x1), pageW * 0.18),
          maxH: clampMaxH(Math.abs(y2 - y1) * 1.2, pageH),
        })
      }

      // --- 3: text labels and ruled lines ---------------------------------
      const tc = await page.getTextContent()
      const pieces: TextPiece[] = []
      for (const item of tc.items) {
        if (!('str' in item) || !item.str.trim()) continue
        const t = item.transform
        pieces.push({ str: item.str, x: t[4], y: t[5], w: item.width, h: item.height || Math.hypot(t[2], t[3]) })
      }

      // A scan needs OCR: either the page has no text layer at all, or it is
      // one big image with a thin text layer on top (a scan that was already
      // edited). Recognized words merge in under any real text, and a raster
      // pass finds ruled lines (pixels here, not vector strokes) — every
      // rule below then works on scans unchanged.
      const drawings = await collectDrawings(page).catch(() => ({ lines: [], images: [] }))
      let scanned: OcrPageResult | null = null
      const textLen = pieces.reduce((n, q) => n + q.str.trim().length, 0)
      const bigImage = drawings.images.some((im) => im.w * im.h >= pageW * pageH * 0.55)
      if (isScannedText(pieces) || (bigImage && textLen < 600)) {
        try {
          scanned = await ocrPage(page)
          const overlap = (a: TextPiece, b: TextPiece) =>
            Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > Math.min(a.w, b.w) * 0.3 &&
            Math.abs(a.y - b.y) < Math.max(a.h, b.h) * 0.8
          pieces.push(...scanned.pieces.filter((o) => !pieces.some((r) => overlap(o, r))))
        } catch {
          /* OCR unavailable (e.g. no WASM SIMD) — detect what we can without it */
        }
      }

      for (const piece of pieces) {
        const text = piece.str.trim()
        const isLine = UNDERSCORE_LINE.test(text) || DOTTED_LINE.test(text)
        let labelWeight = 0
        for (const { re, weight } of LABELS) {
          if (re.test(text)) { labelWeight = Math.max(labelWeight, weight); break }
        }
        if (!labelWeight && !isLine) continue

        // Long sentences that merely contain the word are weak evidence.
        const labelFactor = text.length <= 32 ? 1 : 0.45
        const bottomHalfBonus = piece.y < pageH / 2 ? 6 : 0

        if (isLine) {
          // A ruled line: sign directly on top of it.
          const w = Math.min(piece.w, pageW * 0.42)
          candidates.push({
            pageIndex: p,
            score: (labelWeight ? 70 : 58) + bottomHalfBonus + pageBonus,
            x: piece.x,
            yBottom: piece.y + 2,
            w,
            maxH: clampMaxH(58, pageH),
          })
          continue
        }

        // A label. If there is room to its right ("Signature: ____"), sign
        // there; otherwise sign directly above the label (label under line).
        const rightX = piece.x + piece.w + 8
        const roomRight = pageW - rightX - pageW * 0.06
        const desiredW = pageW * 0.28
        if (roomRight >= pageW * 0.16) {
          candidates.push({
            pageIndex: p,
            score: labelWeight * labelFactor + bottomHalfBonus + pageBonus,
            x: rightX,
            yBottom: piece.y - piece.h * 0.15,
            w: Math.min(desiredW, roomRight),
            maxH: clampMaxH(piece.h * 3.2, pageH),
          })
        } else {
          candidates.push({
            pageIndex: p,
            score: labelWeight * labelFactor + bottomHalfBonus + pageBonus,
            x: piece.x,
            yBottom: piece.y + piece.h + 4,
            w: desiredW,
            maxH: clampMaxH(64, pageH),
          })
        }
      }

      // --- 4: letter sign-offs ("Sincerely," … typed name) ------------------
      for (const closing of pieces) {
        if (!CLOSINGS.test(closing.str.trim())) continue
        // the typed name usually sits a few lines below at the same indent
        let name: TextPiece | null = null
        for (const cand of pieces) {
          if (cand === closing || !nameLike(cand.str)) continue
          const dy = closing.y - cand.y
          if (dy > 18 && dy < 170 && Math.abs(cand.x - closing.x) < 45 && (!name || cand.y > name.y)) {
            name = cand
          }
        }
        if (name) {
          const gap = closing.y - (name.y + name.h)
          candidates.push({
            pageIndex: p,
            score: 88 + pageBonus,
            x: Math.min(closing.x, name.x),
            yBottom: name.y + name.h + 6,
            w: Math.max(pageW * 0.24, name.w * 1.4),
            maxH: clampMaxH(gap - 12, pageH),
          })
        } else {
          candidates.push({
            pageIndex: p,
            score: 72 + pageBonus,
            x: closing.x,
            yBottom: closing.y - 58,
            w: pageW * 0.27,
            maxH: clampMaxH(50, pageH),
          })
        }
      }

      // --- 5: standalone "X" marker (Word signature line) -------------------
      for (const piece of pieces) {
        if (piece.str.trim() !== 'X' || piece.h < 8 || piece.h > 34) continue
        candidates.push({
          pageIndex: p,
          score: 78 + (piece.y < pageH / 2 ? 6 : 0) + pageBonus,
          x: piece.x + piece.w + 4,
          yBottom: piece.y - 2,
          w: pageW * 0.3,
          maxH: clampMaxH(52, pageH),
        })
      }

      // --- 6: drawn horizontal lines and wide flat images -------------------
      try {
        const lines = scanned ? [...drawings.lines, ...scanned.lines] : drawings.lines
        const images = scanned ? [] : drawings.images // a scan IS one big image
        for (const line of lines) {
          if (line.w > pageW * 0.62 || line.w < pageW * 0.08) continue // dividers / ticks
          // table grids: several stacked lines with similar horizontal extent
          const stacked = lines.filter(
            (o) =>
              o !== line &&
              Math.abs(o.y - line.y) < 130 &&
              Math.min(o.x + o.w, line.x + line.w) - Math.max(o.x, line.x) > line.w * 0.6,
          )
          if (stacked.length >= 3) continue
          let score = 58 + (line.y < pageH / 2 ? 6 : 0) + pageBonus
          // caption right below the line ("Parker", "Signature") — Word style
          const caption = pieces.find(
            (t) =>
              line.y - (t.y + t.h) > -2 &&
              line.y - (t.y + t.h) < 18 &&
              Math.min(t.x + t.w, line.x + line.w) - Math.max(t.x, line.x) > Math.min(t.w, line.w) * 0.4,
          )
          if (caption) score += 14
          // a sign-off above the line strengthens it further
          const closingAbove = pieces.find(
            (t) => CLOSINGS.test(t.str.trim()) && t.y > line.y && t.y - line.y < 170 && Math.abs(t.x - line.x) < 90,
          )
          if (closingAbove) score += 10
          // available height = distance to the nearest text above the line
          const textAbove = pieces
            .filter(
              (t) =>
                t.y > line.y + 2 &&
                t.y - line.y < 220 &&
                Math.min(t.x + t.w, line.x + line.w) - Math.max(t.x, line.x) > line.w * 0.3,
            )
            .sort((a, b) => a.y - b.y)[0]
          candidates.push({
            pageIndex: p,
            score,
            x: line.x,
            yBottom: line.y + 2,
            w: Math.min(line.w, pageW * 0.42),
            maxH: clampMaxH((textAbove ? textAbove.y - line.y : 80) - 10, pageH),
          })
        }
        for (const img of images) {
          if (img.w < pageW * 0.12 || img.w > pageW * 0.55 || img.h > 75 || img.y > pageH * 0.7) continue
          candidates.push({
            pageIndex: p,
            score: 52 + pageBonus,
            x: img.x,
            yBottom: img.y + Math.min(img.h * 0.3, 12),
            w: Math.min(img.w, pageW * 0.4),
            maxH: clampMaxH(img.h * 1.1, pageH),
          })
        }
      } catch {
        /* operator list unavailable — text evidence only */
      }

      // Convert this page's candidates to fractions now while we have dims.
      for (const c of candidates) {
        if (c.pageIndex !== p || (c as unknown as { converted?: boolean }).converted) continue
        ;(c as unknown as { converted: boolean }).converted = true
        c.x = clamp01(c.x / pageW)
        c.yBottom = clamp01(1 - c.yBottom / pageH) // fraction from top to the signing line
        c.w = Math.min(Math.max(c.w / pageW, 0.1), 0.5)
      }
    }
  } finally {
    await close()
  }

  if (!candidates.length) return null
  candidates.sort((a, b) => b.score - a.score)
  const best = candidates[0]
  return {
    anchor: 'custom',
    pageIndex: best.pageIndex,
    x: Math.min(best.x, 1 - best.w),
    yb: best.yBottom,
    w: best.w,
    maxH: best.maxH,
  }
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v))
}
