import { trimCanvas } from './imageUtils'

export interface SignatureFont {
  id: string
  family: string
  label: string
  /** relative size correction so all faces render at a similar optical size */
  scale: number
}

export const SIGNATURE_FONTS: SignatureFont[] = [
  { id: 'great-vibes', family: 'Great Vibes', label: 'Flourish', scale: 1.15 },
  { id: 'dancing-script', family: 'Dancing Script', label: 'Casual', scale: 1.0 },
  { id: 'sacramento', family: 'Sacramento', label: 'Slim', scale: 1.1 },
  { id: 'caveat', family: 'Caveat', label: 'Quick', scale: 1.05 },
  { id: 'homemade-apple', family: 'Homemade Apple', label: 'Handwritten', scale: 0.85 },
]

/** Render a typed name in a script face to a trimmed, transparent PNG canvas. */
export async function renderTypedSignature(
  text: string,
  font: SignatureFont,
  color: string,
): Promise<HTMLCanvasElement | null> {
  const size = Math.round(120 * font.scale)
  const spec = `400 ${size}px "${font.family}"`
  await document.fonts.load(spec, text)

  const measure = document.createElement('canvas').getContext('2d')!
  measure.font = spec
  const metrics = measure.measureText(text)
  const pad = size * 0.6
  const width = Math.ceil(metrics.width + pad * 2)
  const height = Math.ceil(size * 1.9)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.font = spec
  ctx.fillStyle = color
  ctx.textBaseline = 'middle'
  ctx.fillText(text, pad, height / 2)
  return trimCanvas(canvas, 8, 10)
}
