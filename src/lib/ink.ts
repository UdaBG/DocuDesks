import { INK_COLORS } from '../types'

/**
 * An ink choice: a preset key ('black' | 'blue-black' | 'royal'), a metallic
 * ('gold' | 'silver'), 'original' (photo extraction only), or any '#rrggbb'.
 */
export type InkValue = string

/** Flat base tone a metallic falls back to (previews, stroke fill). */
export const METALLIC_BASE: Record<'gold' | 'silver', string> = {
  gold: '#b8860b',
  silver: '#8f98a3',
}

/** Gradient stops that give metallic ink its sheen. */
const SHEEN: Record<'gold' | 'silver', string[]> = {
  gold: ['#8a6a12', '#d9b03a', '#f7e07f', '#c89b28', '#8a6a12'],
  silver: ['#6f7780', '#b9c1ca', '#eef2f6', '#9aa2ab', '#6f7780'],
}

export function isMetallic(v: InkValue): v is 'gold' | 'silver' {
  return v === 'gold' || v === 'silver'
}

/** Flat colour for an ink value — metallics resolve to their base tone. */
export function inkHex(v: InkValue): string {
  if (isMetallic(v)) return METALLIC_BASE[v]
  if (v in INK_COLORS) return INK_COLORS[v as keyof typeof INK_COLORS]
  return v
}

/** CSS background for a swatch — metallics show their sheen. */
export function inkSwatchCss(v: InkValue): string {
  return isMetallic(v) ? `linear-gradient(135deg, ${SHEEN[v].join(', ')})` : inkHex(v)
}

/**
 * Overlay a metallic sheen on everything already drawn: a diagonal gradient
 * composited `source-in`, so it re-colours the ink but keeps its alpha.
 * No-op for non-metallic values.
 */
export function applySheen(canvas: HTMLCanvasElement, v: InkValue): void {
  if (!isMetallic(v)) return
  const ctx = canvas.getContext('2d')!
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'source-in'
  const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height * 0.8)
  const stops = SHEEN[v]
  stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c))
  ctx.fillStyle = g
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.restore()
}
