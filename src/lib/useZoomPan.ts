import { useCallback, useEffect, useRef, useState } from 'react'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** One-finger / middle-button pan: pointer origin + scroll offsets at start. */
export interface PanState {
  x: number
  y: number
  sl: number
  st: number
}

/** Deferred tap (text/retype/stamp placement): a clean tap acts, a slide pans. */
export interface TapState {
  xf: number
  yf: number
  x: number
  y: number
  moved: boolean
}

export interface ZoomPanOptions {
  /** committed sheet CSS size — the imperative fast path resizes the sizer */
  getSheetSize: () => { W: number; H: number } | null
  /** stage width from the ResizeObserver; a drop to 0 means display:none */
  spaceW: number
  /** the rendered view (or null) — identity changes when a fresh render lands */
  view: unknown
  /**
   * Continuity key, normally the document id. The zoom level and the content
   * point at the viewport center are remembered per key in a module-level
   * store shared by ALL stages — switching Read → Sign → Edit (each its own
   * hook instance) or hopping between documents resumes exactly where that
   * document was left. Omit to opt out.
   */
  memoryKey?: string
  minZoom?: number
  maxZoom?: number
  /** a second finger landed — abort any in-progress tool gesture */
  onPinchStart?: () => void
}

/** zoom + viewport-center content point, remembered per document across the
 *  Read/Sign/Edit stages (content fractions survive differing fit sizes) */
const viewMemory = new Map<string, { zoom: number; fx: number; fy: number }>()

/**
 * The canvas zoom/pan/pinch machinery shared by the Edit, Sign and Read
 * stages. Extracted verbatim from EditStage, where it was battle-hardened:
 *
 * - committed zoom (crisp re-render) + interim CSS scale during a gesture,
 *   with an imperative sizer/sheet fast path that beats React's batching
 * - touchscreen pinch (spread = zoom about the centroid, travel = pan);
 *   trackpads arrive as ctrl+wheel instead and are handled likewise
 * - one-finger / middle-button panning via a scroll container
 * - tap-vs-slide tracking so tools can defer placement to pointerup
 * - window-level pointer-release self-healing (a lost pointerup would leave
 *   a phantom finger that turns every move into a zoom)
 * - scroll preserve/restore across display:none (mobile tab switches zero
 *   the offsets of a hidden scroll container silently)
 *
 * The consuming stage owns its tools; the refs (panRef/tapRef/pinchRef) are
 * exposed so tool handlers can integrate exactly like EditStage always did.
 */
