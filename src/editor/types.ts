/**
 * Edit-mode data model. All positions are page fractions (0..1 of page width /
 * height, y from the top) so they survive different render scales; stroke
 * widths and font sizes are in PDF points so exports match the preview.
 */

export type ToolId =
  | 'select'
  | 'retype'
  | 'text'
  | 'pen'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'erase'
  | 'whiteout'

export type PenVariant = 'ball' | 'marker' | 'highlight'

interface BaseObj {
  id: string
  pageId: string
}

export interface InkObj extends BaseObj {
  kind: 'ink'
  /** [xFrac, yFrac, pressure] */
  points: [number, number, number][]
  color: string
  widthPt: number
  simulatePressure: boolean
  pen: PenVariant
  opacity: number
}

/**
 * Scripts that need glyph shaping or reordering (Arabic joining, Indic and
 * Sinhala conjuncts, Hebrew RTL, Thai mark stacking) — pdf-lib places glyphs
 * one-by-one and cannot do this yet, so drawn text in these ranges will look
 * wrong in the saved PDF. Used to warn, never to block.
 */
export function needsComplexShaping(text: string): boolean {
  // Hebrew, Arabic + extensions, Indic scripts incl. Sinhala, Thai/Lao,
  // Myanmar, Khmer
  return /[֐-ࣿऀ-໿က-႟ក-៿]/.test(text)
}

/** Stroke pattern for shapes and lines. */
export type DashStyle = 'solid' | 'dashed' | 'dotted'

/**
 * Dash pattern (in the same units as the stroke width), undefined = solid.
 * Dotted uses zero-length dashes and needs round line caps to show as dots.
 */
export function dashPattern(dash: DashStyle | undefined, w: number): number[] | undefined {
  if (dash === 'dashed') return [w * 3.2, w * 2.2]
  if (dash === 'dotted') return [0.1, w * 2.4]
  return undefined
}

export interface ShapeObj extends BaseObj {
  kind: 'rect' | 'ellipse'
  x: number
  y: number
  w: number
  h: number
  stroke: string
  strokeWidthPt: number
  fill: string | null
  opacity: number
  dash?: DashStyle
  /** degrees, clockwise on screen, about the box centre (same as stamps) */
  rot?: number
}

export interface LineObj extends BaseObj {
  kind: 'line' | 'arrow'
  x1: number
  y1: number
  x2: number
  y2: number
  stroke: string
  strokeWidthPt: number
  opacity: number
  dash?: DashStyle
}

export interface TextObj extends BaseObj {
  kind: 'text'
  x: number
  y: number
  /** wrap width as a fraction of page width */
  w: number
  text: string
  fontId: string
  sizePt: number
  color: string
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  /** highlight color behind the text, or null */
  highlight: string | null
  /** graded weight (400..900) when known more precisely than bold on/off */
  weightHint?: number
  /**
   * degrees, clockwise on screen, about the box's nominal centre (see
   * textNominalHeightPt — newline count only, so preview and export agree on
   * the pivot no matter how the browser soft-wraps). Vertical source text
   * retypes with rot ±90 so the replacement lies the same way.
   */
  rot?: number
  /** set when this box was created by the retype tool */
  retypeOf?: {
    coverId: string
    originalText: string
    pdfFontName?: string
    /** style fingerprint at creation — unchanged boxes are discarded on close */
    baseline: string
  }
}

export function textStyleFingerprint(o: {
  fontId: string
  sizePt: number
  color: string
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  highlight: string | null
  rot?: number
}): string {
  return [o.fontId, o.sizePt, o.color, o.bold, o.italic, o.underline, o.strike, o.highlight, o.rot ?? 0].join('|')
}

/** Shared text metrics: keep the on-screen preview and the PDF export in sync. */
export const TEXT_LINE_HEIGHT = 1.3
export const TEXT_BASELINE = 0.94

/**
 * Nominal height of a text box in PDF points, counting only explicit newlines.
 * The browser may soft-wrap to more visual lines, but the rotation pivot must
 * be identical in the DOM preview and the PDF export — so both derive it from
 * this, never from a rendered height.
 */
export function textNominalHeightPt(o: { text: string; sizePt: number }): number {
  const lines = o.text ? o.text.split('\n').length : 1
  return lines * TEXT_LINE_HEIGHT * o.sizePt
}

/**
 * Rotation pivot of an object, in screen-oriented PDF points (x right, y down
 * from the page's top-left). Shapes and whiteout pivot on their box centre;
 * text pivots on the centre of its nominal (newline-count) box.
 */
export function rotationPivotPt(o: EditObj, wPt: number, hPt: number): { x: number; y: number } {
  if (o.kind === 'text') {
    return { x: (o.x + o.w / 2) * wPt, y: o.y * hPt + textNominalHeightPt(o) / 2 }
  }
  if (o.kind === 'rect' || o.kind === 'ellipse' || o.kind === 'whiteout') {
    return { x: (o.x + o.w / 2) * wPt, y: (o.y + o.h / 2) * hPt }
  }
  return { x: 0, y: 0 }
}

/** The object's rotation in degrees (0 when absent or of a kind that has none). */
export function rotOf(o: EditObj): number {
  return (o.kind === 'text' || o.kind === 'rect' || o.kind === 'ellipse' || o.kind === 'whiteout') && o.rot
    ? o.rot
    : 0
}

/**
 * Rotate a point about a pivot in screen coordinates (y down); positive
 * degrees turn clockwise on screen — the same convention as signature stamps.
 */
export function rotatePointScreen(
  px: number,
  py: number,
  cx: number,
  cy: number,
  deg: number,
): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  const dx = px - cx
  const dy = py - cy
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c }
}

export interface WhiteoutObj extends BaseObj {
  kind: 'whiteout'
  x: number
  y: number
  w: number
  h: number
  fill: string
  /** degrees, clockwise on screen, about the box centre (same as stamps) */
  rot?: number
}

export type EditObj = InkObj | ShapeObj | LineObj | TextObj | WhiteoutObj

export interface PageRef {
  id: string
  src: { type: 'orig'; index: number } | { type: 'blank'; wPt: number; hPt: number }
}

export interface Watermark {
  kind: 'text' | 'image'
  text: string
  sizePt: number
  color: string
  /** for image watermarks */
  image?: { dataUrl: string; w: number; h: number }
  /** image width as a fraction of the page width */
  scale: number
  opacity: number
  angleDeg: number
  tile: boolean
}

interface HistoryEntry {
  pages: PageRef[]
  objects: EditObj[]
  watermark: Watermark | null
}

export interface EditSession {
  docId: string
  pages: PageRef[]
  objects: EditObj[]
  watermark: Watermark | null
  selectedId: string | null
  editingId: string | null
  pageIndex: number
  /** measured page sizes in PDF points, filled as pages render */
  dims: Record<string, { wPt: number; hPt: number }>
  undo: HistoryEntry[]
  redo: HistoryEntry[]
  dirty: boolean
}

export interface EditorStyle {
  stroke: string
  fill: string | null
  strokeWidthPt: number
  dash: DashStyle
  opacity: number
  fontId: string
  fontSizePt: number
  textColor: string
  whiteoutFill: string
  pen: PenVariant
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  highlight: string | null
}

export function snapshotOf(s: EditSession): HistoryEntry {
  return structuredClone({ pages: s.pages, objects: s.objects, watermark: s.watermark })
}
