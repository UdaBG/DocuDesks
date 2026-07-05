import { StandardFonts } from 'pdf-lib'
import libSansR from '../assets/fonts/LiberationSans-Regular.ttf?url'
import libSansB from '../assets/fonts/LiberationSans-Bold.ttf?url'
import libSansI from '../assets/fonts/LiberationSans-Italic.ttf?url'
import libSansBI from '../assets/fonts/LiberationSans-BoldItalic.ttf?url'
import libSerifR from '../assets/fonts/LiberationSerif-Regular.ttf?url'
import libSerifB from '../assets/fonts/LiberationSerif-Bold.ttf?url'
import libSerifI from '../assets/fonts/LiberationSerif-Italic.ttf?url'
import libSerifBI from '../assets/fonts/LiberationSerif-BoldItalic.ttf?url'

/**
 * Fonts for the text tool.
 *
 * Primary source: the Local Font Access API (queryLocalFonts) — every family
 * installed on the machine, like Word's font list, including the raw bytes we
 * embed into the PDF. Fallback when the API is unavailable or denied: a
 * curated set of well-known font files, and always the three standard PDF
 * faces which need no embedding at all.
 */

export interface EditorFont {
  id: string // 'std:helvetica' | 'local:<family>' | 'file:<id>'
  label: string
  /** CSS family for a faithful on-screen preview */
  css: string
  source: 'std' | 'local' | 'file'
  family?: string
}

interface LocalFontData {
  family: string
  fullName: string
  postscriptName: string
  style: string
  blob(): Promise<Blob>
}

declare global {
  interface Window {
    queryLocalFonts?: () => Promise<LocalFontData[]>
  }
}

const STD: EditorFont[] = [
  { id: 'std:helvetica', label: 'Helvetica', css: 'Arial, Helvetica, sans-serif', source: 'std' },
  { id: 'std:times', label: 'Times Roman', css: '"Times New Roman", Times, serif', source: 'std' },
  { id: 'std:courier', label: 'Courier', css: '"Courier New", Courier, monospace', source: 'std' },
]

const STD_VARIANTS: Record<string, [StandardFonts, StandardFonts, StandardFonts, StandardFonts]> = {
  // [regular, bold, italic, boldItalic]
  'std:helvetica': [
    StandardFonts.Helvetica,
    StandardFonts.HelveticaBold,
    StandardFonts.HelveticaOblique,
    StandardFonts.HelveticaBoldOblique,
  ],
  'std:times': [
    StandardFonts.TimesRoman,
    StandardFonts.TimesRomanBold,
    StandardFonts.TimesRomanItalic,
    StandardFonts.TimesRomanBoldItalic,
  ],
  'std:courier': [
    StandardFonts.Courier,
    StandardFonts.CourierBold,
    StandardFonts.CourierOblique,
    StandardFonts.CourierBoldOblique,
  ],
}

/** Map style/name words to a CSS-style numeric weight. */
export function parseWeight(s: string): number {
  const t = s.toLowerCase()
  if (/black|heavy/.test(t)) return 900
  if (/extra\s*bold|ultra\s*bold/.test(t)) return 800
  if (/semi\s*bold|demi\s*bold|demi(?![a-z])/.test(t)) return 600
  if (/bold/.test(t)) return 700
  if (/medium/.test(t)) return 500
  if (/extra\s*light|ultra\s*light|thin|hairline/.test(t)) return 200
  if (/light|semilight/.test(t)) return 300
  return 400
}

const FONTS_DIR = 'C:\\Windows\\Fonts\\'
const FILE_FALLBACK: { id: string; label: string; css: string; file: string; bold?: string; semibold?: string; italic?: string; boldItalic?: string }[] = [
  { id: 'file:arial', label: 'Arial', css: 'Arial, sans-serif', file: 'arial.ttf', bold: 'arialbd.ttf', italic: 'ariali.ttf', boldItalic: 'arialbi.ttf' },
  { id: 'file:calibri', label: 'Calibri', css: 'Calibri, sans-serif', file: 'calibri.ttf', bold: 'calibrib.ttf', italic: 'calibrii.ttf', boldItalic: 'calibriz.ttf' },
  { id: 'file:segoe', label: 'Segoe UI', css: '"Segoe UI", sans-serif', file: 'segoeui.ttf', bold: 'segoeuib.ttf', semibold: 'seguisb.ttf', italic: 'segoeuii.ttf', boldItalic: 'segoeuiz.ttf' },
  { id: 'file:georgia', label: 'Georgia', css: 'Georgia, serif', file: 'georgia.ttf', bold: 'georgiab.ttf', italic: 'georgiai.ttf', boldItalic: 'georgiaz.ttf' },
  { id: 'file:tahoma', label: 'Tahoma', css: 'Tahoma, sans-serif', file: 'tahoma.ttf', bold: 'tahomabd.ttf' },
  { id: 'file:verdana', label: 'Verdana', css: 'Verdana, sans-serif', file: 'verdana.ttf', bold: 'verdanab.ttf', italic: 'verdanai.ttf', boldItalic: 'verdanaz.ttf' },
  { id: 'file:trebuchet', label: 'Trebuchet MS', css: '"Trebuchet MS", sans-serif', file: 'trebuc.ttf', bold: 'trebucbd.ttf', italic: 'trebucit.ttf', boldItalic: 'trebucbi.ttf' },
  { id: 'file:comic', label: 'Comic Sans MS', css: '"Comic Sans MS", cursive', file: 'comic.ttf', bold: 'comicbd.ttf' },
  { id: 'file:impact', label: 'Impact', css: 'Impact, sans-serif', file: 'impact.ttf' },
  { id: 'file:times-nr', label: 'Times New Roman', css: '"Times New Roman", serif', file: 'times.ttf', bold: 'timesbd.ttf', italic: 'timesi.ttf', boldItalic: 'timesbi.ttf' },
  { id: 'file:courier-new', label: 'Courier New', css: '"Courier New", monospace', file: 'cour.ttf', bold: 'courbd.ttf', italic: 'couri.ttf', boldItalic: 'courbi.ttf' },
]

