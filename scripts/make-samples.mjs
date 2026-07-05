// Generates sample "filled forms" so bulk signing can be tried immediately.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { mkdir, writeFile } from 'node:fs/promises'

const PEOPLE = [
  'Amara Perera',
  'Kasun Fernando',
  'Nadeesha Silva',
  'Ruwan Jayasuriya',
  'Ishara Wickramasinghe',
  'Tharindu Bandara',
]

const INK = rgb(0.09, 0.11, 0.17)
const MUTED = rgb(0.42, 0.45, 0.53)

async function makeLeaveForm(person, index) {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([595.28, 841.89]) // A4
  const helv = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const { width, height } = page.getSize()

  page.drawText('ACME CORPORATION', { x: 60, y: height - 70, size: 10, font: bold, color: MUTED })
  page.drawText('Annual Leave Request', { x: 60, y: height - 110, size: 24, font: bold, color: INK })
  page.drawLine({ start: { x: 60, y: height - 128 }, end: { x: width - 60, y: height - 128 }, thickness: 1, color: MUTED })

  const rows = [
    ['Employee name', person],
    ['Employee ID', `EMP-10${40 + index}`],
    ['Department', 'Engineering'],
    ['Leave type', 'Annual'],
    ['From', '2026-08-03'],
    ['To', '2026-08-14'],
    ['Reason', 'Family holiday'],
  ]
  let y = height - 180
  for (const [label, value] of rows) {
    page.drawText(label, { x: 60, y, size: 10, font: helv, color: MUTED })
    page.drawText(value, { x: 220, y, size: 12, font: helv, color: INK })
    page.drawLine({ start: { x: 215, y: y - 6 }, end: { x: width - 60, y: y - 6 }, thickness: 0.5, color: rgb(0.85, 0.87, 0.9) })
    y -= 38
  }

  page.drawText('I confirm the information above is accurate.', { x: 60, y: 240, size: 10, font: helv, color: MUTED })
  page.drawLine({ start: { x: 60, y: 170 }, end: { x: 300, y: 170 }, thickness: 1, color: INK })
  page.drawText('Employee signature', { x: 60, y: 154, size: 10, font: helv, color: MUTED })
  page.drawLine({ start: { x: 360, y: 170 }, end: { x: 520, y: 170 }, thickness: 1, color: INK })
  page.drawText('Date', { x: 360, y: 154, size: 10, font: helv, color: MUTED })

  return pdf.save()
}

async function makeContract() {
  const pdf = await PDFDocument.create()
  const helv = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)

  const p1 = pdf.addPage([595.28, 841.89])
  p1.drawText('SERVICE AGREEMENT', { x: 60, y: 760, size: 22, font: bold, color: INK })
  const paras = [
    'This Service Agreement is entered into by and between Acme Corporation',
    '("Provider") and the undersigned client ("Client").',
    '',
    '1. Services. Provider agrees to perform the services described in Annex A.',
    '2. Term. This agreement runs for twelve (12) months from the signing date.',
    '3. Fees. Client shall pay the fees set out in Annex B within 30 days.',
    '4. Confidentiality. Each party shall keep the other party’s information',
    '   confidential and use it only to perform this agreement.',
    '5. Liability. Neither party is liable for indirect or consequential damages.',
  ]
  let y = 710
  for (const line of paras) {
    p1.drawText(line, { x: 60, y, size: 11, font: helv, color: INK })
    y -= 20
  }

  const p2 = pdf.addPage([595.28, 841.89])
  p2.drawText('IN WITNESS WHEREOF, the parties have executed this agreement.', {
    x: 60, y: 700, size: 11, font: helv, color: INK,
  })
  p2.drawText('Signed by:', { x: 60, y: 320, size: 11, font: bold, color: INK })
  p2.drawLine({ start: { x: 140, y: 316 }, end: { x: 400, y: 316 }, thickness: 1, color: INK })
  p2.drawText('Name and title', { x: 140, y: 300, size: 9, font: helv, color: MUTED })

  return pdf.save()
}

await mkdir('samples', { recursive: true })
for (let i = 0; i < PEOPLE.length; i++) {
  const bytes = await makeLeaveForm(PEOPLE[i], i)
  const file = `samples/Leave_Request_${PEOPLE[i].replace(/ /g, '_')}.pdf`
  await writeFile(file, bytes)
  console.log('wrote', file)
}
await writeFile('samples/Service_Agreement.pdf', await makeContract())
console.log('wrote samples/Service_Agreement.pdf')
