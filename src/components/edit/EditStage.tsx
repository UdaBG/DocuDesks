import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../../store'
import { useEdit } from '../../editor/editStore'
import type { EditObj, LineObj, TextObj, ToolId, Watermark } from '../../editor/types'
import { dashPattern, TEXT_BASELINE, TEXT_LINE_HEIGHT, textStyleFingerprint } from '../../editor/types'
import { uid } from '../../types'
import type { PDFPageProxy } from 'pdfjs-dist'
import { openPdf, renderPage, type OpenedPdf } from '../../lib/pdf'
import { ocrPage, pageLooksScanned, setOcrProgress } from '../../lib/ocr'
import { inkToSvgPath, PEN_PROFILES } from '../../lib/drawing'
import { fontById, matchFontFromPdf } from '../../editor/fonts'
import { useMediaQuery } from '../../lib/useMediaQuery'
import EditToolbar from './EditToolbar'
import PagesStrip from './PagesStrip'
import { ColorPopover } from './ColorField'

const TOOL_KEYS: Record<string, ToolId> = {
  v: 'select',
  x: 'retype',
  t: 'text',
  p: 'pen',
  r: 'rect',
  o: 'ellipse',
  l: 'line',
  a: 'arrow',
  e: 'erase',
  w: 'whiteout',
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

interface PageView {
  pageId: string
  W: number
  H: number
  wPt: number
  hPt: number
  canvas: HTMLCanvasElement | null
}

interface TextPiece {
  str: string
  x: number
  y: number
  w: number
  h: number
  fontName?: string
  /** piece came from OCR (no font info; covers must match the scan's paper) */
  ocr?: boolean
}

interface PageText {
  pieces: TextPiece[]
  /** pdf.js getTextContent styles: internal font id -> generic family */
  families: Record<string, string | undefined>
}

/** Do two pieces occupy the same spot? (used to merge OCR under real text) */
function piecesOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  if (ix <= Math.min(a.w, b.w) * 0.3) return false
  return Math.abs(a.y - b.y) < Math.max(a.h, b.h) * 0.8
}

/**
 * A saved retype leaves the original run in the content stream (covered by
 * whiteout) with the replacement drawn on top. Editing that area again must
 * see only the visible run: drop earlier pieces that a later piece overlaps.
 */
function dedupeOverlappingPieces(pieces: TextPiece[]): TextPiece[] {
  const out: TextPiece[] = []
  for (const p of pieces) {
    for (let i = out.length - 1; i >= 0; i--) {
      const q = out[i]
      const sameLine = Math.abs(q.y - p.y) < Math.max(q.h, p.h) * 0.45
      const overlap = Math.min(q.x + q.w, p.x + p.w) - Math.max(q.x, p.x)
      if (sameLine && overlap > 0.5 * Math.min(q.w, p.w)) out.splice(i, 1)
    }
    out.push(p)
  }
  return out
}

function inkFromPixels(data: Uint8ClampedArray): string | null {
  // Ink is the colour that contrasts MOST with the background, not simply the
  // darkest — so this works for dark-on-light AND light-on-dark (e.g. white
  // text on a blue table header). Background = channel-wise median, since ink
  // covers a minority of the region.
  const rs: number[] = []
  const gs: number[] = []
  const bs: number[] = []
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 200) {
      rs.push(data[i])
      gs.push(data[i + 1])
      bs.push(data[i + 2])
    }
  }
  if (rs.length < 8) return null
  const med = (a: number[]) => {
    a.sort((x, y) => x - y)
    return a[a.length >> 1]
  }
  const bgR = med(rs)
  const bgG = med(gs)
  const bgB = med(bs)
  // the pixel furthest from the background is the crispest (full) ink pixel
  let bestI = -1
  let bestD = -1
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] <= 200) continue
    const d = Math.abs(data[i] - bgR) + Math.abs(data[i + 1] - bgG) + Math.abs(data[i + 2] - bgB)
    if (d > bestD) {
      bestD = d
      bestI = i
    }
  }
  if (bestI < 0 || bestD < 60) return null // uniform region — no distinct ink
  const br = data[bestI]
  const bg = data[bestI + 1]
  const bb = data[bestI + 2]
  // average the pixels near that ink colour (the crisp core, not the
  // antialiased edge pixels that blend toward the background)
  let n = 0
  let r = 0
  let g = 0
  let b = 0
  for (let i = 0; i < data.length; i += 4) {
    if (Math.abs(data[i] - br) + Math.abs(data[i + 1] - bg) + Math.abs(data[i + 2] - bb) < 60) {
      n++
      r += data[i]
      g += data[i + 1]
      b += data[i + 2]
    }
  }
  if (n < 3) return null
  const hex = (v: number) => Math.round(v / n).toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

/**
 * True ink color of a text run: re-render just that region at 4x off-screen,
 * where thin strokes actually reach full ink (at screen scale an 11pt stroke
 * never leaves the antialiasing grey zone).
 */
async function sampleRunColorHiRes(
  page: PDFPageProxy,
  xPt: number,
  baselineY: number,
  wPt: number,
  fs: number,
): Promise<string | null> {
  const SCALE = 4
  const w = Math.max(8, Math.min(Math.ceil(wPt * SCALE), 2400))
  const h = Math.max(8, Math.ceil(fs * 1.1 * SCALE))
  const baseH = page.getViewport({ scale: 1 }).height
  const topPt = baseH - baselineY - fs * 0.85
  const viewport = page.getViewport({ scale: SCALE, offsetX: -xPt * SCALE, offsetY: -topPt * SCALE })
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  await page.render({ canvas, canvasContext: ctx, viewport }).promise
  return inkFromPixels(ctx.getImageData(0, 0, w, h).data)
}

function medianColor(rs: number[], gs: number[], bs: number[]): string | null {
  if (rs.length < 16) return null
  const median = (a: number[]) => a.sort((x1, x2) => x1 - x2)[Math.floor(a.length / 2)]
  const to = (v: number) => v.toString(16).padStart(2, '0')
  return `#${to(median(rs))}${to(median(gs))}${to(median(bs))}`
}

/**
 * The paper tone behind a text run — the channel-wise median of the padded
 * region's pixels. Ink covers a minority of the area, so the median lands on
 * the background whatever its colour: white paper, a tinted table cell, a
 * scan's off-white, even dark themes.
 */
function samplePaperColor(
  canvas: HTMLCanvasElement,
  xPt: number,
  yTopPt: number,
  wRunPt: number,
  hRunPt: number,
  pageWPt: number,
  pageHPt: number,
): string | null {
  const sx = canvas.width / pageWPt
  const sy = canvas.height / pageHPt
  // pad the region so the sample is dominated by paper, not ink
  const x = Math.max(0, Math.floor((xPt - 6) * sx))
  const y = Math.max(0, Math.floor((yTopPt - 4) * sy))
  const w = Math.min(canvas.width - x, Math.ceil((wRunPt + 12) * sx))
  const h = Math.min(canvas.height - y, Math.ceil((hRunPt + 8) * sy))
  if (w <= 2 || h <= 2) return null
  let data: Uint8ClampedArray
  try {
    data = canvas.getContext('2d')!.getImageData(x, y, w, h).data
  } catch {
    return null
  }
  const rs: number[] = []
  const gs: number[] = []
  const bs: number[] = []
  for (let i = 0; i < data.length; i += 16) {
    if (data[i + 3] > 200) {
      rs.push(data[i])
      gs.push(data[i + 1])
      bs.push(data[i + 2])
    }
  }
  return medianColor(rs, gs, bs)
}

/**
 * The background around a rectangle — sampled from a thin ring just OUTSIDE
 * it. Used for whiteout covers: the interior is the content being hidden, so
 * the surrounding band is what the patch must blend into.
 */
function sampleBandColor(
  canvas: HTMLCanvasElement,
  xf: number,
  yf: number,
  wf: number,
  hf: number,
): string | null {
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const pad = Math.max(4, Math.round(canvas.width * 0.006))
  const ix = Math.round(xf * canvas.width)
  const iy = Math.round(yf * canvas.height)
  const iw = Math.round(wf * canvas.width)
  const ih = Math.round(hf * canvas.height)
  const rs: number[] = []
  const gs: number[] = []
  const bs: number[] = []
  const collect = (x: number, y: number, w: number, h: number) => {
    x = Math.max(0, x)
    y = Math.max(0, y)
    w = Math.min(canvas.width - x, w)
    h = Math.min(canvas.height - y, h)
    if (w <= 0 || h <= 0) return
    let data: Uint8ClampedArray
    try {
      data = ctx.getImageData(x, y, w, h).data
    } catch {
      return
    }
    for (let i = 0; i < data.length; i += 8) {
      if (data[i + 3] > 200) {
        rs.push(data[i])
        gs.push(data[i + 1])
        bs.push(data[i + 2])
      }
    }
  }
  collect(ix - pad, iy - pad, iw + pad * 2, pad) // top strip
  collect(ix - pad, iy + ih, iw + pad * 2, pad) // bottom strip
  collect(ix - pad, iy, pad, ih) // left strip
  collect(ix + iw, iy, pad, ih) // right strip
  return medianColor(rs, gs, bs)
}