export function useZoomPan(opts: ZoomPanOptions) {
  const { spaceW, view, memoryKey } = opts
  const minZoom = opts.minZoom ?? 0.5
  const maxZoom = opts.maxZoom ?? 4
  // options read inside stable callbacks/effects go through refs
  const getSheetSizeRef = useRef(opts.getSheetSize)
  getSheetSizeRef.current = opts.getSheetSize
  const onPinchStartRef = useRef(opts.onPinchStart)
  onPinchStartRef.current = opts.onPinchStart

  const scrollRef = useRef<HTMLDivElement>(null)
  const sizerRef = useRef<HTMLDivElement>(null)
  const sheetElRef = useRef<HTMLDivElement>(null)
  const panRef = useRef<PanState | null>(null)
  /** last real scroll position — display:none (mobile tab switch) zeroes the
   *  live one silently, so it is restored when the stage reappears */
  const lastScrollRef = useRef({ l: 0, t: 0 })
  /** touchscreen two-finger pinch+pan (trackpads arrive as ctrl+wheel instead) */
  const touchesRef = useRef(new Map<number, { x: number; y: number }>())
  const pinchRef = useRef<{ d0: number; z0: number; c: { x: number; y: number } } | null>(null)
  // committed zoom — crisp render. A remembered document resumes its zoom.
  const [zoom, setZoom] = useState(() => (memoryKey && viewMemory.get(memoryKey)?.zoom) || 1)
  const zoomRef = useRef(zoom)
  const zoomTargetRef = useRef(zoom)
  /** interim CSS scale during a gesture (target / committed) — 60fps feedback */
  const [pendingScale, setPendingScale] = useState(1)
  const pendingScaleRef = useRef(1)
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** text/retype/stamp: a clean tap acts, a slide pans */
  const tapRef = useRef<TapState | null>(null)

  /** live content point under the viewport center — kept fresh on every
   *  scroll because unmount cleanups run AFTER React nulls the DOM refs, so
   *  the view memory cannot measure anything when the stage is leaving */
  const lastCenterRef = useRef<{ fx: number; fy: number } | null>(null)

  // Track the live scroll position natively; the browser can fire a stray
  // scroll-to-0 when the container regains its box, so restores use a
  // snapshot taken at the moment the stage reappears. The listener rides a
  // CALLBACK ref: a mount-time effect would miss the container entirely when
  // the stage first renders its empty state (no document yet) and the
  // element only appears later.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el || !el.offsetParent) return
    lastScrollRef.current = { l: el.scrollLeft, t: el.scrollTop }
    const sheet = sheetElRef.current
    if (sheet) {
      const er = el.getBoundingClientRect()
      const sr = sheet.getBoundingClientRect()
      if (er.width > 1 && sr.width > 1 && sr.height > 1) {
        lastCenterRef.current = {
          fx: (er.left + er.width / 2 - sr.left) / sr.width,
          fy: (er.top + er.height / 2 - sr.top) / sr.height,
        }
      }
    }
  }, [])
  const setScrollEl = useCallback(
    (el: HTMLDivElement | null) => {
      if (scrollRef.current === el) return
      scrollRef.current?.removeEventListener('scroll', handleScroll)
      scrollRef.current = el
      el?.addEventListener('scroll', handleScroll, { passive: true })
    },
    [handleScroll],
  )

  // coming back from another mobile tab: the stage was display:none, which
  // zeroed the scroll offsets while zoom survived — put the view back once
  // the page has re-rendered (scroll writes clamp to 0 on an empty container)
  const pendingRestoreRef = useRef<{ l: number; t: number } | null>(null)
  const prevSpaceW = useRef(0)
  useEffect(() => {
    const was = prevSpaceW.current
    prevSpaceW.current = spaceW
    if (was > 0 && spaceW === 0 && (lastScrollRef.current.l || lastScrollRef.current.t)) {
      // the stage just hid: snapshot NOW — on re-show the browser announces
      // the zeroed offsets with a scroll event before we could read them
      pendingRestoreRef.current = { ...lastScrollRef.current }
    }
  }, [spaceW])
  /** content point to center once the next render lands (view-memory restore) */
  const pendingCenterRef = useRef<{ fx: number; fy: number } | null>(null)
  useEffect(() => {
    const target = pendingRestoreRef.current
    const center = pendingCenterRef.current
    if ((!target && !center) || !view) return
    pendingRestoreRef.current = null
    pendingCenterRef.current = null
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (!el) return
      if (target) {
        // exact pixel restore (same layout as before, e.g. rev bump)
        el.scrollLeft = target.l
        el.scrollTop = target.t
        return
      }
      // content-fraction restore (layout may differ between stages)
      const sheet = sheetElRef.current
      if (!sheet || !center) return
      const er = el.getBoundingClientRect()
      const sr = sheet.getBoundingClientRect()
      if (er.width < 2 || sr.width < 2) return
      if (sr.width > er.width + 1) {
        el.scrollLeft += center.fx * sr.width + sr.left - (er.left + er.width / 2)
      }
      if (sr.height > er.height + 1) {
        el.scrollTop += center.fy * sr.height + sr.top - (er.top + er.height / 2)
      }
    })
  }, [view])

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

  // the zoom-settle timeout calls setZoom ~180ms later — cancel it on unmount
  // so it can't fire a state update after the stage is gone
  useEffect(
    () => () => {
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current)
    },
    [],
  )

  /**
   * Smooth zoom: scale instantly with CSS (anchored at the pointer), then
   * settle into a crisp re-render once the gesture pauses.
   */
  const zoomTo = useCallback(
    (target: number, anchor?: { x: number; y: number }) => {
      target = clamp(target, minZoom, maxZoom)
      const factor = target / zoomTargetRef.current
      if (Math.abs(factor - 1) < 0.001) return
      zoomTargetRef.current = target
      const scale = target / zoomRef.current
      pendingScaleRef.current = scale
      setPendingScale(scale)
      // imperative fast path: the sheet scales within this very event, without
      // waiting for a React render (which batches during rapid pinches)
      const v = getSheetSizeRef.current()
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
    },
    [minZoom, maxZoom],
  )

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

  const zoomStep = useCallback((factor: number) => zoomTo(zoomTargetRef.current * factor), [zoomTo])
  const zoomResetTo1 = useCallback(() => zoomTo(1), [zoomTo])

  /** switching documents: fresh paper starts at fit zoom, scroll at origin */
  const anchorSuppressRef = useRef(false)
  const resetZoom = useCallback(() => {
    zoomRef.current = 1
    zoomTargetRef.current = 1
    pendingScaleRef.current = 1
    setPendingScale(1)
    setZoom(1)
    lastScrollRef.current = { l: 0, t: 0 }
    pendingRestoreRef.current = null
    // the next crisp render shows DIFFERENT content — anchoring it to
    // whatever happened to be on screen would be wrong
    anchorSuppressRef.current = true
  }, [])

  // Per-document continuity: entering a stage (or switching documents inside
  // one) resumes the zoom and viewport-center point that document last had in
  // ANY stage; leaving saves them. A document never seen before starts fresh.
  useEffect(() => {
    if (!memoryKey) return
    const mem = viewMemory.get(memoryKey)
    anchorSuppressRef.current = true
    if (mem) {
      zoomRef.current = mem.zoom
      zoomTargetRef.current = mem.zoom
      pendingScaleRef.current = 1
      setPendingScale(1)
      setZoom(mem.zoom)
      pendingRestoreRef.current = null
      pendingCenterRef.current = { fx: mem.fx, fy: mem.fy }
      lastCenterRef.current = { fx: mem.fx, fy: mem.fy }
    } else {
      resetZoom()
      lastCenterRef.current = null
    }
    return () => {
      // NOTE: on unmount this runs after React nulls the DOM refs — only the
      // continuously-tracked values are trustworthy here
      const c = lastCenterRef.current
      const prev = viewMemory.get(memoryKey)
      viewMemory.set(memoryKey, {
        zoom: zoomTargetRef.current,
        fx: c?.fx ?? prev?.fx ?? 0.5,
        fy: c?.fy ?? prev?.fy ?? 0,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoryKey])

  /** a rev bump re-opens the same paper — put the scroll position back once
   *  the fresh render lands */
  const queueScrollRestore = useCallback(() => {
    if (lastScrollRef.current.l || lastScrollRef.current.t) {
      pendingRestoreRef.current = { ...lastScrollRef.current }
    }
  }, [])

  /**
   * A crisp render landed — it replaces the interim CSS scale. The commit is
   * content-anchored: the swap changes the layout (sizer size, margin-auto
   * centering, scroll clamps), and raw pixel offsets do NOT carry the view
   * across it — on phones the page visibly snapped toward the left corner
   * after every pinch. Capture the content point under the viewport center
   * BEFORE React applies the new view, then put that same point back after
   * layout. Axes that fit entirely (no overflow) center themselves.
   */
  const commitRender = useCallback(() => {
    const el = scrollRef.current
    const sheet = sheetElRef.current
    let anchor: { fx: number; fy: number } | null = null
    if (!anchorSuppressRef.current && el && sheet) {
      const er = el.getBoundingClientRect()
      const sr = sheet.getBoundingClientRect()
      if (er.width > 1 && sr.width > 1 && sr.height > 1) {
        anchor = {
          fx: (er.left + er.width / 2 - sr.left) / sr.width,
          fy: (er.top + er.height / 2 - sr.top) / sr.height,
        }
      }
    }
    anchorSuppressRef.current = false
    pendingScaleRef.current = 1
    setPendingScale(1)
    if (!anchor) return
    // rAF fires after React has applied the new view and the browser has laid
    // it out — measure the drift the swap introduced and scroll it away
    requestAnimationFrame(() => {
      const el2 = scrollRef.current
      const sheet2 = sheetElRef.current
      if (!el2 || !sheet2) return
      // a new gesture superseded this commit — never fight the fingers
      if (pinchRef.current || Math.abs(zoomTargetRef.current - zoomRef.current) > 0.001) return
      const er = el2.getBoundingClientRect()
      const sr = sheet2.getBoundingClientRect()
      if (sr.width > er.width + 1) {
        el2.scrollLeft += anchor.fx * sr.width + sr.left - (er.left + er.width / 2)
      }
      if (sr.height > er.height + 1) {
        el2.scrollTop += anchor.fy * sr.height + sr.top - (er.top + er.height / 2)
      }
    })
  }, [])

  /** deliberate UI action elsewhere (tool change): drop half-tracked gestures */
  const resetGestures = useCallback(() => {
    touchesRef.current.clear()
    pinchRef.current = null
    panRef.current = null
    tapRef.current = null
  }, [])

  /** begin panning the scroll container from an overlay pointerdown */
  const startPan = useCallback((e: { clientX: number; clientY: number }) => {
    const el = scrollRef.current
    if (el) panRef.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop }
  }, [])

  /** arm a deferred tap: pointerup checks .moved to tell a tap from a slide */
  const beginTap = useCallback((e: { clientX: number; clientY: number }, xf: number, yf: number) => {
    tapRef.current = { xf, yf, x: e.clientX, y: e.clientY, moved: false }
  }, [])

  /** feed overlay pointermoves: flips .moved past the slide threshold.
   *  Returns the tap so tool handlers can bail out while one is armed. */
  const trackTap = useCallback((e: { clientX: number; clientY: number }): TapState | null => {
    const tap = tapRef.current
    if (tap && !tap.moved && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 8) tap.moved = true
    return tap
  }, [])

  /** consume the armed tap (and its pan) on pointerup */
  const takeTap = useCallback((): TapState | null => {
    const tap = tapRef.current
    if (tap) {
      tapRef.current = null
      panRef.current = null
    }
    return tap
  }, [])

  // handlers for the scroll container. Capture phase tracks raw touches for
  // the pinch; bubble phase does middle-button + tool-initiated panning.
  const scrollProps = {
    ref: setScrollEl,
    onPointerDownCapture: (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch') return
      touchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (touchesRef.current.size === 2) {
        // second finger: abort any tool gesture, start pinch+pan
        panRef.current = null
        tapRef.current = null
        onPinchStartRef.current?.()
        const [a, b] = [...touchesRef.current.values()]
        pinchRef.current = {
          d0: Math.max(Math.hypot(a.x - b.x, a.y - b.y), 20),
          z0: zoomTargetRef.current,
          c: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        }
      }
    },
    onPointerMoveCapture: (e: React.PointerEvent) => {
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
    },
    onPointerUpCapture: (e: React.PointerEvent) => {
      touchesRef.current.delete(e.pointerId)
      if (touchesRef.current.size < 2) pinchRef.current = null
    },
    onPointerCancelCapture: (e: React.PointerEvent) => {
      touchesRef.current.delete(e.pointerId)
      if (touchesRef.current.size < 2) pinchRef.current = null
    },
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 1) return
      e.preventDefault()
      const el = scrollRef.current!
      panRef.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop }
      try {
        el.setPointerCapture(e.pointerId)
      } catch {
        /* synthetic pointer */
      }
    },
    onPointerMove: (e: React.PointerEvent) => {
      const p = panRef.current
      if (!p) return
      const el = scrollRef.current!
      el.scrollLeft = p.sl - (e.clientX - p.x)
      el.scrollTop = p.st - (e.clientY - p.y)
    },
    onPointerUp: () => {
      panRef.current = null
    },
  }

  // automation/debug hooks (CDP regressions inspect scroll + gesture state)
  const scrollDebug = useCallback(
    () => ({
      last: { ...lastScrollRef.current },
      pending: pendingRestoreRef.current ? { ...pendingRestoreRef.current } : null,
      prevW: prevSpaceW.current,
    }),
    [],
  )
  const gestureDebug = useCallback(
    () => ({
      touches: touchesRef.current.size,
      pinch: !!pinchRef.current,
      pan: !!panRef.current,
      tap: !!tapRef.current,
    }),
    [],
  )

  return {
    zoom,
    pendingScale,
    /** live zoom for display: committed × interim */
    zoomDisplay: zoom * pendingScale,
    zoomTo,
    zoomStep,
    zoomReset: zoomResetTo1,
    zoomTargetRef,
    pendingScaleRef,
    scrollRef,
    sizerRef,
    sheetElRef,
    scrollProps,
    panRef,
    tapRef,
    pinchRef,
    touchesRef,
    isPinching: () => pinchRef.current !== null,
    startPan,
    beginTap,
    trackTap,
    takeTap,
    resetZoom,
    queueScrollRestore,
    commitRender,
    resetGestures,
    scrollDebug,
    gestureDebug,
  }
}

export type ZoomPan = ReturnType<typeof useZoomPan>
