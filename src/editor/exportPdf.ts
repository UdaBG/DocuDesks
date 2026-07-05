import { LineCapStyle, PDFDocument, degrees, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { inkToSvgPath } from '../lib/drawing'
import { dataUrlToBytes } from '../lib/imageUtils'
import { resolveFont } from './fonts'
import type { EditObj, EditSession, TextObj, Watermark } from './types'
import { dashPattern, TEXT_BASELINE, TEXT_LINE_HEIGHT } from './types'

function hexToRgb(hex: string): RGB {
  const v = parseInt(hex.slice(1), 16)
  return rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255)
}

function fontKey(fontId: string, bold: boolean, italic: boolean, weightHint?: number): string {
  return `${fontId}|w${weightHint ?? (bold ? 700 : 400)}${italic ? 'i' : ''}`
}

async function embedFonts(out: PDFDocument, session: EditSession): Promise<Map<string, PDFFont>> {
  const wanted = new Map<
    string,
    { fontId: string; bold: boolean; italic: boolean; weightHint?: number }
  >()
  wanted.set(fontKey('std:helvetica', false, false), { fontId: 'std:helvetica', bold: false, italic: false })
  for (const o of session.objects) {
    if (o.kind === 'text') {
      wanted.set(fontKey(o.fontId, o.bold, o.italic, o.weightHint), {
        fontId: o.fontId,
        bold: o.bold,
        italic: o.italic,
        weightHint: o.weightHint,
      })
    }
  }
  const fonts = new Map<string, PDFFont>()
  for (const [key, spec] of wanted) {
    try {
      const resolved = await resolveFont(spec.fontId, spec.bold, spec.italic, spec.weightHint)
      fonts.set(
        key,
        resolved.bytes
          ? await out.embedFont(resolved.bytes, { subset: true })
          : await out.embedFont(resolved.std!),
      )
    } catch {
      fonts.set(key, await out.embedFont('Helvetica' as never))
    }
  }
  return fonts
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = []
  for (const raw of text.split('\n')) {
    if (!raw) {
      lines.push('')
      continue
    }
    let line = ''
    for (const word of raw.split(' ')) {
      const probe = line ? `${line} ${word}` : word
      let fits = true
      try {
        fits = font.widthOfTextAtSize(probe, size) <= maxWidth
      } catch {
        /* unsupported glyph in measurement — keep the word */
      }
      if (fits || !line) line = probe
      else {
        lines.push(line)
        line = word
      }
    }
    lines.push(line)
  }
  return lines
}

function safeWidth(font: PDFFont, text: string, size: number): number {
  try {
    return font.widthOfTextAtSize(text, size)
  } catch {
    return text.length * size * 0.55
  }
}

function drawTextObj(page: PDFPage, o: TextObj, font: PDFFont, pw: number, ph: number) {
  const size = o.sizePt
  const maxWidth = Math.max(o.w * pw, size)
  const lines = wrapText(o.text, font, size, maxWidth)
  const color = hexToRgb(o.color)
  const x = o.x * pw
  const yTop = o.y * ph
  const baselineFor = (i: number) => ph - yTop - (TEXT_BASELINE + i * TEXT_LINE_HEIGHT) * size

  if (o.highlight) {
    const hl = hexToRgb(o.highlight)
    lines.forEach((line, i) => {
      if (!line) return
      page.drawRectangle({
        x: x - size * 0.08,
        y: baselineFor(i) - size * 0.26,
        width: safeWidth(font, line, size) + size * 0.16,
        height: size * 1.24,
        color: hl,
      })
    })
  }

  lines.forEach((line, i) => {
    if (!line) return
    const baseline = baselineFor(i)
    page.drawText(line, { x, y: baseline, size, font, color })
    const lineWidth = safeWidth(font, line, size)
    if (o.underline) {
      page.drawLine({
        start: { x, y: baseline - size * 0.12 },
        end: { x: x + lineWidth, y: baseline - size * 0.12 },
        thickness: Math.max(size * 0.06, 0.6),
        color,
      })
    }
    if (o.strike) {
      page.drawLine({
        start: { x, y: baseline + size * 0.27 },
        end: { x: x + lineWidth, y: baseline + size * 0.27 },
        thickness: Math.max(size * 0.06, 0.6),
        color,
      })
    }
  })
}