/** Dominant ink color of a region of the rendered page canvas, or null. */
function sampleInkColor(
  canvas: HTMLCanvasElement,
  xPt: number,
  yTopPt: number,
  wRunPt: number,
  hRunPt: number,
  pageWPt: number,
  pageHPt: number,
): string | null {
  const sx = canvas.width / pageWPt
  const sy = canvas.height / pageHPt
  const x = Math.max(0, Math.floor(xPt * sx))
  const y = Math.max(0, Math.floor(yTopPt * sy))
  const w = Math.min(canvas.width - x, Math.ceil(wRunPt * sx))
  const h = Math.min(canvas.height - y, Math.ceil(hRunPt * sy))
  if (w <= 2 || h <= 2) return null
  try {
    // same background-relative logic as the hi-res sampler
    return inkFromPixels(canvas.getContext('2d')!.getImageData(x, y, w, h).data)
  } catch {
    return null
  }
}

type Gesture =
  | { kind: 'draw' }
  | { kind: 'erase'; pushed: boolean }
  | { kind: 'move'; objId: string; startX: number; startY: number; orig: EditObj }
  | { kind: 'resize'; objId: string; startX: number; startY: number; orig: EditObj }
  | { kind: 'endpoint'; objId: string; which: 1 | 2 }

function bboxOf(o: EditObj, hPt: number): { x: number; y: number; w: number; h: number } {
  switch (o.kind) {
    case 'ink': {
      let x0 = 1, y0 = 1, x1 = 0, y1 = 0
      for (const [x, y] of o.points) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
      }
      return { x: x0, y: y0, w: Math.max(x1 - x0, 0.005), h: Math.max(y1 - y0, 0.005) }
    }
    case 'line':
    case 'arrow':
      return {
        x: Math.min(o.x1, o.x2),
        y: Math.min(o.y1, o.y2),
        w: Math.max(Math.abs(o.x2 - o.x1), 0.005),
        h: Math.max(Math.abs(o.y2 - o.y1), 0.005),
      }
    case 'text': {
      const lines = o.text ? o.text.split('\n').length : 1
      return { x: o.x, y: o.y, w: o.w, h: (lines * 1.3 * o.sizePt) / hPt }
    }
    default:
      return { x: o.x, y: o.y, w: o.w, h: o.h }
  }
}

function translated(o: EditObj, dx: number, dy: number): Partial<EditObj> {
  switch (o.kind) {
    case 'ink':
      return {
        points: o.points.map((p) => [p[0] + dx, p[1] + dy, p[2]] as [number, number, number]),
      }
    case 'line':
    case 'arrow':
      return { x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy }
    default:
      return { x: o.x + dx, y: o.y + dy }
  }
}

