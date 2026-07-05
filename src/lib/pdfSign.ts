import { PDFDocument, type PDFImage } from 'pdf-lib'
import type { Placement, SavedSignature } from '../types'
import { fitStampBox, resolvePageIndex } from '../types'
import { dataUrlToBytes } from './imageUtils'

export interface StampInput {
  signature: SavedSignature
  placement: Placement
}

/**
 * Stamp one or more signatures into a document and return the new PDF bytes.
 * Placements are page fractions with `yb` = bottom edge from the page top;
 * each stamp is fitted to its spot's max-height constraint.
 */
export async function applyStamps(bytes: Uint8Array, stamps: StampInput[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes.slice(), { ignoreEncryption: true })
  const embedded = new Map<string, PDFImage>()

  for (const stamp of stamps) {
    let png = embedded.get(stamp.signature.id)
    if (!png) {
      png = await pdf.embedPng(dataUrlToBytes(stamp.signature.dataUrl))
      embedded.set(stamp.signature.id, png)
    }
    const pageIndex = resolvePageIndex(stamp.placement, pdf.getPageCount())
    const page = pdf.getPage(pageIndex)
    const { width: pw, height: ph } = page.getSize()
    const box = fitStampBox(stamp.placement, stamp.signature.width, stamp.signature.height, pw, ph)
    page.drawImage(png, { x: box.x, y: ph - box.yTop - box.h, width: box.w, height: box.h })
  }
  return pdf.save()
}

/** Single-stamp convenience wrapper. */
export function applySignature(
  bytes: Uint8Array,
  signature: SavedSignature,
  placement: Placement,
): Promise<Uint8Array> {
  return applyStamps(bytes, [{ signature, placement }])
}

export function signedName(original: string): string {
  const dot = original.toLowerCase().lastIndexOf('.pdf')
  const stem = dot > 0 ? original.slice(0, dot) : original
  return `${stem}_signed.pdf`
}
