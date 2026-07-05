import { applySheen, inkHex, type InkValue } from './ink'
import { trimCanvas } from './imageUtils'

export interface ExtractOptions {
  /** 0..1 — how aggressively faint strokes are kept. */
  sensitivity: number
  /** 0..1 — how large a blob must be to survive despeckling. */
  despeckle: number
  /** 'original' keeps the photographed ink colour */
  ink: InkValue
}

export const DEFAULT_EXTRACT: ExtractOptions = {
  sensitivity: 0.55,
  despeckle: 0.35,
  ink: 'original',
}

const MAX_DIM = 1400

/**
 * Extract a signature from a photo or scan.
 *
 * Instead of a single global threshold (which fails on shadowed photos), the
 * image is divided by its own heavily-blurred copy — an illumination map —
 * so "ink" is defined as *darker than the paper around it*. That makes the
 * cut-out robust to gradients, phone shadows and off-white paper. Small
 * disconnected blobs (paper grain, dust) are removed with a connected-
 * component pass, and the result is cropped to the ink.
 */
export function extractSignature(
  image: HTMLImageElement | ImageBitmap,
  opts: ExtractOptions,
): HTMLCanvasElement | null {
  const srcW = image.width
  const srcH = image.height
  const scale = Math.min(1, MAX_DIM / Math.max(srcW, srcH))
  const w = Math.max(1, Math.round(srcW * scale))
  const h = Math.max(1, Math.round(srcH * scale))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(image, 0, 0, w, h)
  const imageData = ctx.getImageData(0, 0, w, h)
  const px = imageData.data
  const n = w * h

  // Luminance
  const lum = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    lum[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]
  }

  // Illumination map: what the paper would look like without ink.
  const radius = Math.max(8, Math.round(Math.max(w, h) / 18))
  const illum = boxBlur(lum, w, h, radius, 2)

  // Soft "inkness": how much darker than local paper each pixel is.
  const lo = 0.42 - opts.sensitivity * 0.34 // sensitive -> lower bar
  const hi = lo + 0.22
  const ink = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const darkness = 1 - lum[i] / Math.max(illum[i], 8)
    ink[i] = smoothstep(lo, hi, darkness)
  }

  // Despeckle: drop tiny connected components of the binary ink mask.
  const minArea = Math.round(10 + opts.despeckle * 240 * scale * scale * 4)
  removeSmallComponents(ink, w, h, 0.4, minArea)

  // Compose output pixels.
  const inkColor = opts.ink === 'original' ? null : hexToRgb(inkHex(opts.ink))
  for (let i = 0; i < n; i++) {
    const a = ink[i]
    if (a <= 0.02) {
      px[i * 4 + 3] = 0
      continue
    }
    if (inkColor) {
      px[i * 4] = inkColor[0]
      px[i * 4 + 1] = inkColor[1]
      px[i * 4 + 2] = inkColor[2]
    }
    px[i * 4 + 3] = Math.round(a * 255)
  }
  ctx.putImageData(imageData, 0, 0)

  const trimmed = trimCanvas(canvas, 10, 14)
  if (trimmed) applySheen(trimmed, opts.ink)
  return trimmed
}

function smoothstep(lo: number, hi: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)))
  return t * t * (3 - 2 * t)
}

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}

/** Separable box blur, `iterations` passes, O(n) per pass via running sums. */
function boxBlur(src: Float32Array, w: number, h: number, radius: number, iterations: number): Float32Array {
  let a = Float32Array.from(src)
  let b = new Float32Array(a.length)
  for (let it = 0; it < iterations; it++) {
    // horizontal
    for (let y = 0; y < h; y++) {
      const row = y * w
      let sum = 0
      for (let x = -radius; x <= radius; x++) sum += a[row + clampi(x, w)]
      for (let x = 0; x < w; x++) {
        b[row + x] = sum / (radius * 2 + 1)
        sum += a[row + clampi(x + radius + 1, w)] - a[row + clampi(x - radius, w)]
      }
    }
    // vertical
    for (let x = 0; x < w; x++) {
      let sum = 0
      for (let y = -radius; y <= radius; y++) sum += b[clampi(y, h) * w + x]
      for (let y = 0; y < h; y++) {
        a[y * w + x] = sum / (radius * 2 + 1)
        sum += b[clampi(y + radius + 1, h) * w + x] - b[clampi(y - radius, h) * w + x]
      }
    }
  }
  return a
}

function clampi(v: number, max: number) {
  return v < 0 ? 0 : v >= max ? max - 1 : v
}

/**
 * Zero out connected components (4-neighbour) of `ink > threshold` whose
 * pixel count is below `minArea`. Iterative flood fill, no recursion.
 */
function removeSmallComponents(
  ink: Float32Array,
  w: number,
  h: number,
  threshold: number,
  minArea: number,
): void {
  const n = w * h
  const labels = new Int32Array(n) // 0 = unvisited
  const stack = new Int32Array(n)
  let nextLabel = 1

  for (let start = 0; start < n; start++) {
    if (labels[start] !== 0 || ink[start] <= threshold) continue
    const label = nextLabel++
    let top = 0
    stack[top++] = start
    labels[start] = label
    const members: number[] = []
    while (top > 0) {
      const i = stack[--top]
      members.push(i)
      const x = i % w
      if (x > 0 && labels[i - 1] === 0 && ink[i - 1] > threshold) { labels[i - 1] = label; stack[top++] = i - 1 }
      if (x < w - 1 && labels[i + 1] === 0 && ink[i + 1] > threshold) { labels[i + 1] = label; stack[top++] = i + 1 }
      if (i >= w && labels[i - w] === 0 && ink[i - w] > threshold) { labels[i - w] = label; stack[top++] = i - w }
      if (i < n - w && labels[i + w] === 0 && ink[i + w] > threshold) { labels[i + w] = label; stack[top++] = i + w }
    }
    if (members.length < minArea) {
      for (const i of members) ink[i] = 0
    }
  }
}