export default function EditStage() {
  const { t } = useTranslation()
  const docs = useApp((s) => s.docs)
  const selectedDocId = useApp((s) => s.selectedDocId)
  const doc = docs.find((d) => d.id === selectedDocId)

  const session = useEdit((s) => (doc ? s.sessions[doc.id] : undefined))
  const tool = useEdit((s) => s.tool)
  const style = useEdit((s) => s.style)
  const sampling = useEdit((s) => s.sampling)
  const openSession = useEdit((s) => s.openSession)
  const addObject = useEdit((s) => s.addObject)
  const updateObject = useEdit((s) => s.updateObject)
  const removeObject = useEdit((s) => s.removeObject)
  const select = useEdit((s) => s.select)
  const setEditing = useEdit((s) => s.setEditing)
  const pushHistory = useEdit((s) => s.pushHistory)
  const undo = useEdit((s) => s.undo)
  const redo = useEdit((s) => s.redo)
  const setDims = useEdit((s) => s.setDims)
  const setTool = useEdit((s) => s.setTool)

  const spaceRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const panRef = useRef<{ x: number; y: number; sl: number; st: number } | null>(null)
  /** last real scroll position — display:none (mobile tab switch) zeroes the
   *  live one silently, so it is restored when the stage reappears */
  const lastScrollRef = useRef({ l: 0, t: 0 })
  /** touchscreen two-finger pinch+pan (trackpads arrive as ctrl+wheel instead) */
  const touchesRef = useRef(new Map<number, { x: number; y: number }>())
  const pinchRef = useRef<{ d0: number; z0: number; c: { x: number; y: number } } | null>(null)
  const [zoom, setZoom] = useState(1) // committed zoom — crisp render
  const zoomRef = useRef(1)
  const zoomTargetRef = useRef(1)
  /** interim CSS scale during a gesture (target / committed) — 60fps feedback */
  const [pendingScale, setPendingScale] = useState(1)
  const pendingScaleRef = useRef(1)
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sizerRef = useRef<HTMLDivElement>(null)
  const sheetElRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<PageView | null>(null)
  const [space, setSpace] = useState({ w: 0, h: 0 })
  const [ocrBusy, setOcrBusy] = useState(false)
  const [ocrPct, setOcrPct] = useState(0)
  /** in-flight page-text builds — rapid retype clicks share one recognition */
  const ocrJobsRef = useRef(new Map<string, Promise<PageText>>())
  /** click generation — only the newest retype click opens a box */
  const retypeSeqRef = useRef(0)
  /** text/retype: a clean tap opens a box, a slide pans (see onOverlayPointer*) */
  const tapRef = useRef<{ xf: number; yf: number; x: number; y: number; moved: boolean } | null>(null)
  // on-box quick colour chip (phones only — desktop has the always-visible
  // panel); holds the text-object id whose mixer is open
  const narrow = useMediaQuery('(max-width: 760px)')
  const [colorMixerFor, setColorMixerFor] = useState<string | null>(null)
  const openedRef = useRef<{ key: string; opened: OpenedPdf } | null>(null)
  const [view, setView] = useState<PageView | null>(null)
  /** magnifier loupe while color-sampling: overlay CSS position + source device px */
  const [loupe, setLoupe] = useState<{ x: number; y: number; cx: number; cy: number; hex: string } | null>(null)
  const loupeCanvasRef = useRef<HTMLCanvasElement>(null)
  const [draft, _setDraft] = useState<EditObj | null>(null)
  // The ref is the source of truth during a gesture: pointer events can arrive
  // faster than React re-renders, so handlers must not read stale state.
  const draftRef = useRef<EditObj | null>(null)
  const setDraft = useCallback((o: EditObj | null) => {
    draftRef.current = o
    _setDraft(o)
  }, [])
  const gestureRef = useRef<Gesture | null>(null)
  const textCacheRef = useRef(new Map<string, PageText>())

  useEffect(() => {
    if (doc && doc.status !== 'error') openSession(doc)
  }, [doc, openSession])

  useEffect(() => {
    const el = spaceRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect
      setSpace({ w: Math.floor(r.width), h: Math.floor(r.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(
    () => () => {
      void openedRef.current?.opened.close()
      openedRef.current = null
    },
    [],
  )

  useEffect(() => {
    viewRef.current = view
  }, [view])

  const pageRef = session?.pages[session.pageIndex]
  const docKey = doc ? `${doc.id}:${doc.rev}` : ''

  // fit-zoom resets when switching documents
  useEffect(() => {
    zoomRef.current = 1
    zoomTargetRef.current = 1
    pendingScaleRef.current = 1
    setPendingScale(1)
    setZoom(1)
    lastScrollRef.current = { l: 0, t: 0 }
    pendingRestoreRef.current = null
  }, [docKey])

  // track the live scroll position natively; the browser can fire a stray
  // scroll-to-0 when the container regains its box, so restores use a
  // snapshot taken at the moment the stage reappears
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      if (el.offsetParent) lastScrollRef.current = { l: el.scrollLeft, t: el.scrollTop }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // coming back from another mobile tab: the stage was display:none, which
  // zeroed the scroll offsets while zoom survived — put the view back once
  // the page has re-rendered (scroll writes clamp to 0 on an empty container)
  const pendingRestoreRef = useRef<{ l: number; t: number } | null>(null)
  const prevSpaceW = useRef(0)
  useEffect(() => {
    const was = prevSpaceW.current
    prevSpaceW.current = space.w
    if (was > 0 && space.w === 0 && (lastScrollRef.current.l || lastScrollRef.current.t)) {
      // the stage just hid: snapshot NOW — on re-show the browser announces
      // the zeroed offsets with a scroll event before we could read them
      pendingRestoreRef.current = { ...lastScrollRef.current }
    }
  }, [space.w])
  useEffect(() => {
    const target = pendingRestoreRef.current
    if (!target || !view) return
    pendingRestoreRef.current = null
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) {
        el.scrollLeft = target.l
        el.scrollTop = target.t
      }
    })
  }, [view])

  // switching the OCR mode changes what a page's text set means
  const ocrOverride = useEdit((s) => s.ocrOverride)
  useEffect(() => {
    textCacheRef.current.clear()
    ocrJobsRef.current.clear()
  }, [ocrOverride])

  // Self-heal touch-gesture state. touchesRef is pruned by capture-phase
  // handlers on the scroll container, but a pointerup can be lost when the
  // overlay unmounts (a text box opening) or pointer capture retargets the
  // event — leaving a stale touch that reads as a phantom second finger
  // (every move zooms) and blocks the tools. Window listeners never miss the
  // release, whatever element it lands on.
  useEffect(() => {
    const release = (e: PointerEvent) => {
      touchesRef.current.delete(e.pointerId)
      if (touchesRef.current.size < 2) pinchRef.current = null
      if (touchesRef.current.size === 0) {
        panRef.current = null
        tapRef.current = null
      }
    }
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    window.addEventListener('lostpointercapture', release)
    return () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      window.removeEventListener('lostpointercapture', release)
    }
  }, [])

  // Changing tools is a deliberate toolbar tap with no finger drawing on the
  // canvas — reset any half-tracked gesture so a leftover can't corrupt it.
  useEffect(() => {
    touchesRef.current.clear()
    pinchRef.current = null
    panRef.current = null
    tapRef.current = null
    gestureRef.current = null
  }, [tool])

  // announce OCR mode changes in the hint slot — tooltips don't exist on
  // touch screens, so the toolbar toggle needs visible feedback
  const [ocrNotice, setOcrNotice] = useState<string | null>(null)
  const overrideSeenRef = useRef(false)
  useEffect(() => {
    if (!overrideSeenRef.current) {
      overrideSeenRef.current = true
      return
    }
    const key =
      ocrOverride === 'on' ? 'edit.ocr.on' : ocrOverride === 'off' ? 'edit.ocr.off' : 'edit.ocr.auto'
    setOcrNotice(key)
    const timer = setTimeout(() => setOcrNotice(null), 2600)
    return () => clearTimeout(timer)
  }, [ocrOverride])

  // pre-warm recognition the moment the retype tool is armed on this page,
  // so the first click doesn't pay the OCR wait; remember whether this page
  // ended up with OCR words so the retype hint can say so
  const [pageHasOcr, setPageHasOcr] = useState(false)
  useEffect(() => {
    setPageHasOcr(false)
    if (tool !== 'retype' || !view) return
    let stale = false
    const job = loadPageText()
    if (job) {
      job
        .then((pt) => {
          if (!stale) setPageHasOcr(pt.pieces.some((p) => p.ocr))
        })
        .catch(() => undefined)
    }
    return () => {
      stale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, view?.pageId, ocrOverride])

  // automation/debug hook (CDP regressions inspect scroll bookkeeping)
  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__editScrollDebug = () => ({
      last: { ...lastScrollRef.current },
      pending: pendingRestoreRef.current ? { ...pendingRestoreRef.current } : null,
      prevW: prevSpaceW.current,
      hasView: !!view,
      space: { ...space },
    })
    // gesture bookkeeping (CDP regressions assert the stuck-pinch self-heal)
    ;(window as unknown as Record<string, unknown>).__editGestureDebug = () => ({
      touches: touchesRef.current.size,
      pinch: !!pinchRef.current,
      pan: !!panRef.current,
      tap: !!tapRef.current,
    })
  })

  /**
   * Smooth zoom: scale instantly with CSS (anchored at the pointer), then
   * settle into a crisp re-render once the gesture pauses.
   */
  const zoomTo = useCallback((target: number, anchor?: { x: number; y: number }) => {
    target = clamp(target, 0.5, 4)
    const factor = target / zoomTargetRef.current
    if (Math.abs(factor - 1) < 0.001) return
    zoomTargetRef.current = target
    const scale = target / zoomRef.current
    pendingScaleRef.current = scale
    setPendingScale(scale)
    // imperative fast path: the sheet scales within this very event, without
    // waiting for a React render (which batches during rapid pinches)
    const v = viewRef.current
    if (v && sizerRef.current && sheetElRef.current) {
      sizerRef.current.style.width = `${v.W * scale}px`
      sizerRef.current.style.height = `${v.H * scale}px`
      sheetElRef.current.style.transform = scale !== 1 ? `scale(${scale})` : ''
    }

    const el = scrollRef.current
    if (el) {
      const rect = el.getBoundingClientRect()
      const ax = (anchor?.x ?? rect.left + rect.width / 2) - rect.left
      const ay = (anchor?.y ?? rect.top + rect.height / 2) - rect.top
      el.scrollLeft = (el.scrollLeft + ax) * factor - ax
      el.scrollTop = (el.scrollTop + ay) * factor - ay
    }

    if (settleTimerRef.current) clearTimeout(settleTimerRef.current)
    settleTimerRef.current = setTimeout(() => {
      zoomRef.current = zoomTargetRef.current
      setZoom(zoomTargetRef.current)
    }, 180)
  }, [])

  // Ctrl+wheel / trackpad pinch (Windows delivers pinches as fine-grained
  // ctrl+wheel events) — delta-proportional, anchored under the pointer
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return // plain two-finger scroll pans natively
      e.preventDefault()
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.06 : 0.0024))
      zoomTo(zoomTargetRef.current * factor, { x: e.clientX, y: e.clientY })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [view === null, zoomTo])

  // Render the current page (pdf page or blank sheet)
  useEffect(() => {
    let cancelled = false
    let retries = 0
    // a transient failure (worker busy, race with a closing document) must
    // not leave the stage blank until some unrelated state change
    const retry = () => {
      if (!cancelled && retries < 3) {
        retries++
        setTimeout(() => {
          if (!cancelled) void run()
        }, 400 * retries)
      }
    }
    async function run() {
      if (!doc || doc.status === 'error' || !session || !pageRef || space.w < 100 || space.h < 100) {
        setView(null)
        return
      }
      // phones fit by width only: the keyboard shrinking the stage height
      // must never rescale the page under an open text box
      const phone = space.w < 760
      const maxW = (space.w - (phone ? 20 : 40)) * zoom
      const maxH = phone ? Number.POSITIVE_INFINITY : (space.h - 128) * zoom
      if (pageRef.src.type === 'blank') {
        const { wPt, hPt } = pageRef.src
        const fit = Math.min(maxW / wPt, maxH / hPt)
        setView({ pageId: pageRef.id, W: Math.floor(wPt * fit), H: Math.floor(hPt * fit), wPt, hPt, canvas: null })
        pendingScaleRef.current = 1
        setPendingScale(1)
        return
      }
      if (openedRef.current?.key !== docKey) {
        const prev = openedRef.current
        openedRef.current = null
        if (prev) void prev.opened.close()
        textCacheRef.current.clear()
        ocrJobsRef.current.clear()
        let opened: OpenedPdf
        try {
          opened = await openPdf(doc.bytes)
        } catch {
          retry()
          return
        }
        if (cancelled) return void opened.close()
        openedRef.current = { key: docKey, opened }
      }
      const proxy = openedRef.current.opened.doc
      const index = Math.min(pageRef.src.index, proxy.numPages - 1)
      try {
        const page = await proxy.getPage(index + 1)
        const base = page.getViewport({ scale: 1 })
        // full device resolution within a fixed pixel budget — sharp zoom on
        // high-DPI phones, bounded memory on huge zoomed desktop pages
        const rendered = await renderPage(proxy, index, maxW, maxH, 3, 20_000_000)
        if (cancelled) return
        setDims(doc.id, pageRef.id, base.width, base.height)
        setView({
          pageId: pageRef.id,
          W: rendered.width,
          H: rendered.height,
          wPt: base.width,
          hPt: base.height,
          canvas: rendered.canvas,
        })
        // the crisp render replaces the interim CSS scale
        pendingScaleRef.current = 1
        setPendingScale(1)
      } catch {
        retry()
      }
    }
    // tiny debounce so rapid zoom steps collapse into one crisp render
    const timer = setTimeout(() => void run(), 50)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, doc?.status, pageRef?.id, space.w, space.h, zoom])

  // Keyboard: delete / undo / redo
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!doc || !session) return
      const typing = (e.target as HTMLElement).tagName === 'TEXTAREA' || (e.target as HTMLElement).tagName === 'INPUT'
      if (e.key === 'Escape' && useEdit.getState().sampling) {
        useEdit.getState().setSampling(false)
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && session.selectedId) {
        removeObject(doc.id, session.selectedId)
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault()
        if (e.shiftKey) redo(doc.id)
        else undo(doc.id)
      } else if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+') && !typing) {
        e.preventDefault()
        zoomTo(zoomTargetRef.current * 1.2)
      } else if ((e.ctrlKey || e.metaKey) && e.key === '-' && !typing) {
        e.preventDefault()
        zoomTo(zoomTargetRef.current / 1.2)
      } else if ((e.ctrlKey || e.metaKey) && e.key === '0' && !typing) {
        e.preventDefault()
        zoomTo(1)
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !typing) {
        e.preventDefault()
        redo(doc.id)
      } else if (
        !typing &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        TOOL_KEYS[e.key.toLowerCase()]
      ) {
        setTool(TOOL_KEYS[e.key.toLowerCase()])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [doc, session, removeObject, undo, redo, setTool])

  useEffect(() => {
    if (!sampling) setLoupe(null)
  }, [sampling])

  // paint the loupe (crisp device pixels, 8x magnification)
  useEffect(() => {
    const lc = loupeCanvasRef.current
    if (!lc || !loupe) return
    const ctx = lc.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, lc.width, lc.height)
    if (view?.canvas) {
      ctx.drawImage(view.canvas, loupe.cx - 7, loupe.cy - 7, 15, 15, 0, 0, lc.width, lc.height)
    }
  }, [loupe, view])

  function centerPixelHex(cx: number, cy: number): string {
    if (!view?.canvas) return '#ffffff'
    try {
      const x = Math.min(view.canvas.width - 1, Math.max(0, cx))
      const y = Math.min(view.canvas.height - 1, Math.max(0, cy))
      const d = view.canvas.getContext('2d')!.getImageData(x, y, 1, 1).data
      const to = (n: number) => n.toString(16).padStart(2, '0')
      return `#${to(d[0])}${to(d[1])}${to(d[2])}`
    } catch {
      return '#ffffff'
    }
  }

  function updateLoupe(e: React.PointerEvent) {
    if (!view) return
    const rect = overlayRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const cx = Math.round((x / rect.width) * (view.canvas?.width ?? view.W))
    const cy = Math.round((y / rect.height) * (view.canvas?.height ?? view.H))
    setLoupe({ x, y, cx, cy, hex: centerPixelHex(cx, cy) })
  }

  /**
   * Close a text box: drop it if empty, and drop an untouched retype pair so
   * unchanged originals are never replaced by substitutes. Idempotent.
   */
  function finishTextEdit(objId: string) {
    if (!doc) return
    const st = useEdit.getState()
    const s = st.sessions[doc.id]
    const o = s?.objects.find((x) => x.id === objId)
    if (o && o.kind === 'text') {
      const untouched =
        o.retypeOf &&
        o.text === o.retypeOf.originalText &&
        textStyleFingerprint(o) === o.retypeOf.baseline
      if (untouched) {
        // closed without changes: leave no trace
        st.removeObjectSilent(doc.id, o.id)
        st.removeObjectSilent(doc.id, o.retypeOf!.coverId)
      } else if (!o.text.trim()) {
        // emptied on purpose: for a retype, keep the cover — the user deleted
        // the original line; a plain text box just disappears
        st.removeObjectSilent(doc.id, o.id)
      }
    }
    if (s?.editingId === objId) setEditing(doc.id, null)
  }

  const toFrac = useCallback(
    (e: { clientX: number; clientY: number }): [number, number] => {
      const rect = overlayRef.current!.getBoundingClientRect()
      return [
        clamp((e.clientX - rect.left) / rect.width, 0, 1),
        clamp((e.clientY - rect.top) / rect.height, 0, 1),
      ]
    },
    [],
  )

  /**
   * Text pieces for the current page: the text layer plus, on pages that
   * look like scans (or with OCR forced on), recognized words merged in.
   * Single-flight per page — rapid clicks share one recognition — and
   * cached until the document or the OCR mode changes.
   */
  function loadPageText(): Promise<PageText> | null {
    if (!doc || !pageRef || pageRef.src.type !== 'orig' || !openedRef.current) return null
    const hit = textCacheRef.current.get(pageRef.id)
    if (hit) return Promise.resolve(hit)
    const key = `${docKey}:${pageRef.id}`
    const running = ocrJobsRef.current.get(key)
    if (running) return running
    const proxyDoc = openedRef.current.opened.doc
    const pageIndex = pageRef.src.index
    const pageId = pageRef.id
    const override = useEdit.getState().ocrOverride
    const job = (async (): Promise<PageText> => {
      const page = await proxyDoc.getPage(pageIndex + 1)
      const tc = await page.getTextContent()
      const pieces: TextPiece[] = []
      for (const item of tc.items) {
        if (!('str' in item) || !item.str.trim()) continue
        const tr = item.transform
        pieces.push({
          str: item.str,
          x: tr[4],
          y: tr[5],
          w: item.width,
          h: item.height || Math.hypot(tr[2], tr[3]),
          fontName: item.fontName,
        })
      }
      const families: Record<string, string | undefined> = {}
      for (const [k, v] of Object.entries(tc.styles ?? {})) {
        families[k] = (v as { fontFamily?: string }).fontFamily
      }
      let cached: PageText = { pieces: dedupeOverlappingPieces(pieces), families }
      const wantOcr = override === 'on' || (override !== 'off' && (await pageLooksScanned(page)))
      if (wantOcr) {
        setOcrBusy(true)
        setOcrProgress((p) => setOcrPct(p))
        try {
          const scan = await ocrPage(page)
          // real text (e.g. already-applied retypes) keeps its precise
          // text-layer geometry; OCR fills in the rest of the scan
          const fresh = scan.pieces.filter((o) => !cached.pieces.some((r) => piecesOverlap(o, r)))
          cached = { pieces: [...cached.pieces, ...fresh], families }
        } catch {
          /* OCR unavailable — the text layer alone */
        } finally {
          setOcrProgress(null)
          setOcrBusy(false)
          setOcrPct(0)
        }
      }
      textCacheRef.current.set(pageId, cached)
      return cached
    })()
    ocrJobsRef.current.set(key, job)
    void job.catch(() => undefined).then(() => ocrJobsRef.current.delete(key))
    return job
  }

  async function retypeAt(xf: number, yf: number) {
    if (!doc || !session || !pageRef || !view || pageRef.src.type !== 'orig' || !openedRef.current) return

    // Clicking an area that already has a session text object edits that
    // object — never stack a second cover+text pair on top of it.
    const existing = [...session.objects]
      .reverse()
      .find((o): o is TextObj => {
        if (o.kind !== 'text' || o.pageId !== pageRef.id) return false
        const bb = bboxOf(o, view.hPt)
        return xf >= bb.x - 0.005 && xf <= bb.x + bb.w + 0.005 && yf >= bb.y - 0.005 && yf <= bb.y + bb.h + 0.005
      })
    if (existing) {
      pushHistory(doc.id)
      select(doc.id, existing.id)
      setEditing(doc.id, existing.id)
      return
    }

    const proxyDoc = openedRef.current.opened.doc
    const pageIndex = pageRef.src.index
    const seq = ++retypeSeqRef.current
    const job = loadPageText()
    if (!job) return
    const cached = await job
    // rapid clicks while recognizing: only the newest one opens a box
    if (seq !== retypeSeqRef.current) return

    const { wPt, hPt } = view
    const xPt = xf * wPt
    const yPtFromBottom = (1 - yf) * hPt
    let best: TextPiece | null = null
    for (const p of cached.pieces) {
      const pad = 2
      if (
        xPt >= p.x - pad && xPt <= p.x + p.w + pad &&
        yPtFromBottom >= p.y - pad && yPtFromBottom <= p.y + p.h + pad &&
        (!best || p.w * p.h < best.w * best.h)
      ) {
        best = p
      }
    }
    if (!best) return

    // Join fragments on the same baseline into one visual run, so the whole
    // label is edited, not the fragment pdf.js happened to split at.
    const fs = best.h
    const sameLine = cached.pieces
      .filter((p) => Math.abs(p.y - best!.y) < fs * 0.35 && Math.abs(p.h - fs) < fs * 0.5)
      .sort((a, b) => a.x - b.x)
    const run: TextPiece[] = [best]
    const at = sameLine.indexOf(best)
    for (let i = at - 1; i >= 0; i--) {
      if (run[0].x - (sameLine[i].x + sameLine[i].w) < fs * 0.6) run.unshift(sameLine[i])
      else break
    }
    for (let i = at + 1; i < sameLine.length; i++) {
      if (sameLine[i].x - (run[run.length - 1].x + run[run.length - 1].w) < fs * 0.6) run.push(sameLine[i])
      else break
    }
    let text = ''
    for (let i = 0; i < run.length; i++) {
      if (i > 0) {
        const gap = run[i].x - (run[i - 1].x + run[i - 1].w)
        if (gap > fs * 0.13 && !text.endsWith(' ') && !run[i].str.startsWith(' ')) text += ' '
      }
      text += run[i].str
    }
    const runX = run[0].x
    const runW = run[run.length - 1].x + run[run.length - 1].w - runX

    // Match the original face: exact family from the embedded font name when
    // possible, otherwise the generic class pdf.js inferred.
    let pdfFontName: string | undefined
    try {
      const page = await proxyDoc.getPage(pageIndex + 1)
      pdfFontName = (page.commonObjs.get(best.fontName!) as { name?: string })?.name
    } catch {
      /* font not resolvable — generic fallback below */
    }
    const match = matchFontFromPdf(pdfFontName, best.fontName ? cached.families[best.fontName] : undefined)

    const sizePt = clamp(Math.round(fs * 2) / 2, 5, 120)
    const baselineTopFrac = 1 - best.y / hPt

    // The cover must not clip neighbouring lines in tightly-leaded text:
    // clamp its edges to the descender bottom of the line above and the
    // ascender top of the line below.
    const overlapsRun = (p: TextPiece) =>
      Math.min(p.x + p.w, runX + runW) - Math.max(p.x, runX) > Math.min(p.w, runW) * 0.3
    const lineAbove = cached.pieces
      .filter((p) => p.y > best!.y + fs * 0.5 && overlapsRun(p))
      .sort((a, b) => a.y - b.y)[0]
    const lineBelow = cached.pieces
      .filter((p) => p.y < best!.y - fs * 0.5 && overlapsRun(p))
      .sort((a, b) => b.y - a.y)[0]
    let coverTopY = best.y + fs * 0.98
    if (lineAbove) coverTopY = Math.min(coverTopY, lineAbove.y - lineAbove.h * 0.3 - 1)
    let coverBotY = best.y - fs * 0.34
    if (lineBelow) coverBotY = Math.max(coverBotY, lineBelow.y + lineBelow.h * 0.92 + 1)
    if (coverTopY - coverBotY < fs * 0.9) coverTopY = coverBotY + fs * 0.95

    // Keep the original ink color. Scans sample the on-screen canvas (the
    // raster IS the source; a hi-res region re-render of a big scan image is
    // slow on phones); text-layer runs use the hi-res render for accuracy.
    let sampled: string | null = null
    if (best.ocr) {
      if (view.canvas) {
        sampled = sampleInkColor(view.canvas, runX, hPt - best.y - fs * 0.85, runW, fs * 1.05, wPt, hPt)
      }
    } else {
      try {
        sampled = await sampleRunColorHiRes(await proxyDoc.getPage(pageIndex + 1), runX, best.y, runW, fs)
      } catch {
        sampled = null
      }
      if (!sampled && view.canvas) {
        sampled = sampleInkColor(view.canvas, runX, hPt - best.y - fs * 0.85, runW, fs * 1.05, wPt, hPt)
      }
      if (seq !== retypeSeqRef.current) return
    }

    // covers must match the paper behind the text — white pages sample as
    // white, but tinted table cells, scans and dark themes get their tone
    const paper = view.canvas
      ? samplePaperColor(view.canvas, runX, hPt - coverTopY, runW, coverTopY - coverBotY, wPt, hPt)
      : null

    pushHistory(doc.id)
    const cover = {
      id: uid(),
      pageId: pageRef.id,
      kind: 'whiteout' as const,
      x: clamp((runX - 1.5) / wPt, 0, 1),
      y: clamp(1 - coverTopY / hPt, 0, 1),
      w: clamp((runW + 4) / wPt, 0, 1),
      h: clamp((coverTopY - coverBotY) / hPt, 0, 1),
      fill: paper ?? style.whiteoutFill,
    }
    const coverId = cover.id
    const textObj: TextObj = {
      id: uid(),
      pageId: pageRef.id,
      kind: 'text',
      x: runX / wPt,
      y: clamp(baselineTopFrac - (TEXT_BASELINE * sizePt) / hPt, 0, 1),
      w: clamp(Math.max((runW + 80) / wPt, (runW / wPt) * 1.5), 0.05, 1 - runX / wPt - 0.02),
      text,
      fontId: match.fontId,
      sizePt,
      color: sampled ?? style.textColor,
      bold: match.bold,
      italic: match.italic,
      underline: false,
      strike: false,
      highlight: null,
      weightHint: match.weightHint,
    }
    textObj.retypeOf = {
      coverId,
      originalText: text,
      pdfFontName: match.pdfName,
      baseline: textStyleFingerprint(textObj),
    }
    addObject(doc.id, cover)
    addObject(doc.id, textObj)
    select(doc.id, textObj.id)
    setEditing(doc.id, textObj.id)
  }

  /** Object eraser: removes edit objects under the pointer. */
  function eraseAt(xf: number, yf: number) {
    if (!doc || !session || !view) return
    const g = gestureRef.current
    const padX = 6 / view.W
    const padY = 6 / view.H
    for (const o of session.objects) {
      if (o.pageId !== view.pageId) continue
      const bb = bboxOf(o, view.hPt)
      if (xf >= bb.x - padX && xf <= bb.x + bb.w + padX && yf >= bb.y - padY && yf <= bb.y + bb.h + padY) {
        if (g?.kind === 'erase' && !g.pushed) {
          pushHistory(doc.id)
          g.pushed = true
        }
        useEdit.getState().removeObjectSilent(doc.id, o.id)
      }
    }
  }

  function onOverlayPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return // middle button pans the scroll container
    if (pinchRef.current) return // two fingers are zooming, not drawing
    if (!doc || !session || !view || !pageRef) return
    if (sampling) {
      // color-picker "sample from document" mode: the loupe lets the user aim,
      // so pick exactly the pixel under the crosshair (like Chrome's picker).
      e.preventDefault()
      e.stopPropagation()
      const [sx, sy] = toFrac(e)
      const cx = Math.round(sx * (view.canvas?.width ?? view.W))
      const cy = Math.round(sy * (view.canvas?.height ?? view.H))
      const hex = centerPixelHex(cx, cy)
      useEdit.getState().setSampling(false)
      window.dispatchEvent(new CustomEvent('signer:color-sampled', { detail: hex }))
      return
    }
    if ((e.target as HTMLElement).closest('.eo-hit, .eo-handle, .eo-textarea')) return
    const [xf, yf] = toFrac(e)
    try { overlayRef.current!.setPointerCapture(e.pointerId) } catch { /* synthetic or stale pointer */ }

    if (tool === 'select') {
      if (session.editingId) finishTextEdit(session.editingId)
      select(doc.id, null)
      setEditing(doc.id, null)
      // any pointer on empty paper pans the canvas (Figma-style); the scroll
      // container's pointermove handler does the actual scrolling
      const el = scrollRef.current
      if (el) panRef.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop }
      return
    }
    if (tool === 'retype' || tool === 'text') {
      // The browser's default mousedown action would move focus away from the
      // text box we are about to create (and blur-delete it) — suppress it.
      e.preventDefault()
      if (session.editingId) {
        // touching outside an open text box commits it first
        finishTextEdit(session.editingId)
        return
      }
      // A clean tap opens the box; a slide pans the page instead. Placement is
      // deferred to pointerup (onOverlayPointerUp) so you can navigate a
      // zoomed document with a text tool active without dropping a box.
      const el = scrollRef.current
      if (el) panRef.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop }
      tapRef.current = { xf, yf, x: e.clientX, y: e.clientY, moved: false }
      return
    }
    if (tool === 'erase') {
      gestureRef.current = { kind: 'erase', pushed: false }
      eraseAt(xf, yf)
      return
    }

    pushHistory(doc.id)
    gestureRef.current = { kind: 'draw' }
    if (tool === 'pen') {
      const profile = PEN_PROFILES[style.pen]
      setDraft({
        id: uid(),
        pageId: pageRef.id,
        kind: 'ink',
        points: [[xf, yf, e.pressure || 0.5]],
        color: style.stroke,
        widthPt: style.strokeWidthPt * profile.widthScale,
        simulatePressure: e.pointerType !== 'pen',
        pen: style.pen,
        opacity: profile.opacity,
      })
    } else if (tool === 'rect' || tool === 'ellipse') {
      setDraft({
        id: uid(), pageId: pageRef.id, kind: tool,
        x: xf, y: yf, w: 0, h: 0,
        stroke: style.stroke, strokeWidthPt: style.strokeWidthPt,
        fill: style.fill, opacity: style.opacity, dash: style.dash,
      })
    } else if (tool === 'line' || tool === 'arrow') {
      setDraft({
        id: uid(), pageId: pageRef.id, kind: tool,
        x1: xf, y1: yf, x2: xf, y2: yf,
        stroke: style.stroke, strokeWidthPt: style.strokeWidthPt, opacity: style.opacity,
        dash: style.dash,
      })
    } else if (tool === 'whiteout') {
      setDraft({
        id: uid(), pageId: pageRef.id, kind: 'whiteout',
        x: xf, y: yf, w: 0, h: 0, fill: style.whiteoutFill,
      })
    }
  }

  function onOverlayPointerMove(e: React.PointerEvent) {
    if (!doc || !view) return
    if (sampling) {
      updateLoupe(e)
      return
    }
    // text/retype: past the movement threshold this is a pan, not a tap — the
    // scroll container's pan handler does the scrolling; we just record it so
    // pointerup won't drop a box
    const tap = tapRef.current
    if (tap) {
      if (!tap.moved && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 8) tap.moved = true
      return
    }
    const g = gestureRef.current
    const [xf, yf] = toFrac(e)
    // mid-pinch the sheet is CSS-scaled: pointer deltas arrive in scaled space
    const ps = pendingScaleRef.current

    if (g?.kind === 'move') {
      const dx = (e.clientX - g.startX) / ps / view.W
      const dy = (e.clientY - g.startY) / ps / view.H
      updateObject(doc.id, g.objId, translated(g.orig, dx, dy))
      return
    }
    if (g?.kind === 'resize') {
      const o = g.orig
      const dx = (e.clientX - g.startX) / ps / view.W
      const dy = (e.clientY - g.startY) / ps / view.H
      if (o.kind === 'rect' || o.kind === 'ellipse' || o.kind === 'whiteout') {
        updateObject(doc.id, g.objId, {
          w: clamp(o.w + dx, 0.01, 1 - o.x),
          h: clamp(o.h + dy, 0.01, 1 - o.y),
        })
      } else if (o.kind === 'text') {
        updateObject(doc.id, g.objId, { w: clamp(o.w + dx, 0.05, 1 - o.x) })
      } else if (o.kind === 'ink') {
        const bb = bboxOf(o, view.hPt)
        const sx = clamp((bb.w + dx) / bb.w, 0.15, 8)
        const sy = clamp((bb.h + dy) / bb.h, 0.15, 8)
        updateObject(doc.id, g.objId, {
          points: o.points.map(
            (p) => [bb.x + (p[0] - bb.x) * sx, bb.y + (p[1] - bb.y) * sy, p[2]] as [number, number, number],
          ),
        })
      }
      return
    }
    if (g?.kind === 'endpoint') {
      updateObject(doc.id, g.objId, g.which === 1 ? { x1: xf, y1: yf } : { x2: xf, y2: yf })
      return
    }
    if (g?.kind === 'erase') {
      eraseAt(xf, yf)
      return
    }
    const draft = draftRef.current
    if (g?.kind === 'draw' && draft) {
      if (draft.kind === 'ink') {
        setDraft({ ...draft, points: [...draft.points, [xf, yf, e.pressure || 0.5]] })
      } else if (draft.kind === 'rect' || draft.kind === 'ellipse' || draft.kind === 'whiteout') {
        setDraft({
          ...draft,
          x: Math.min(draft.x, xf) === draft.x ? draft.x : xf,
          ...(xf >= draft.x ? { w: xf - draft.x } : { x: xf, w: draft.x + draft.w - xf }),
          ...(yf >= draft.y ? { h: yf - draft.y } : { y: yf, h: draft.y + draft.h - yf }),
        } as EditObj)
      } else if (draft.kind === 'line' || draft.kind === 'arrow') {
        setDraft({ ...draft, x2: xf, y2: yf })
      }
    }
  }

  function onOverlayPointerUp() {
    // text/retype: resolve the deferred tap. A clean tap opens the box at the
    // touch-down point; a slide was a pan (handled by the scroll container).
    const tap = tapRef.current
    if (tap) {
      tapRef.current = null
      panRef.current = null
      if (!tap.moved && doc && session && pageRef && view) {
        if (tool === 'retype') {
          void retypeAt(tap.xf, tap.yf)
        } else if (tool === 'text') {
          pushHistory(doc.id)
          const obj: TextObj = {
            id: uid(),
            pageId: pageRef.id,
            kind: 'text',
            x: tap.xf,
            y: tap.yf,
            w: clamp(0.32, 0.05, 1 - tap.xf),
            text: '',
            fontId: style.fontId,
            sizePt: style.fontSizePt,
            color: style.textColor,
            bold: style.bold,
            italic: style.italic,
            underline: style.underline,
            strike: style.strike,
            highlight: style.highlight,
          }
          addObject(doc.id, obj)
          select(doc.id, obj.id)
          setEditing(doc.id, obj.id)
        }
      }
      return
    }
    const g = gestureRef.current
    gestureRef.current = null
    if (!doc) return
    const draft = draftRef.current
    if (g?.kind === 'draw' && draft) {
      const big =
        (draft.kind === 'ink' && draft.points.length > 1) ||
        ((draft.kind === 'rect' || draft.kind === 'ellipse' || draft.kind === 'whiteout') &&
          draft.w > 0.004 && draft.h > 0.004) ||
        ((draft.kind === 'line' || draft.kind === 'arrow') &&
          Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1) > 0.005)
      if (big) {
        let obj = draft
        if (draft.kind === 'whiteout' && view?.canvas) {
          // blend into the page: the interior is the content being hidden,
          // so sample the surrounding band (the drawn cover stays selected —
          // its colour can be changed in the panel)
          const band = sampleBandColor(view.canvas, draft.x, draft.y, draft.w, draft.h)
          if (band) obj = { ...draft, fill: band }
        }
        addObject(doc.id, obj)
        select(doc.id, obj.id)
      }
      setDraft(null)
    }
  }

  function beginMove(e: React.PointerEvent, o: EditObj) {
    if (tool !== 'select' || !doc) return
    e.stopPropagation()
    try { overlayRef.current!.setPointerCapture(e.pointerId) } catch { /* synthetic or stale pointer */ }
    pushHistory(doc.id)
    select(doc.id, o.id)
    setEditing(doc.id, null)
    gestureRef.current = { kind: 'move', objId: o.id, startX: e.clientX, startY: e.clientY, orig: o }
  }

  function beginResize(e: React.PointerEvent, o: EditObj) {
    if (!doc) return
    e.stopPropagation()
    try { overlayRef.current!.setPointerCapture(e.pointerId) } catch { /* synthetic or stale pointer */ }
    pushHistory(doc.id)
    gestureRef.current = { kind: 'resize', objId: o.id, startX: e.clientX, startY: e.clientY, orig: o }
  }

  function beginEndpoint(e: React.PointerEvent, o: LineObj, which: 1 | 2) {
    if (!doc) return
    e.stopPropagation()
    try { overlayRef.current!.setPointerCapture(e.pointerId) } catch { /* synthetic or stale pointer */ }
    pushHistory(doc.id)
    gestureRef.current = { kind: 'endpoint', objId: o.id, which }
  }

  // ---------------------------------------------------------------- render

  if (!doc || doc.status === 'error') {
    return (
      <section className="stage edit-stage" ref={spaceRef}>
        <div className="stage-empty">
          <p>{doc ? doc.error : t('edit.noDoc')}</p>
        </div>
      </section>
    )
  }

  const objects = session && view ? session.objects.filter((o) => o.pageId === view.pageId) : []
  const all = draft && view && draft.pageId === view.pageId ? [...objects, draft] : objects
  const scale = view ? view.W / view.wPt : 1
  const selected = session?.selectedId
    ? session.objects.find((o) => o.id === session.selectedId) ?? null
    : null

  function renderObj(o: EditObj) {
    if (!view) return null
    const px = (f: number) => f * view.W
    const py = (f: number) => f * view.H
    const sw = (pt: number) => pt * scale
    const hit = tool === 'select' ? { className: 'eo-hit', onPointerDown: (e: React.PointerEvent) => beginMove(e, o), style: { cursor: 'move' } } : {}
    switch (o.kind) {
      case 'whiteout':
        return (
          <g key={o.id} {...hit}>
            <rect x={px(o.x)} y={py(o.y)} width={px(o.w)} height={py(o.h)} fill={o.fill} />
            <rect x={px(o.x)} y={py(o.y)} width={px(o.w)} height={py(o.h)} fill="none" stroke="#c9cfdd" strokeDasharray="4 3" strokeWidth={1} />
          </g>
        )
      case 'rect':
        return (
          <rect key={o.id} {...hit} x={px(o.x)} y={py(o.y)} width={px(o.w)} height={py(o.h)}
            fill={o.fill ?? 'none'} fillOpacity={o.opacity} stroke={o.stroke} strokeOpacity={o.opacity} strokeWidth={sw(o.strokeWidthPt)}
            strokeDasharray={dashPattern(o.dash, sw(o.strokeWidthPt))?.join(' ')}
            strokeLinecap={o.dash === 'dotted' ? 'round' : undefined} />
        )
      case 'ellipse':
        return (
          <ellipse key={o.id} {...hit} cx={px(o.x + o.w / 2)} cy={py(o.y + o.h / 2)} rx={px(o.w / 2)} ry={py(o.h / 2)}
            fill={o.fill ?? 'none'} fillOpacity={o.opacity} stroke={o.stroke} strokeOpacity={o.opacity} strokeWidth={sw(o.strokeWidthPt)}
            strokeDasharray={dashPattern(o.dash, sw(o.strokeWidthPt))?.join(' ')}
            strokeLinecap={o.dash === 'dotted' ? 'round' : undefined} />
        )
      case 'line':
      case 'arrow': {
        const x1 = px(o.x1), y1 = py(o.y1), x2 = px(o.x2), y2 = py(o.y2)
        const head = Math.max(sw(o.strokeWidthPt) * 4, sw(10))
        const ang = Math.atan2(y1 - y2, x1 - x2)
        const dash = dashPattern(o.dash, sw(o.strokeWidthPt))?.join(' ')
        return (
          <g key={o.id} {...hit} stroke={o.stroke} strokeOpacity={o.opacity} strokeWidth={sw(o.strokeWidthPt)} strokeLinecap="round">
            {/* fat invisible line to make thin lines selectable */}
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={12} />
            <line x1={x1} y1={y1} x2={x2} y2={y2} strokeDasharray={dash} />
            {o.kind === 'arrow' && (
              <>
                <line x1={x2} y1={y2} x2={x2 + head * Math.cos(ang - 0.45)} y2={y2 + head * Math.sin(ang - 0.45)} />
                <line x1={x2} y1={y2} x2={x2 + head * Math.cos(ang + 0.45)} y2={y2 + head * Math.sin(ang + 0.45)} />
              </>
            )}
          </g>
        )
      }
      case 'ink': {
        const pts = o.points.map((p) => [px(p[0]), py(p[1]), p[2]] as [number, number, number])
        return (
          <path
            key={o.id}
            {...hit}
            d={inkToSvgPath(pts, sw(o.widthPt), o.simulatePressure, o.pen)}
            fill={o.color}
            opacity={o.opacity}
          />
        )
      }
      default:
        return null
    }
  }

  return (
    <section className="stage edit-stage" ref={spaceRef}>
      <EditToolbar />
      {/* with the keyboard open the stage is a thin strip — the floating
          hint and zoom pill would bury the document, so they step aside */}
      {space.h >= 240 &&
        (ocrNotice ? (
          <div className="stage-hint hint-info">{t(ocrNotice)}</div>
        ) : (
          tool === 'retype' &&
          !ocrBusy && (
            <div className="stage-hint hint-info">
              {t(pageHasOcr ? 'edit.retypeHintOcr' : 'edit.retypeHint')}
            </div>
          )
        ))}
      {ocrBusy && (
        <div className="ocr-veil" role="status">
          <div className="ocr-card">
            <span className="ocr-spinner" aria-hidden="true" />
            <span>
              {t('edit.ocrReading')}
              {ocrPct > 0 ? ` ${Math.round(ocrPct * 100)}%` : ''}
            </span>
          </div>
        </div>
      )}

      {space.h >= 240 && (
        <div className="zoom-pill">
          <button title={t('edit.zoomOut')} onClick={() => zoomTo(zoomTargetRef.current / 1.2)}>
            −
          </button>
          <button className="zoom-value" title={t('edit.zoomReset')} onClick={() => zoomTo(1)}>
            {Math.round(zoom * pendingScale * 100)}%
          </button>
          <button title={t('edit.zoomIn')} onClick={() => zoomTo(zoomTargetRef.current * 1.2)}>
            +
          </button>
        </div>
      )}

      <div
        className="edit-scroll"
        ref={scrollRef}
        onPointerDownCapture={(e) => {
          if (e.pointerType !== 'touch') return
          touchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
          if (touchesRef.current.size === 2) {
            // second finger: abort any tool gesture, start pinch+pan
            gestureRef.current = null
            panRef.current = null
            tapRef.current = null
            setDraft(null)
            const [a, b] = [...touchesRef.current.values()]
            pinchRef.current = {
              d0: Math.max(Math.hypot(a.x - b.x, a.y - b.y), 20),
              z0: zoomTargetRef.current,
              c: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
            }
          }
        }}
        onPointerMoveCapture={(e) => {
          if (e.pointerType !== 'touch' || !touchesRef.current.has(e.pointerId)) return
          touchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
          if (pinchRef.current && touchesRef.current.size >= 2) {
            e.stopPropagation()
            const [a, b] = [...touchesRef.current.values()]
            const d = Math.max(Math.hypot(a.x - b.x, a.y - b.y), 20)
            const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
            // spread = zoom about the centroid; centroid travel = pan
            zoomTo(pinchRef.current.z0 * (d / pinchRef.current.d0), c)
            const el = scrollRef.current
            if (el) {
              el.scrollLeft -= c.x - pinchRef.current.c.x
              el.scrollTop -= c.y - pinchRef.current.c.y
            }
            pinchRef.current.c = c
          }
        }}
        onPointerUpCapture={(e) => {
          touchesRef.current.delete(e.pointerId)
          if (touchesRef.current.size < 2) pinchRef.current = null
        }}
        onPointerCancelCapture={(e) => {
          touchesRef.current.delete(e.pointerId)
          if (touchesRef.current.size < 2) pinchRef.current = null
        }}
        onPointerDown={(e) => {
          if (e.button !== 1) return
          e.preventDefault()
          const el = scrollRef.current!
          panRef.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop }
          try {
            el.setPointerCapture(e.pointerId)
          } catch {
            /* synthetic pointer */
          }
        }}
        onPointerMove={(e) => {
          const p = panRef.current
          if (!p) return
          const el = scrollRef.current!
          el.scrollLeft = p.sl - (e.clientX - p.x)
          el.scrollTop = p.st - (e.clientY - p.y)
        }}
        onPointerUp={() => (panRef.current = null)}
      >
        {view && (
          <div
            className="zoom-sizer"
            ref={sizerRef}
            style={{ width: view.W * pendingScale, height: view.H * pendingScale }}
          >
          <div
            className="sheet edit-sheet"
            ref={sheetElRef}
            style={{
              width: view.W,
              height: view.H,
              transform: pendingScale !== 1 ? `scale(${pendingScale})` : undefined,
            }}
          >
          <div
            className={view.canvas ? 'canvas-holder' : 'canvas-holder blank-page'}
            ref={(el) => {
              // one holder, managed imperatively: React must never be left
              // reusing a node that still contains a stale injected canvas
              if (el) {
                if (view.canvas) el.replaceChildren(view.canvas)
                else el.replaceChildren()
              }
            }}
          />
          <div
            ref={overlayRef}
            className={`edit-overlay tool-${tool}${sampling ? ' sampling' : ''}`}
            onPointerDown={onOverlayPointerDown}
            onPointerMove={onOverlayPointerMove}
            onPointerUp={onOverlayPointerUp}
          >
            <svg width={view.W} height={view.H} className="edit-svg">
              {session?.watermark && (
                <WatermarkPreview wm={session.watermark} W={view.W} H={view.H} scale={scale} />
              )}
              {all.filter((o) => o.kind !== 'text').map(renderObj)}
            </svg>

            {all.filter((o): o is TextObj => o.kind === 'text').map((o) => {
              const textStyle: React.CSSProperties = {
                left: o.x * view.W,
                top: o.y * view.H,
                width: o.w * view.W,
                fontSize: o.sizePt * scale,
                fontFamily: fontById(o.fontId).css,
                fontWeight: o.weightHint ?? (o.bold ? 700 : 400),
                fontStyle: o.italic ? 'italic' : undefined,
                textDecoration:
                  [o.underline ? 'underline' : '', o.strike ? 'line-through' : '']
                    .filter(Boolean)
                    .join(' ') || undefined,
                lineHeight: TEXT_LINE_HEIGHT,
                color: o.color,
              }
              return session?.editingId === o.id ? (
                <textarea
                  key={o.id}
                  className="eo-textarea"
                  autoFocus
                  value={o.text}
                  placeholder={t('edit.textPlaceholder')}
                  style={{ ...textStyle, background: o.highlight ?? 'rgba(47, 69, 196, 0.04)' }}
                  rows={o.text.split('\n').length}
                  onFocus={(e) => {
                    const el = e.target
                    el.setSelectionRange(el.value.length, el.value.length)
                  }}
                  onChange={(e) => updateObject(doc.id, o.id, { text: e.target.value })}
                  onBlur={(e) => {
                    // Moving focus into the properties panel, the color mixer,
                    // or the on-box colour chip means the user is styling this
                    // box — keep it open.
                    const to = e.relatedTarget as HTMLElement | null
                    if (
                      to &&
                      (to.closest('.right-panel') ||
                        to.closest('.color-popover') ||
                        to.closest('.eo-colorchip'))
                    )
                      return
                    finishTextEdit(o.id)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur()
                  }}
                />
              ) : (
                <div
                  key={o.id}
                  className="eo-hit eo-text"
                  style={{ ...textStyle, cursor: tool === 'select' ? 'move' : undefined }}
                  onPointerDown={(e) => {
                    if (tool === 'retype' || tool === 'text') {
                      // edit the existing box rather than layering a new one
                      e.preventDefault()
                      e.stopPropagation()
                      pushHistory(doc.id)
                      select(doc.id, o.id)
                      setEditing(doc.id, o.id)
                      return
                    }
                    beginMove(e, o)
                  }}
                  onDoubleClick={() => {
                    if (!doc) return
                    pushHistory(doc.id)
                    select(doc.id, o.id)
                    setEditing(doc.id, o.id)
                  }}
                >
                  {o.highlight ? (
                    <span style={{ background: o.highlight, boxDecorationBreak: 'clone' }}>
                      {o.text || ' '}
                    </span>
                  ) : (
                    o.text || ' '
                  )}
                </div>
              )
            })}

            {/* phone-only quick colour chip on the active text box — desktop
                uses the always-visible properties panel. Applies to the whole
                box (both while typing and when selected). */}
            {narrow &&
              all
                .filter(
                  (o): o is TextObj =>
                    o.kind === 'text' &&
                    (session?.editingId === o.id || session?.selectedId === o.id),
                )
                .map((o) => (
                  <div
                    key={`chip-${o.id}`}
                    className="eo-colorchip"
                    style={{
                      left: Math.min((o.x + o.w) * view.W - 28, view.W - 30),
                      top: Math.max(2, o.y * view.H - 34),
                    }}
                  >
                    <button
                      className="eo-colorchip-btn"
                      style={{ background: o.color }}
                      title={t('edit.textColor')}
                      aria-label={t('edit.textColor')}
                      // pointerdown, not click: fire before the textarea blurs
                      onPointerDown={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        if (colorMixerFor !== o.id) pushHistory(doc.id)
                        setColorMixerFor(colorMixerFor === o.id ? null : o.id)
                      }}
                    />
                    {colorMixerFor === o.id && (
                      <ColorPopover
                        value={/^#[0-9a-f]{6}$/i.test(o.color) ? o.color : '#1c1c1e'}
                        onChange={(v) => updateObject(doc.id, o.id, { color: v })}
                        onClose={() => setColorMixerFor(null)}
                      />
                    )}
                  </div>
                ))}

            {selected && view && selected.pageId === view.pageId && !session?.editingId && (
              <SelectionUi
                obj={selected}
                view={view}
                onResize={beginResize}
                onEndpoint={beginEndpoint}
              />
            )}

            {sampling && loupe && (
              <div
                className="loupe"
                style={{
                  left: loupe.x + 148 > view.W ? loupe.x - 140 : loupe.x + 18,
                  top: loupe.y + 170 > view.H ? loupe.y - 160 : loupe.y + 18,
                }}
              >
                <div className="loupe-ring">
                  <canvas ref={loupeCanvasRef} width={120} height={120} />
                  <span className="loupe-center" />
                </div>
                <span className="loupe-hex">{loupe.hex}</span>
              </div>
            )}
          </div>
        </div>
        </div>
        )}
      </div>

      {session && space.h >= 240 && <PagesStrip session={session} />}
    </section>
  )
}

