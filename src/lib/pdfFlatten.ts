import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  type PDFObject,
  type PDFPage,
} from 'pdf-lib'

/**
 * Annotations (sticky text, stamps, filled form widgets) paint ABOVE the page
 * content in every viewer, so nothing drawn into the content stream — whiteout
 * covers, retype covers, placed signatures — can ever hide them. Flatten them
 * instead: draw each annotation's normal appearance into the content stream
 * (identical pixels), then drop the annotation object. Anything drawn
 * afterwards lands on top. Links stay interactive; hidden annotations are
 * removed; unparseable ones are left untouched.
 */
export function flattenAnnotations(page: PDFPage): void {
  const context = page.doc.context
  const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray)
  if (!annots) return
  const kept: PDFObject[] = []
  for (let i = 0; i < annots.size(); i++) {
    const raw = annots.get(i)
    try {
      const dict = annots.lookup(i, PDFDict)
      if (dict.get(PDFName.of('Subtype')) === PDFName.of('Link')) {
        kept.push(raw)
        continue
      }
      const flags = dict.lookupMaybe(PDFName.of('F'), PDFNumber)?.asNumber() ?? 0
      if (flags & 0b10) continue // hidden: drop without drawing
      // normal appearance; may be a sub-dictionary of states keyed by /AS
      const apDict = dict.lookupMaybe(PDFName.of('AP'), PDFDict)
      let n = apDict?.get(PDFName.of('N'))
      let stream = n instanceof PDFRef ? context.lookup(n) : n
      if (stream instanceof PDFDict && !(stream instanceof PDFStream)) {
        const as = dict.get(PDFName.of('AS'))
        n = (as instanceof PDFName ? stream.get(as) : undefined) ?? stream.entries()[0]?.[1]
        stream = n instanceof PDFRef ? context.lookup(n) : n
      }
      if (!(stream instanceof PDFStream)) continue // nothing visible — drop
      const rect = dict.lookup(PDFName.of('Rect'), PDFArray)
      const [ra, rb, rc, rd] = [0, 1, 2, 3].map((j) => rect.lookup(j, PDFNumber).asNumber())
      const rx = Math.min(ra, rc)
      const ry = Math.min(rb, rd)
      const rw = Math.abs(rc - ra)
      const rh = Math.abs(rd - rb)
      const sDict = (stream as PDFStream).dict
      const bboxArr = sDict.lookupMaybe(PDFName.of('BBox'), PDFArray)
      const bbox = bboxArr
        ? [0, 1, 2, 3].map((j) => bboxArr.lookup(j, PDFNumber).asNumber())
        : [0, 0, 1, 1]
      const mArr = sDict.lookupMaybe(PDFName.of('Matrix'), PDFArray)
      const m = mArr
        ? [0, 1, 2, 3, 4, 5].map((j) => mArr.lookup(j, PDFNumber).asNumber())
        : [1, 0, 0, 1, 0, 0]
      // PDF 32000 §12.5.5: map the Matrix-transformed BBox onto /Rect
      const pts = [
        [bbox[0], bbox[1]],
        [bbox[2], bbox[1]],
        [bbox[2], bbox[3]],
        [bbox[0], bbox[3]],
      ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]])
      const minX = Math.min(...pts.map((p) => p[0]))
      const minY = Math.min(...pts.map((p) => p[1]))
      const w = Math.max(Math.max(...pts.map((p) => p[0])) - minX, 1e-6)
      const h = Math.max(Math.max(...pts.map((p) => p[1])) - minY, 1e-6)
      const sx = rw / w
      const sy = rh / h
      const name = page.node.newXObject(
        'FlatAnnot',
        n instanceof PDFRef ? n : context.register(stream),
      )
      page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(sx, 0, 0, sy, rx - minX * sx, ry - minY * sy),
        drawObject(name),
        popGraphicsState(),
      )
    } catch {
      kept.push(raw) // unparseable annotation: leave it untouched
    }
  }
  page.node.set(PDFName.of('Annots'), context.obj(kept))
}
