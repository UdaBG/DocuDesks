// Regression: every bundled editor font must parse and embed through the
// exact pdf-lib + fontkit pipeline the exporter uses (a corrupt or
// unsupported TTF would only fail at save time, on a phone, without OCR of
// the problem). Runs in plain Node — no Electron needed.
//   node scripts/fonts-embed.mjs
import { PDFDocument } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { readFile } from 'node:fs/promises'

const FACES = [
  'LiberationSans-Regular', 'LiberationSans-Bold', 'LiberationSans-Italic', 'LiberationSans-BoldItalic',
  'LiberationSerif-Regular', 'LiberationSerif-Bold', 'LiberationSerif-Italic', 'LiberationSerif-BoldItalic',
  'Carlito-Regular', 'Carlito-Bold', 'Carlito-Italic', 'Carlito-BoldItalic',
  'Cousine-Regular', 'Cousine-Bold', 'Cousine-Italic', 'Cousine-BoldItalic',
]

let failed = 0
for (const face of FACES) {
  try {
    const bytes = await readFile(new URL(`../src/assets/fonts/${face}.ttf`, import.meta.url))
    const doc = await PDFDocument.create()
    doc.registerFontkit(fontkit)
    const font = await doc.embedFont(bytes, { subset: true })
    const page = doc.addPage([300, 100])
    page.drawText('Hamburgefonstiv 123 åäö', { font, size: 14, x: 20, y: 40 })
    const out = await doc.save()
    if (out.length < 1000) throw new Error(`suspiciously small output (${out.length}B)`)
    console.log(`${face}: OK (${(bytes.length / 1024).toFixed(0)} KB -> ${(out.length / 1024).toFixed(0)} KB subset)`)
  } catch (e) {
    failed++
    console.error(`${face}: FAIL — ${e.message}`)
  }
}
if (failed) {
  console.error(`${failed} face(s) failed`)
  process.exitCode = 1
} else {
  console.log('ALL CHECKS PASSED')
}