function SelectionUi({
  obj,
  view,
  onResize,
  onEndpoint,
}: {
  obj: EditObj
  view: PageView
  onResize: (e: React.PointerEvent, o: EditObj) => void
  onEndpoint: (e: React.PointerEvent, o: LineObj, which: 1 | 2) => void
}) {
  if (obj.kind === 'line' || obj.kind === 'arrow') {
    return (
      <>
        <span className="eo-handle" style={{ left: obj.x1 * view.W - 6, top: obj.y1 * view.H - 6 }} onPointerDown={(e) => onEndpoint(e, obj, 1)} />
        <span className="eo-handle" style={{ left: obj.x2 * view.W - 6, top: obj.y2 * view.H - 6 }} onPointerDown={(e) => onEndpoint(e, obj, 2)} />
      </>
    )
  }
  const bb = bboxOf(obj, view.hPt)
  return (
    <>
      <div
        className="eo-selection"
        style={{ left: bb.x * view.W - 3, top: bb.y * view.H - 3, width: bb.w * view.W + 6, height: bb.h * view.H + 6 }}
      />
      <span
        className="eo-handle"
        style={{ left: (bb.x + bb.w) * view.W - 5, top: (bb.y + bb.h) * view.H - 5, cursor: 'nwse-resize' }}
        onPointerDown={(e) => onResize(e, obj)}
      />
    </>
  )
}

