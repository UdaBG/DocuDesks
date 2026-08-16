import { trimCanvas } from './imageUtils'

/**
 * Date stamps: today's date rendered to a trimmed transparent PNG, so it
 * rides the exact same pipeline as signature stamps (drag/rotate/fit,
 * applyStamps, read-mode compositing) with no new PDF machinery.
 */

export type DateFormatId = 'dmy' | 'mdy' | 'ymd' | 'iso' | 'long' | 'ordinal' | 'us-long'

export const DATE_FORMATS: DateFormatId[] = ['dmy', 'mdy', 'ymd', 'iso', 'long', 'ordinal', 'us-long']

export interface DateFont {
  id: string
  /** CSS family for rendering — every family here is bundled or standard */
  css: string
  /** i18n key for the picker label */
  labelKey: string
  /** relative size correction so faces render at a similar optical size */
  scale: number
}

export const DATE_FONTS: DateFont[] = [
  { id: 'print', css: 'Arial, "Liberation Sans", sans-serif', labelKey: 'date.fontPrint', scale: 1 },
  { id: 'serif', css: '"Times New Roman", "Liberation Serif", serif', labelKey: 'date.fontSerif', scale: 1 },
  { id: 'mono', css: '"Courier New", Cousine, monospace', labelKey: 'date.fontMono', scale: 0.92 },
  { id: 'script', css: 'Caveat, cursive', labelKey: 'date.fontScript', scale: 1.18 },
]

export function dateFontById(id: string): DateFont {
  return DATE_FONTS.find((f) => f.id === id) ?? DATE_FONTS[0]
}

const ordinal = (n: number): string => {
  const rem10 = n % 10
  const rem100 = n % 100
  if (rem10 === 1 && rem100 !== 11) return `${n}st`
  if (rem10 === 2 && rem100 !== 12) return `${n}nd`
  if (rem10 === 3 && rem100 !== 13) return `${n}rd`
  return `${n}th`
}

/** Format a date in the given style; month names localize via Intl. */
export function formatDate(date: Date, format: DateFormatId, locale: string): string {
  const dd = String(date.getDate()).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const yyyy = String(date.getFullYear())
  const month = new Intl.DateTimeFormat(locale, { month: 'long' }).format(date)
  switch (format) {
    case 'dmy':
      return `${dd}/${mm}/${yyyy}`
    case 'mdy':
      return `${mm}/${dd}/${yyyy}`
    case 'ymd':
      return `${yyyy}/${mm}/${dd}`
    case 'iso':
      return `${yyyy}-${mm}-${dd}`
    case 'long':
      return `${date.getDate()} ${month} ${yyyy}`
    case 'ordinal':
      // ordinal suffixes are an English habit — other locales read best plain
      return locale.startsWith('en')
        ? `${ordinal(date.getDate())} ${month} ${yyyy}`
        : `${date.getDate()} ${month} ${yyyy}`
    case 'us-long':
      return `${month} ${date.getDate()}, ${yyyy}`
  }
}

export interface DateImage {
  dataUrl: string
  width: number
  height: number
}

/** Render date text to a trimmed transparent PNG (crisp at stamp sizes). */
export async function renderDateImage(
  text: string,
  fontId: string,
  color: string,
): Promise<DateImage | null> {
  const font = dateFontById(fontId)
  const size = Math.round(96 * font.scale)
  const spec = `400 ${size}px ${font.css}`
  try {
    await document.fonts.load(spec, text)
  } catch {
    /* family resolves through fallbacks */
  }
  const measure = document.createElement('canvas').getContext('2d')!
  measure.font = spec
  const metrics = measure.measureText(text)
  const pad = size * 0.4
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(metrics.width + pad * 2)
  canvas.height = Math.ceil(size * 1.7)
  const ctx = canvas.getContext('2d')!
  ctx.font = spec
  ctx.fillStyle = color
  ctx.textBaseline = 'middle'
  ctx.fillText(text, pad, canvas.height / 2)
  const trimmed = trimCanvas(canvas, 6, 8)
  if (!trimmed) return null
  return { dataUrl: trimmed.toDataURL('image/png'), width: trimmed.width, height: trimmed.height }
}
