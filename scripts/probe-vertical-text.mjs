// Ground truth probe: what geometry does pdf.js report for rotated text items?
// Builds a PDF with horizontal + 90° + -90° text, parses it, dumps the items.
// node scripts/probe-vertical-text.mjs
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'

const doc = await PDFDocument.create()
const page = doc.addPage([595, 842])
const font = await doc.embedFont(StandardFonts.Helvetica)
page.drawText('Horizontal', { x: 100, y: 700, size: 12, font })
// pdf-lib: positive degrees = counter-clockwise, rotation about (x, y)
page.drawText('VerticalUp', { x: 200, y: 600, size: 12, font, rotate: degrees(90) })
page.drawText('VerticalDown', { x: 300, y: 600, size: 12, font, rotate: degrees(-90) })
const bytes = await doc.save()

const task = pdfjs.getDocument({ data: bytes, useSystemFonts: true })
const loaded = await task.promise
const p1 = await loaded.getPage(1)
const tc = await p1.getTextContent()
for (const item of tc.items) {
  if (!('str' in item) || !item.str.trim()) continue
  const tr = item.transform.map((v) => Math.round(v * 100) / 100)
  console.log(
    JSON.stringify({
      str: item.str,
      transform: tr,
      width: Math.round(item.width * 100) / 100,
      height: Math.round(item.height * 100) / 100,
    }),
  )
}
await loaded.destroy()