function WatermarkPreview({
  wm,
  W,
  H,
  scale,
}: {
  wm: Watermark
  W: number
  H: number
  scale: number
}) {
  const isImage = wm.kind === 'image' && wm.image
  const size = wm.sizePt * scale
  const itemW = isImage ? wm.scale * W : Math.max(wm.text.length * size * 0.55, 60)
  const itemH = isImage ? itemW * (wm.image!.h / wm.image!.w) : size * 1.2

  const positions: [number, number][] = []
  if (wm.tile) {
    const stepX = Math.max(itemW * 1.6, 160 * scale)
    const stepY = Math.max(itemH * 3.2, 140 * scale)
    for (let y = stepY / 2; y < H; y += stepY) {
      for (let x = stepX / 2; x < W; x += stepX) positions.push([x, y])
    }
  } else {
    positions.push([W / 2, H / 2])
  }

  if (isImage) {
    return (
      <g opacity={wm.opacity}>
        {positions.map(([x, y], i) => (
          <image
            key={i}
            href={wm.image!.dataUrl}
            x={x - itemW / 2}
            y={y - itemH / 2}
            width={itemW}
            height={itemH}
            transform={`rotate(${-wm.angleDeg} ${x} ${y})`}
          />
        ))}
      </g>
    )
  }
  return (
    <g opacity={wm.opacity} fill={wm.color} fontSize={size} fontFamily="Arial, Helvetica, sans-serif">
      {positions.map(([x, y], i) => (
        <text key={i} x={x} y={y} textAnchor="middle" dominantBaseline="middle" transform={`rotate(${-wm.angleDeg} ${x} ${y})`}>
          {wm.text}
        </text>
      ))}
    </g>
  )
}
