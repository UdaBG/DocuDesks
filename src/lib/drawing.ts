import { getStroke } from 'perfect-freehand'

export type StrokePoint = [number, number, number]

/** Signature drawing pens — how the nib responds to speed and pressure. */
export type SigPen = 'fountain' | 'ballpoint' | 'marker'

export const SIG_PENS: Record<SigPen, { size: number; thinning: number }> = {
  /** swells and thins with the hand, like a nib */
  fountain: { size: 5.5, thinning: 0.62 },
  /** a uniform fine line */
  ballpoint: { size: 3.2, thinning: 0.05 },
  /** broad, near-uniform felt tip */
  marker: { size: 10, thinning: 0.12 },
}

export interface Stroke {
  points: StrokePoint[]
  /** true when the input device reports no real pressure (mouse) */
  simulatePressure: boolean
  /** which pen drew this stroke (default fountain) */
  pen?: SigPen
}

const OPTIONS = {
  size: 5.5,
  thinning: 0.62,
  smoothing: 0.62,
  streamline: 0.45,
  last: true,
}

/** Outline points -> SVG path string (quadratic smoothing, closed). */
export function outlineToSvgPath(outline: number[][]): string {
  if (outline.length < 2) return ''
  const d: string[] = [`M ${outline[0][0].toFixed(2)} ${outline[0][1].toFixed(2)}`]
  for (let i = 1; i < outline.length; i++) {
    const [x0, y0] = outline[i - 1]
    const [x1, y1] = outline[i]
    d.push(`Q ${x0.toFixed(2)} ${y0.toFixed(2)} ${((x0 + x1) / 2).toFixed(2)} ${((y0 + y1) / 2).toFixed(2)}`)
  }
  d.push('Z')
  return d.join(' ')
}

export type PenVariant = 'ball' | 'marker' | 'highlight'

/** Stroke profile per pen variant — how the ink responds to speed/pressure. */
export const PEN_PROFILES: Record<PenVariant, { widthScale: number; thinning: number; opacity: number }> = {
  ball: { widthScale: 1.6, thinning: 0.62, opacity: 1 },
  marker: { widthScale: 3.6, thinning: 0.08, opacity: 1 },
  highlight: { widthScale: 7, thinning: 0.02, opacity: 0.38 },
}

/** Ink stroke -> filled SVG path in the same coordinate space as the points. */
export function inkToSvgPath(
  points: [number, number, number][],
  size: number,
  simulatePressure: boolean,
  pen: PenVariant = 'ball',
): string {
  const outline = getStroke(points, {
    ...OPTIONS,
    size,
    thinning: PEN_PROFILES[pen].thinning,
    simulatePressure,
  })
  return outlineToSvgPath(outline)
}

export function strokeToPath(stroke: Stroke): Path2D {
  const pen = SIG_PENS[stroke.pen ?? 'fountain']
  const outline = getStroke(stroke.points, {
    ...OPTIONS,
    size: pen.size,
    thinning: pen.thinning,
    simulatePressure: stroke.simulatePressure,
  })
  const path = new Path2D()
  if (outline.length < 2) return path
  path.moveTo(outline[0][0], outline[0][1])
  for (let i = 1; i < outline.length; i++) {
    const [x0, y0] = outline[i - 1]
    const [x1, y1] = outline[i]
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2)
  }
  path.closePath()
  return path
}

export function drawStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: Stroke[],
  color: string,
  scale = 1,
): void {
  ctx.save()
  ctx.scale(scale, scale)
  ctx.fillStyle = color
  for (const stroke of strokes) {
    ctx.fill(strokeToPath(stroke))
  }
  ctx.restore()
}