function drawObject(page: PDFPage, o: EditObj, fonts: Map<string, PDFFont>) {
  const { width: pw, height: ph } = page.getSize()
  switch (o.kind) {
    case 'whiteout':
      page.drawRectangle({
        x: o.x * pw,
        y: ph - (o.y + o.h) * ph,
        width: o.w * pw,
        height: o.h * ph,
        color: hexToRgb(o.fill),
      })
      break
    case 'rect':
    case 'ellipse': {
      const common = {
        borderColor: hexToRgb(o.stroke),
        borderWidth: o.strokeWidthPt,
        color: o.fill ? hexToRgb(o.fill) : undefined,
        opacity: o.fill ? o.opacity : 0,
        borderOpacity: o.opacity,
        borderDashArray: dashPattern(o.dash, o.strokeWidthPt),
        borderLineCap: o.dash === 'dotted' ? LineCapStyle.Round : undefined,
      }
      if (o.kind === 'rect') {
        page.drawRectangle({
          x: o.x * pw,
          y: ph - (o.y + o.h) * ph,
          width: o.w * pw,
          height: o.h * ph,
          ...common,
        })
      } else {
        page.drawEllipse({
          x: (o.x + o.w / 2) * pw,
          y: ph - (o.y + o.h / 2) * ph,
          xScale: (o.w / 2) * pw,
          yScale: (o.h / 2) * ph,
          ...common,
        })
      }
      break
    }
    case 'line':
    case 'arrow': {
      const start = { x: o.x1 * pw, y: ph - o.y1 * ph }
      const end = { x: o.x2 * pw, y: ph - o.y2 * ph }
      const color = hexToRgb(o.stroke)
      page.drawLine({
        start,
        end,
        thickness: o.strokeWidthPt,
        color,
        opacity: o.opacity,
        dashArray: dashPattern(o.dash, o.strokeWidthPt),
        lineCap: o.dash === 'dotted' ? LineCapStyle.Round : undefined,
      })
      if (o.kind === 'arrow') {
        const angle = Math.atan2(start.y - end.y, start.x - end.x)
        const head = Math.max(o.strokeWidthPt * 4, 10)
        for (const spread of [-0.45, 0.45]) {
          page.drawLine({
            start: end,
            end: {
              x: end.x + head * Math.cos(angle + spread),
              y: end.y + head * Math.sin(angle + spread),
            },
            thickness: o.strokeWidthPt,
            color,
            opacity: o.opacity,
          })
        }
      }
      break
    }
    case 'ink': {
      const pts = o.points.map(
        (p) => [p[0] * pw, p[1] * ph, p[2]] as [number, number, number],
      )
      const d = inkToSvgPath(pts, o.widthPt, o.simulatePressure, o.pen)
      if (d) {
        page.drawSvgPath(d, {
          x: 0,
          y: ph,
          color: hexToRgb(o.color),
          borderWidth: 0,
          opacity: o.opacity,
        })
      }
      break
    }
    case 'text': {
      const font =
        fonts.get(fontKey(o.fontId, o.bold, o.italic, o.weightHint)) ??
        fonts.get(fontKey('std:helvetica', false, false))!
      drawTextObj(page, o, font, pw, ph)
      break
    }
  }
}

interface WatermarkAssets {
  font: PDFFont
  image?: Awaited<ReturnType<PDFDocument['embedPng']>>
}

function drawWatermark(page: PDFPage, wm: Watermark, assets: WatermarkAssets) {
  const { width: pw, height: ph } = page.getSize()
  const rad = (wm.angleDeg * Math.PI) / 180

  let itemW: number
  let itemH: number
  if (wm.kind === 'image' && assets.image) {
    itemW = wm.scale * pw
    itemH = itemW * (assets.image.height / assets.image.width)
  } else {
    itemW = safeWidth(assets.font, wm.text, wm.sizePt)
    itemH = wm.sizePt * 0.7
  }

  const draw = (cx: number, cy: number) => {
    // rotate around the item's centre
    const x = cx - (itemW / 2) * Math.cos(rad) + (itemH / 2) * Math.sin(rad)
    const y = cy - (itemW / 2) * Math.sin(rad) - (itemH / 2) * Math.cos(rad)
    if (wm.kind === 'image' && assets.image) {
      page.drawImage(assets.image, {
        x,
        y,
        width: itemW,
        height: itemH,
        rotate: degrees(wm.angleDeg),
        opacity: wm.opacity,
      })
    } else {
      page.drawText(wm.text, {
        x,
        y,
        size: wm.sizePt,
        font: assets.font,
        color: hexToRgb(wm.color),
        opacity: wm.opacity,
        rotate: degrees(wm.angleDeg),
      })
    }
  }

  if (wm.tile) {
    const stepX = Math.max(itemW * 1.6, 160)
    const stepY = Math.max(itemH * 3.2, 140)
    for (let y = stepY / 2; y < ph; y += stepY) {
      for (let x = stepX / 2; x < pw; x += stepX) draw(x, y)
    }
  } else {
    draw(pw / 2, ph / 2)
  }
}

/** Bake a session's pages, objects and watermark into new PDF bytes. */
export async function buildEditedPdf(srcBytes: Uint8Array, session: EditSession): Promise<Uint8Array> {
  const src = await PDFDocument.load(srcBytes.slice(), { ignoreEncryption: true })
  const out = await PDFDocument.create()
  out.registerFontkit(fontkit)
  const fonts = await embedFonts(out, session)

  const pagesById = new Map<string, PDFPage>()
  for (const ref of session.pages) {
    if (ref.src.type === 'orig') {
      const [copied] = await out.copyPages(src, [Math.min(ref.src.index, src.getPageCount() - 1)])
      pagesById.set(ref.id, out.addPage(copied))
    } else {
      pagesById.set(ref.id, out.addPage([ref.src.wPt, ref.src.hPt]))
    }
  }

  if (session.watermark) {
    const assets: WatermarkAssets = { font: fonts.get(fontKey('std:helvetica', false, false))! }
    if (session.watermark.kind === 'image' && session.watermark.image) {
      assets.image = await out.embedPng(dataUrlToBytes(session.watermark.image.dataUrl))
    }
    for (const page of pagesById.values()) drawWatermark(page, session.watermark, assets)
  }

  for (const obj of session.objects) {
    const page = pagesById.get(obj.pageId)
    if (page) drawObject(page, obj, fonts)
  }

  return out.save()
}

/** Merge several documents (in the given order) into one new PDF. */
export async function mergePdfs(sources: Uint8Array[]): Promise<Uint8Array> {
  const out = await PDFDocument.create()
  for (const bytes of sources) {
    const src = await PDFDocument.load(bytes.slice(), { ignoreEncryption: true })
    const pages = await out.copyPages(src, src.getPageIndices())
    for (const p of pages) out.addPage(p)
  }
  return out.save()
}