/**
 * Bundled metric-compatible stand-ins (Liberation, SIL OFL) for platforms
 * where neither queryLocalFonts nor the Windows font files exist — Android
 * in particular. Keyed by the same ids as FILE_FALLBACK so font matching
 * and cross-device documents behave identically.
 */
const BUNDLED: Record<
  string,
  { label: string; css: string; regular: string; bold: string; italic: string; boldItalic: string }
> = {
  'file:arial': {
    label: 'Arial',
    css: 'Arial, "Liberation Sans", sans-serif',
    regular: libSansR,
    bold: libSansB,
    italic: libSansI,
    boldItalic: libSansBI,
  },
  'file:times-nr': {
    label: 'Times New Roman',
    css: '"Times New Roman", "Liberation Serif", serif',
    regular: libSerifR,
    bold: libSerifB,
    italic: libSerifI,
    boldItalic: libSerifBI,
  },
}

const facesByFamily = new Map<string, LocalFontData[]>()
const bytesCache = new Map<string, Uint8Array>()
let fontList: EditorFont[] | null = null
let hasLocalFonts = false
let fileFallback: EditorFont[] | null = null

export function hasFullFontList(): boolean {
  return hasLocalFonts
}

/**
 * Build the font list. queryLocalFonts requires *user activation* on some
 * WebViews, so callers re-invoke this from a pointerdown until the full list
 * is available; until then the curated file fallback is used.
 */
export async function availableFonts(): Promise<EditorFont[]> {
  if (fontList && hasLocalFonts) return fontList
  const out = [...STD]

  try {
    // Some WebViews leave the permission promise pending forever — time out
    // and degrade to the curated list rather than hang the panel.
    const faces = await Promise.race([
      window.queryLocalFonts?.(),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 6000)),
    ])
    if (faces?.length) {
      facesByFamily.clear()
      for (const f of faces) {
        const arr = facesByFamily.get(f.family) ?? []
        arr.push(f)
        facesByFamily.set(f.family, arr)
      }
      for (const family of [...facesByFamily.keys()].sort((a, b) => a.localeCompare(b))) {
        out.push({ id: `local:${family}`, label: family, css: `"${family}"`, source: 'local', family })
      }
      hasLocalFonts = true
    }
  } catch {
    /* denied (e.g. no user activation yet) or unsupported — fall through */
  }

  if (!hasLocalFonts) {
    if (!fileFallback) {
      fileFallback = []
      for (const f of FILE_FALLBACK) {
        try {
          if (await window.signer.exists(FONTS_DIR + f.file)) {
            fileFallback.push({ id: f.id, label: f.label, css: f.css, source: 'file', family: f.label })
          }
        } catch {
          /* platform without that path */
        }
      }
      // no installed files reachable (Android/iOS): the bundled stand-ins
      for (const [id, b] of Object.entries(BUNDLED)) {
        if (!fileFallback.some((f) => f.id === id)) {
          fileFallback.push({ id, label: b.label, css: b.css, source: 'file', family: b.label })
        }
      }
    }
    out.push(...fileFallback)
  }

  fontList = out
  return out
}

export function fontById(id: string): EditorFont {
  const list = fontList ?? STD
  return (
    list.find((f) => f.id === id) ??
    // migrate pre-rework ids ('helvetica', 'arial', …)
    list.find((f) => f.id === `std:${id}` || f.id === `file:${id}`) ??
    STD[0]
  )
}

function pickFace(faces: LocalFontData[], weight: number, italic: boolean): LocalFontData {
  const score = (f: LocalFontData) => {
    const s = `${f.style} ${f.fullName}`
    const w = parseWeight(s)
    const isItalic = /italic|oblique/i.test(s)
    let sc = -Math.abs(w - weight) / 100
    // on a tie, the lighter face reads closer to the original than a heavier one
    if (w > weight) sc -= 0.01
    if (isItalic === italic) sc += 4
    if (/condensed|narrow|caption|display/i.test(s)) sc -= 3
    return sc
  }
  return [...faces].sort((a, b) => score(b) - score(a))[0]
}

