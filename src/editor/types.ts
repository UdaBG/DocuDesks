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
}): string {
  return [o.fontId, o.sizePt, o.color, o.bold, o.italic, o.underline, o.strike, o.highlight].join('|')
}

/** Shared text metrics: keep the on-screen preview and the PDF export in sync. */
export const TEXT_LINE_HEIGHT = 1.3
export const TEXT_BASELINE = 0.94

export interface WhiteoutObj extends BaseObj {
  kind: 'whiteout'
  x: number
  y: number
  w: number
  h: number
  fill: string
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
