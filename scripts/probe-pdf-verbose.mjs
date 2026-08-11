// Node-side pdf.js probe with maximum verbosity: does the CCITT image decode
// outside the browser worker, and what does pdf.js actually complain about?
// node scripts/probe-blankpdf5.mjs <pdf-path>
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { readFile } from 'node:fs/promises'

const PDF = process.argv[2] ?? 'C:\\Users\\udbhlk\\Downloads\\Final_Results_released_on_23062026_16072026_and_21072026.pdf'
const bytes = new Uint8Array(await readFile(PDF))

const task = pdfjs.getDocument({
  data: bytes,
  useSystemFonts: true,
  verbosity: 5, // INFOS — surface everything
})
const doc = await task.promise
console.log('pages:', doc.numPages)
const page = await doc.getPage(1)
const ops = await page.getOperatorList()
console.log('ops:', ops.fnArray.length)
const paintIdx = ops.fnArray.findIndex((f) => f === pdfjs.OPS.paintImageXObject)
const objId = paintIdx >= 0 ? ops.argsArray[paintIdx][0] : null
console.log('image objId:', objId)
if (objId) {
  const has = page.objs.has(objId)
  console.log('objs.has after getOperatorList:', has)
  if (has) {
    const img = page.objs.get(objId)
    console.log('image object:', img ? { width: img.width, height: img.height, kind: img.kind ?? typeof img.bitmap } : img)
  } else {
    // wait up to 5s for it to arrive
    const img = await Promise.race([
      new Promise((res) => page.objs.get(objId, res)),
      new Promise((res) => setTimeout(() => res('TIMEOUT'), 5000)),
    ])
    console.log('after wait:', img === 'TIMEOUT' ? 'TIMEOUT — never resolved' : { width: img?.width, height: img?.height })
  }
}
await task.destroy()