export interface ResolvedFont {
  std?: StandardFonts
  bytes?: Uint8Array
}

async function resolveBundled(id: string, weight: number, italic: boolean): Promise<Uint8Array | null> {
  const b = BUNDLED[id]
  if (!b) return null
  const url = weight >= 600 ? (italic ? b.boldItalic : b.bold) : italic ? b.italic : b.regular
  let bytes = bytesCache.get(url)
  if (!bytes) {
    try {
      bytes = new Uint8Array(await (await fetch(url)).arrayBuffer())
    } catch {
      return null
    }
    bytesCache.set(url, bytes)
  }
  return bytes
}

/**
 * Font data for embedding. `weight` is graded (400..900): families with
 * intermediate faces (e.g. Segoe UI Semibold) match them instead of
 * overshooting to full bold.
 */
export async function resolveFont(
  id: string,
  bold: boolean,
  italic: boolean,
  weightHint?: number,
): Promise<ResolvedFont> {
  const weight = weightHint ?? (bold ? 700 : 400)
  const font = fontById(id)
  const stdIndex = (weight >= 600 ? 1 : 0) + (italic ? 2 : 0)
  if (font.source === 'std') {
    return { std: STD_VARIANTS[font.id][stdIndex] }
  }
  if (font.source === 'local') {
    const faces = facesByFamily.get(font.family!)
    if (faces?.length) {
      const face = pickFace(faces, weight, italic)
      let bytes = bytesCache.get(face.postscriptName)
      if (!bytes) {
        bytes = new Uint8Array(await (await face.blob()).arrayBuffer())
        bytesCache.set(face.postscriptName, bytes)
      }
      return { bytes }
    }
  }
  if (font.source === 'file') {
    const spec = FILE_FALLBACK.find((f) => f.id === font.id)
    if (spec) {
      const file =
        (weight >= 600 && weight < 700 && spec.semibold) ||
        (weight >= 600 && italic && spec.boldItalic) ||
        (weight >= 600 && spec.bold) ||
        (italic && spec.italic) ||
        spec.file
      let bytes = bytesCache.get(file)
      if (!bytes) {
        try {
          bytes = await window.signer.readFile(FONTS_DIR + file)
          bytesCache.set(file, bytes)
        } catch {
          const bundled = await resolveBundled(font.id, weight, italic)
          if (bundled) return { bytes: bundled }
          return { std: STD_VARIANTS['std:helvetica'][stdIndex] }
        }
      }
      return { bytes }
    }
    const bundled = await resolveBundled(font.id, weight, italic)
    if (bundled) return { bytes: bundled }
  }
  return { std: STD_VARIANTS['std:helvetica'][stdIndex] }
}

export interface PdfFontMatch {
  fontId: string
  bold: boolean
  italic: boolean
  weightHint: number
  /** cleaned original name, for display ("what did we substitute?") */
  pdfName?: string
}

/**
 * For the retype tool: find the best available font for a PDF font name like
 * "ABCDEF+TimesNewRomanPS-BoldMT", falling back to a generic family class.
 * Weight is graded, so "Semibold"/"Medium" originals don't overshoot to a
 * heavy Bold face.
 */
export function matchFontFromPdf(
  pdfFontName: string | undefined,
  genericFamily: string | undefined,
): PdfFontMatch {
  const cleanRaw = (pdfFontName ?? '').replace(/^[A-Z]{6}\+/, '')
  const clean = cleanRaw.toLowerCase()
  const weightHint = clean ? parseWeight(clean) : 400
  const bold = weightHint >= 600
  const italic = /italic|oblique/.test(clean)
  const list = fontList ?? STD
  const result = (fontId: string): PdfFontMatch => ({
    fontId,
    bold,
    italic,
    weightHint,
    pdfName: cleanRaw || undefined,
  })

  if (clean) {
    const locals = list
      .filter((f) => f.source !== 'std' && f.family)
      .sort((a, b) => b.family!.length - a.family!.length)
    for (const f of locals) {
      if (clean.includes(f.family!.toLowerCase().replace(/\s+/g, ''))) {
        return result(f.id)
      }
    }
  }

  const generic = genericFamily ?? (/(times|serif|georgia|garamond|book)/.test(clean) ? 'serif' : 'sans-serif')
  // Intermediate weights prefer a family that actually has such faces.
  const midWeight = weightHint >= 500 && weightHint < 700
  const wanted =
    generic === 'monospace'
      ? ['Courier New', 'Consolas']
      : generic === 'serif'
        ? ['Times New Roman', 'Georgia']
        : midWeight
          ? ['Segoe UI', 'Arial', 'Calibri']
          : ['Arial', 'Segoe UI', 'Calibri']
  for (const fam of wanted) {
    const hit = list.find((f) => f.family === fam)
    if (hit) return result(hit.id)
  }
  return result(
    generic === 'monospace' ? 'std:courier' : generic === 'serif' ? 'std:times' : 'std:helvetica',
  )
}
