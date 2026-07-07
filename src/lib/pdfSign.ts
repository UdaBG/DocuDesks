import { degrees, PDFDocument, type PDFImage } from 'pdf-lib'
import type { Placement, SavedSignature } from '../types'
import { fitStampBox, resolvePageIndex } from '../types'
import { dataUrlToBytes } from './imageUtils'
import { flattenAnnotations } from './pdfFlatten'
import { safeStem } from './fileName'

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
  const flattened = new Set<number>()

  for (const stamp of stamps) {
    let png = embedded.get(stamp.signature.id)
    if (!png) {
      png = await pdf.embedPng(dataUrlToBytes(stamp.signature.dataUrl))
      embedded.set(stamp.signature.id, png)
    }
    const pageIndex = resolvePageIndex(stamp.placement, pdf.getPageCount())
    const page = pdf.getPage(pageIndex)
    if (!flattened.has(pageIndex)) {
      // annotations paint above page content — flatten them first so an
      // opaque one can never cover the signature drawn below
      flattenAnnotations(page)
      flattened.add(pageIndex)
    }
    const { width: pw, height: ph } = page.getSize()
    const box = fitStampBox(stamp.placement, stamp.signature.width, stamp.signature.height, pw, ph)
    const rot = stamp.placement.rot ?? 0
    let x = box.x
    let y = ph - box.yTop - box.h
    if (rot) {
      // pdf-lib rotates about the image's bottom-left corner (ccw positive,
      // y-up), the preview about the stamp's centre (cw positive, y-down):
      // same visual angle is -rot, and the corner orbits the centre.
      const th = (-rot * Math.PI) / 180
      const cx = x + box.w / 2
      const cy = y + box.h / 2
      x = cx + (-box.w / 2) * Math.cos(th) - (-box.h / 2) * Math.sin(th)
      y = cy + (-box.w / 2) * Math.sin(th) + (-box.h / 2) * Math.cos(th)
    }
    page.drawImage(png, { x, y, width: box.w, height: box.h, rotate: degrees(-rot) })
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
  return `${safeStem(original)}_signed.pdf`
}
