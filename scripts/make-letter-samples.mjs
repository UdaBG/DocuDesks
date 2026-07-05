// Letter-style samples: sign-off convention + Word-style drawn signature line.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { mkdir, writeFile } from 'node:fs/promises'

const INK = rgb(0.09, 0.11, 0.17)
const BLUE = rgb(0.16, 0.34, 0.7)
const MUTED = rgb(0.42, 0.45, 0.53)

async function makeLetter({ withSigLine }) {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([595.28, 841.89])
  const helv = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)

  // tightly-leaded two-line heading (like real letterheads)
  page.drawText('First Up', { x: 72, y: 760, size: 20, font: bold, color: BLUE })
  page.drawText('Consultants', { x: 72, y: 738, size: 20, font: bold, color: BLUE })
  const paras = [
    'Shams Elmarakhi',
    'Wide World Importers',
    '123 South St., Manhattan, NY 15161',
    '',
    'Dear Shams,',
    '',
    'I am writing this job reference letter to highly recommend Luca Richter',
    'for regional manager. They have proven to be a reliable and results-',
    'oriented individual, consistently exceeding expectations in their role.',
    '',
    'If you are looking for a candidate who is hardworking, dependable, and',
    'possesses excellent problem-solving skills, I highly encourage you to',
    'consider Luca for the role.',
  ]
  let y = 700
  for (const line of paras) {
    if (line) page.drawText(line, { x: 72, y, size: 11, font: helv, color: INK })
    y -= 18
  }

  if (withSigLine) {
    // sign-off high, then a Word-style signature line: X + rule + tiny caption
    page.drawText('Sincerely,', { x: 72, y: 520, size: 11, font: helv, color: INK })
    page.drawText('X', { x: 76, y: 476, size: 14, font: bold, color: INK })
    page.drawLine({ start: { x: 72, y: 470 }, end: { x: 272, y: 470 }, thickness: 1, color: INK })
    page.drawText('Parker', { x: 76, y: 458, size: 7, font: helv, color: MUTED })
  } else {
    // classic letter: closing, an empty gap to sign in, then the typed name
    page.drawText('Sincerely,', { x: 72, y: 300, size: 11, font: helv, color: INK })
    page.drawText('PARKER MCLEAN', { x: 72, y: 210, size: 11, font: bold, color: BLUE })
    page.drawText('First Up Consultants', { x: 72, y: 196, size: 10, font: helv, color: INK })
  }

  // wide footer divider (must NOT be detected — too wide)
  page.drawLine({ start: { x: 72, y: 150 }, end: { x: 523, y: 150 }, thickness: 0.8, color: MUTED })
  page.drawText('parker@firstupconsultants.com', { x: 72, y: 132, size: 9, font: helv, color: MUTED })

  return pdf.save()
}

await mkdir('samples', { recursive: true })
await writeFile('samples/Reference_Letter.pdf', await makeLetter({ withSigLine: false }))
await writeFile('samples/SigLine_Letter.pdf', await makeLetter({ withSigLine: true }))
console.log('wrote samples/Reference_Letter.pdf, samples/SigLine_Letter.pdf')
