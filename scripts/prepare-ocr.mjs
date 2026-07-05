// Stage the OCR runtime into public/ocr so it ships inside the app bundle
// (no CDN at runtime — the app must work offline in all three shells).
//   node scripts/prepare-ocr.mjs
// - worker + SIMD LSTM core come from node_modules (tesseract.js v7)
// - eng.traineddata.gz is the compact "fast" model (~2 MB); downloaded once
//   and committed, so this script only needs the network the first time
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const OUT = path.resolve('public', 'ocr')
await mkdir(OUT, { recursive: true })

// the .wasm.js glue embeds the wasm binary (base64), so the separate .wasm
// file is not shipped
const copies = [
  ['node_modules/tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
]
for (const [src, dst] of copies) {
  await copyFile(path.resolve(src), path.join(OUT, dst))
  console.log('staged', dst)
}

const lang = path.join(OUT, 'eng.traineddata.gz')
const exists = await stat(lang).then(() => true, () => false)
if (!exists) {
  const url = 'https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0_fast/eng.traineddata.gz'
  console.log('downloading', url)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`traineddata download failed: ${res.status}`)
  await writeFile(lang, Buffer.from(await res.arrayBuffer()))
}
console.log('ok:', lang, (await stat(lang)).size, 'bytes')
