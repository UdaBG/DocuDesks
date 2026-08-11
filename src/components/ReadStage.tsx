import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp, sessionHasEdits } from '../store'
import { useEdit } from '../editor/editStore'
import { buildEditedPdf } from '../editor/exportPdf'
import { openPdf, renderPage, type OpenedPdf } from '../lib/pdf'
import { useZoomPan } from '../lib/useZoomPan'
import { ChevronLeftIcon, ChevronRightIcon, NibIcon, PlusIcon } from './icons'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

interface ReadView {
  W: number
  H: number
  canvas: HTMLCanvasElement
  /** page count of the rendered bytes (edits may add/remove pages) */
  pages: number
}

/**
 * Read mode: the document and nothing else. No tools, no panels — just the
 * shared canvas (pinch/wheel zoom, pan, page navigation). This is also the
 * "default PDF app" experience Android lands in for "Open with DocuDesk".
 * Shows exactly what saving would produce: unsaved edits are composited in.
 */
export default function ReadStage() {
  const { t } = useTranslation()
  const docs = useApp((s) => s.docs)
  const selectedDocId = useApp((s) => s.selectedDocId)
  const previewPage = useApp((s) => s.previewPage)
  const setPreviewPage = useApp((s) => s.setPreviewPage)
  const openFileDialog = useApp((s) => s.openFileDialog)

  const doc = docs.find((d) => d.id === selectedDocId)
  const docOk = !!doc && doc.status !== 'error'
  const editSession = useEdit((s) => (doc ? s.sessions[doc.id] : undefined))

  const spaceRef = useRef<HTMLDivElement>(null)
  const [space, setSpace] = useState({ w: 0, h: 0 })
  const overlayRef = useRef<HTMLDivElement>(null)
  const openedRef = useRef<{ key: string; opened: OpenedPdf } | null>(null)
  const [view, setView] = useState<ReadView | null>(null)
  const viewRef = useRef<ReadView | null>(null)
  useEffect(() => {
    viewRef.current = view
  }, [view])
  // preview bytes = edited version when the doc has edits, else the original
  const [preview, setPreview] = useState<{ key: string; bytes: Uint8Array } | null>(null)
  const buildSeqRef = useRef(0)

  const zp = useZoomPan({
    getSheetSize: () => (viewRef.current ? { W: viewRef.current.W, H: viewRef.current.H } : null),
    spaceW: space.w,
    view,
  })

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

  // fit-zoom resets when SWITCHING documents; a rev bump on the same doc
  // (Apply to stack, unlock) re-opens the same paper — the user's zoom stays
  // and the scroll position is put back once the fresh render lands
  const docKey = doc ? `${doc.id}:${doc.rev}` : ''
  const prevDocIdRef = useRef('')
  useEffect(() => {
    const idChanged = prevDocIdRef.current !== (doc?.id ?? '')
    prevDocIdRef.current = doc?.id ?? ''
    if (idChanged) zp.resetZoom()
    else zp.queueScrollRestore()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey])

  // Build the preview bytes: the edited version when the doc has unsaved
  // edits (same builder as saving), else the original.
  useEffect(() => {
    let cancelled = false
    if (!doc) {
      setPreview(null)
      return
    }
    if (!sessionHasEdits(editSession, doc)) {
      setPreview({ key: `${doc.id}:${doc.rev}`, bytes: doc.bytes })
      return
    }
    const seq = ++buildSeqRef.current
    void (async () => {
      try {
        const bytes = await buildEditedPdf(doc.bytes, editSession!)
        if (!cancelled && seq === buildSeqRef.current)
          setPreview({ key: `${doc.id}:${doc.rev}:e${seq}`, bytes })
      } catch {
        // build failed (e.g. protected) — fall back to the original so the
        // reader still shows the document
        if (!cancelled && seq === buildSeqRef.current)
          setPreview({ key: `${doc.id}:${doc.rev}`, bytes: doc.bytes })
      }
    })()
    return () => {
      cancelled = true
    }
    // doc.id + doc.rev capture identity and any byte/page change; unrelated
    // doc fields (status flips) must not rebuild the preview
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.id, doc?.rev, editSession])

  // Render the current page at the committed zoom (same pipeline as Edit)
  const previewKey = preview?.key
  useEffect(() => {
    let cancelled = false
    let retries = 0
    const retry = () => {
      if (!cancelled && retries < 3) {
        retries++
        setTimeout(() => {
          if (!cancelled) void run()
        }, 400 * retries)
      }
    }
    async function run() {
      if (!doc || !docOk || !preview || space.w < 100 || space.h < 100) {
        setView(null)
        return
      }
      if (openedRef.current?.key !== preview.key) {
        const prev = openedRef.current
        openedRef.current = null
        if (prev) void prev.opened.close()
        let opened: OpenedPdf
        try {
          opened = await openPdf(preview.bytes)
        } catch {
          retry()
          return
        }
        if (cancelled) return void opened.close()
        openedRef.current = { key: preview.key, opened }
      }
      const proxy = openedRef.current.opened.doc
      const n = proxy.numPages
      const pageIndex = clamp(previewPage, 0, n - 1)
      // phones fit by width only — reading fills the screen edge to edge
      const phone = space.w < 760
      const maxW = (space.w - (phone ? 20 : 40)) * zp.zoom
      const maxH = phone ? Number.POSITIVE_INFINITY : (space.h - 72) * zp.zoom
      try {
        const rendered = await renderPage(proxy, pageIndex, maxW, maxH, 3, 20_000_000)
        if (cancelled) return
        setView({ W: rendered.width, H: rendered.height, canvas: rendered.canvas, pages: n })
        // the crisp render replaces the interim CSS scale
        zp.commitRender()
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
  }, [previewKey, docOk, previewPage, space.w, space.h, zp.zoom])

  const pages = view?.pages ?? doc?.pageCount ?? 1
  const page = clamp(previewPage, 0, pages - 1)

  // Keyboard: page navigation + zoom (arrows Up/Down stay native scrolling)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        zp.zoomStep(1.2)
      } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault()
        zp.zoomStep(1 / 1.2)
      } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault()
        zp.zoomReset()
      } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault()
        setPreviewPage(Math.min(page + 1, pages - 1))
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault()
        setPreviewPage(Math.max(page - 1, 0))
      } else if (e.key === 'Home') {
        e.preventDefault()
        setPreviewPage(0)
      } else if (e.key === 'End') {
        e.preventDefault()
        setPreviewPage(pages - 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pages, setPreviewPage])

  if (!docs.length) {
    return (
      <section className="stage read-stage" ref={spaceRef}>
        <div className="stage-empty">
          <NibIcon size={44} className="stage-empty-nib" />
          <h1>{t('docs.empty.title')}</h1>
          <p>{t('docs.empty.body')}</p>
          <button className="btn-primary" onClick={() => void openFileDialog()}>
            <PlusIcon size={16} />
            {t('docs.add')}
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="stage read-stage" ref={spaceRef}>
      {doc && !docOk && <div className="stage-error">{doc.error}</div>}

      <div className="zoom-pill">
        <button title={t('edit.zoomOut')} onClick={() => zp.zoomStep(1 / 1.2)}>
          −
        </button>
        <button className="zoom-value" title={t('edit.zoomReset')} onClick={() => zp.zoomReset()}>
          {Math.round(zp.zoomDisplay * 100)}%
        </button>
        <button title={t('edit.zoomIn')} onClick={() => zp.zoomStep(1.2)}>
          +
        </button>
      </div>

      <div className="read-scroll" {...zp.scrollProps}>
        {view && (
          <div
            className="zoom-sizer"
            ref={zp.sizerRef}
            style={{ width: view.W * zp.pendingScale, height: view.H * zp.pendingScale }}
          >
            <div
              className="sheet edit-sheet"
              ref={zp.sheetElRef}
              style={{
                width: view.W,
                height: view.H,
                transform: zp.pendingScale !== 1 ? `scale(${zp.pendingScale})` : undefined,
              }}
            >
              <div
                className="canvas-holder"
                ref={(el) => {
                  if (el) el.replaceChildren(view.canvas)
                }}
              />
              {/* pan surface: any finger or mouse drag moves the paper; two
                  fingers pinch (handled by the scroll container's capture) */}
              <div
                ref={overlayRef}
                className="read-overlay"
                onPointerDown={(e) => {
                  if (e.button !== 0) return // middle button pans via the container
                  if (zp.isPinching()) return
                  zp.startPan(e)
                  try {
                    overlayRef.current!.setPointerCapture(e.pointerId)
                  } catch {
                    /* synthetic or stale pointer */
                  }
                }}
              />
            </div>
          </div>
        )}
      </div>

      {doc && docOk && pages > 1 && (
        <div className="page-nav">
          <button
            aria-label={t('stage.prevPage')}
            disabled={page === 0}
            onClick={() => setPreviewPage(page - 1)}
          >
            <ChevronLeftIcon size={14} />
          </button>
          <span>{t('stage.page', { page: page + 1, pages })}</span>
          <button
            aria-label={t('stage.nextPage')}
            disabled={page >= pages - 1}
            onClick={() => setPreviewPage(page + 1)}
          >
            <ChevronRightIcon size={14} />
          </button>
        </div>
      )}
    </section>
  )
}
