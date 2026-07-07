import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp, sessionHasEdits } from '../store'
import { useEdit } from '../editor/editStore'
import { buildEditedPdf } from '../editor/exportPdf'
import { openPdf, renderPage, type OpenedPdf, type RenderedPage } from '../lib/pdf'
import { effectivePlacement, fitStampBox, resolvePageIndex } from '../types'
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, DocMinusIcon, NibIcon, PlusIcon } from './icons'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

interface DragState {
  kind: 'move' | 'resize' | 'rotate'
  /** 'primary' for the smart-detected stamp, otherwise the stamp's id */
  target: string
  aspect: number
  startX: number
  startY: number
  /** whether the pointer travelled — a clean click selects, a drag only moves */
  moved: boolean
  box: { x: number; top: number; w: number; h: number }
  /** stamp centre in client coords — the pivot while rotating */
  center?: { x: number; y: number }
}

export default function Stage() {
  const { t } = useTranslation()
  const docs = useApp((s) => s.docs)
  const selectedDocId = useApp((s) => s.selectedDocId)
  const previewPage = useApp((s) => s.previewPage)
  const mode = useApp((s) => s.mode)
  const placement = useApp((s) => s.placement)
  const signatures = useApp((s) => s.signatures)
  const activeSignatureId = useApp((s) => s.activeSignatureId)
  const setPreviewPage = useApp((s) => s.setPreviewPage)
  const updatePlacementBox = useApp((s) => s.updatePlacementBox)
  const openFileDialog = useApp((s) => s.openFileDialog)
  const addExtraStamp = useApp((s) => s.addExtraStamp)
  const updateExtraStamp = useApp((s) => s.updateExtraStamp)
  const excludeStampForDoc = useApp((s) => s.excludeStampForDoc)
  const extraStamps = useApp((s) => s.extraStamps)
  const removeExtraStampEverywhere = useApp((s) => s.removeExtraStampEverywhere)
  const disablePrimary = useApp((s) => s.disablePrimary)
  const removePrimaryEverywhere = useApp((s) => s.removePrimaryEverywhere)
  const primaryRemoved = useApp((s) => s.primaryRemoved)
  const selectedStampId = useApp((s) => s.selectedStampId)
  const setSelectedStamp = useApp((s) => s.setSelectedStamp)

  const doc = docs.find((d) => d.id === selectedDocId)
  const signature = signatures.find((s) => s.id === activeSignatureId)
  // the doc's edit session (if any) — the sign preview composites unsaved
  // edits so it shows exactly what signing will produce
  const editSession = useEdit((s) => (doc ? s.sessions[doc.id] : undefined))

  const spaceRef = useRef<HTMLDivElement>(null)
  const [space, setSpace] = useState({ w: 0, h: 0 })
  const openedRef = useRef<{ id: string; opened: OpenedPdf } | null>(null)
  const [rendered, setRendered] = useState<RenderedPage | null>(null)
  // preview bytes = edited version when the doc has edits, else the original
  const [preview, setPreview] = useState<{ key: string; bytes: Uint8Array } | null>(null)
  const buildSeqRef = useRef(0)
  const dragRef = useRef<DragState | null>(null)
  /** pending ×-removal awaiting confirmation ('primary' or a stamp id) */
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

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

  const docOk = !!doc && doc.status !== 'error'

  // Build the preview bytes: the edited version when the doc has unsaved
  // edits (same builder as signing), else the original. Runs once on entering
  // the sign view / switching docs; edits don't change here.
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
        if (!cancelled && seq === buildSeqRef.current) setPreview({ key: `${doc.id}:${doc.rev}:e${seq}`, bytes })
      } catch {
        // build failed (e.g. protected) — fall back to the original so the
        // preview still renders; signing surfaces the real error
        if (!cancelled && seq === buildSeqRef.current) setPreview({ key: `${doc.id}:${doc.rev}`, bytes: doc.bytes })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [doc?.id, doc?.rev, editSession, doc])

  const previewKey = preview?.key
  useEffect(() => {
    let cancelled = false
    async function run() {
      if (!doc || !docOk || !preview || space.w < 80 || space.h < 80) {
        setRendered(null)
        return
      }
      if (openedRef.current?.id !== preview.key) {
        const prev = openedRef.current
        openedRef.current = null
        if (prev) void prev.opened.close()
        let opened: OpenedPdf
        try {
          opened = await openPdf(preview.bytes)
        } catch {
          return
        }
        if (cancelled) {
          void opened.close()
          return
        }
        openedRef.current = { id: preview.key, opened }
      }
      // clamp to the rendered doc's own page count (edits may add/remove pages)
      const n = openedRef.current!.opened.doc.numPages
      const page = clamp(previewPage, 0, n - 1)
      const mx = space.w < 560 ? 30 : 120
      const my = space.h < 720 ? 76 : 130
      try {
        const r = await renderPage(openedRef.current!.opened.doc, page, space.w - mx, space.h - my)
        if (!cancelled) setRendered(r)
      } catch {
        /* render races with close on rapid switching — the next effect run repaints */
      }
    }
    void run()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, docOk, previewPage, space.w, space.h])

  // --- placement boxes in CSS px -------------------------------------------
  const pl = doc && docOk ? effectivePlacement(doc, mode, placement) : null
  const page = doc ? clamp(previewPage, 0, doc.pageCount - 1) : 0
  const plPage = pl && doc ? resolvePageIndex(pl, doc.pageCount) : -1
  let box: { x: number; top: number; w: number; h: number } | null = null
  if (
    mode === 'smart' &&
    rendered &&
    pl &&
    signature &&
    plPage === page &&
    !doc?.primaryDisabled &&
    !primaryRemoved
  ) {
    const fitted = fitStampBox(pl, signature.width, signature.height, rendered.width, rendered.height)
    box = { x: fitted.x, top: fitted.yTop, w: fitted.w, h: fitted.h }
  }

  const extras =
    doc && docOk && rendered
      ? extraStamps
          .filter(
            (st) =>
              !doc.excludedStamps?.includes(st.id) &&
              resolvePageIndex(st.placement, doc.pageCount) === page,
          )
          .map((st) => {
            const sig = signatures.find((s) => s.id === st.signatureId)
            if (!sig) return null
            const fitted = fitStampBox(st.placement, sig.width, sig.height, rendered.width, rendered.height)
            return { stamp: st, sig, box: { x: fitted.x, top: fitted.yTop, w: fitted.w, h: fitted.h } }
          })
          .filter((x): x is NonNullable<typeof x> => x !== null)
      : []

  function commitBox(
    target: string,
    b: { x: number; top: number; w: number; h: number },
    dropMaxH = false,
    rot?: number,
  ) {
    if (!rendered || !doc) return
    const geom = {
      x: b.x / rendered.width,
      yb: (b.top + b.h) / rendered.height,
      w: b.w / rendered.width,
      ...(rot !== undefined ? { rot } : {}),
      dropMaxH,
    }
    if (target === 'primary') updatePlacementBox(geom)
    else updateExtraStamp(target, geom)
  }

  function beginStampDrag(
    e: React.PointerEvent,
    kind: 'move' | 'resize' | 'rotate',
    target: string,
    b: { x: number; top: number; w: number; h: number },
    aspect: number,
  ) {
    e.preventDefault()
    e.stopPropagation()
    try {
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    } catch {
      /* synthetic pointer */
    }
    let center: { x: number; y: number } | undefined
    if (kind === 'rotate') {
      // rotation keeps the centre fixed, so the rotated element's bounding
      // rect still gives the true pivot
      const host = (e.currentTarget as Element).closest('.sig-box')?.getBoundingClientRect()
      if (host) center = { x: host.left + host.width / 2, y: host.top + host.height / 2 }
    }
    dragRef.current = { kind, target, aspect, startX: e.clientX, startY: e.clientY, moved: false, box: b, center }
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current
    if (!d || !rendered) return
    if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 3) d.moved = true
    if (!d.moved) return
    const W = rendered.width
    const H = rendered.height
    if (d.kind === 'rotate') {
      if (!d.center) return
      // the handle sits above the centre, so straight up = 0°
      let rot = (Math.atan2(e.clientY - d.center.y, e.clientX - d.center.x) * 180) / Math.PI + 90
      if (rot > 180) rot -= 360
      const snap = Math.round(rot / 45) * 45
      if (Math.abs(rot - snap) < 5) rot = snap
      commitBox(d.target, d.box, false, Math.round(rot * 10) / 10)
      return
    }
    if (d.kind === 'move') {
      const x = clamp(d.box.x + e.clientX - d.startX, 0, W - d.box.w)
      const top = clamp(d.box.top + e.clientY - d.startY, 0, H - d.box.h)
      commitBox(d.target, { x, top, w: d.box.w, h: d.box.h })
    } else {
      let w = clamp(d.box.w + (e.clientX - d.startX), W * 0.05, W * 0.6)
      w = Math.min(w, W - d.box.x)
      const bottom = d.box.top + d.box.h
      if (bottom - w * d.aspect < 0) w = bottom / d.aspect
      // manual resize takes control: the fit-to-space cap no longer applies
      commitBox(d.target, { x: d.box.x, top: bottom - w * d.aspect, w, h: w * d.aspect }, true)
    }
  }

  function onPointerUp() {
    const d = dragRef.current
    dragRef.current = null
    // a clean click (no movement) selects the stamp for swapping/removal
    if (d && !d.moved) setSelectedStamp(d.target)
  }

  function onSheetClick(e: React.MouseEvent) {
    if (!rendered || !signature || !doc || !docOk) return
    if ((e.target as HTMLElement).closest('.sig-box')) return
    // clicking empty paper first deselects — never place by accident
    if (selectedStampId) {
      setSelectedStamp(null)
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const W = rendered.width
    const H = rendered.height
    const w = placement.w * W
    const h = w * (signature.height / signature.width)
    const x = clamp(cx - w / 2, 0, W - w)
    const top = clamp(cy - h / 2, 0, H - h)
    addExtraStamp({ x: x / W, yb: (top + h) / H, w: w / W })
  }

  // Esc deselects
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && useApp.getState().selectedStampId) setSelectedStamp(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setSelectedStamp])

  function removeStampEverywhere(target: string) {
    if (target === 'primary') removePrimaryEverywhere()
    else removeExtraStampEverywhere(target)
  }

  function onStampX(target: string) {
    if (docs.length > 1) setConfirmRemove(target)
    else removeStampEverywhere(target)
  }

  // --- hint ----------------------------------------------------------------
  let hint: { text: string; kind: 'info' | 'smart' | 'warn' } | null = null
  if (doc && docOk) {
    if (!signature) hint = { text: t('stage.noSignature'), kind: 'info' }
    else if (mode === 'manual' && extraStamps.length === 0)
      hint = { text: t('sig.clickToPlace'), kind: 'info' }
    else if (mode === 'smart' && !doc.override) {
      if (doc.smart) hint = { text: t('stage.smartFound'), kind: 'smart' }
      else if (doc.smart === null) hint = { text: t('stage.smartNone'), kind: 'warn' }
    }
    // protection warning fills the slot only when nothing actionable is shown
    if (!hint && doc.encrypted) hint = { text: t('stage.encrypted'), kind: 'warn' }
  }

  if (!docs.length) {
    return (
      <section className="stage" ref={spaceRef}>
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
    <section className="stage" ref={spaceRef}>
      {hint && <div className={`stage-hint hint-${hint.kind}`}>{hint.text}</div>}

      {doc && !docOk && <div className="stage-error">{doc.error}</div>}

      {rendered && docOk && (
        <div className="stack-wrap">
          {docs.length > 1 && (
            <>
              <div className="stack-sheet s2" />
              <div className="stack-sheet s1" />
            </>
          )}
          <div
            className="sheet"
            style={{ width: rendered.width, height: rendered.height }}
            onClick={onSheetClick}
          >
            <div
              className="canvas-holder"
              ref={(el) => {
                if (el && rendered) el.replaceChildren(rendered.canvas)
              }}
            />
            {box && signature && doc && (
              <div
                className={`sig-box ${mode === 'smart' && !doc.override ? 'smart' : ''} ${
                  selectedStampId === 'primary' ? 'stamp-selected' : ''
                }`}
                style={{
                  left: box.x,
                  top: box.top,
                  width: box.w,
                  height: box.h,
                  transform: pl?.rot ? `rotate(${pl.rot}deg)` : undefined,
                }}
                onPointerDown={(e) =>
                  beginStampDrag(e, 'move', 'primary', box!, signature.height / signature.width)
                }
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
              >
                <img src={signature.dataUrl} alt="" draggable={false} />
                {docs.length > 1 && (
                  <button
                    className="stamp-x stamp-doc-x"
                    title={t('sig.removeStampDoc')}
                    aria-label={t('sig.removeStampDoc')}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      disablePrimary(doc.id)
                    }}
                  >
                    <DocMinusIcon size={10} />
                  </button>
                )}
                <button
                  className="stamp-x"
                  title={t(docs.length > 1 ? 'sig.removeStampAll' : 'sig.removeStamp')}
                  aria-label={t(docs.length > 1 ? 'sig.removeStampAll' : 'sig.removeStamp')}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    onStampX('primary')
                  }}
                >
                  <CloseIcon size={10} />
                </button>
                <span
                  className="sig-handle"
                  onPointerDown={(e) =>
                    beginStampDrag(e, 'resize', 'primary', box!, signature.height / signature.width)
                  }
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                />
                <span
                  className="sig-rotate"
                  title={t('sig.rotate')}
                  onPointerDown={(e) =>
                    beginStampDrag(e, 'rotate', 'primary', box!, signature.height / signature.width)
                  }
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    commitBox('primary', box!, false, 0)
                  }}
                />
              </div>
            )}
            {doc &&
              extras.map(({ stamp, sig, box: b }) => (
                <div
                  key={stamp.id}
                  className={`sig-box extra ${selectedStampId === stamp.id ? 'stamp-selected' : ''}`}
                  style={{
                    left: b.x,
                    top: b.top,
                    width: b.w,
                    height: b.h,
                    transform: stamp.placement.rot ? `rotate(${stamp.placement.rot}deg)` : undefined,
                  }}
                  onPointerDown={(e) => beginStampDrag(e, 'move', stamp.id, b, sig.height / sig.width)}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                >
                  <img src={sig.dataUrl} alt="" draggable={false} />
                  {docs.length > 1 && (
                    <button
                      className="stamp-x stamp-doc-x"
                      title={t('sig.removeStampDoc')}
                      aria-label={t('sig.removeStampDoc')}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation()
                        excludeStampForDoc(doc.id, stamp.id)
                      }}
                    >
                      <DocMinusIcon size={10} />
                    </button>
                  )}
                  <button
                    className="stamp-x"
                    title={t(docs.length > 1 ? 'sig.removeStampAll' : 'sig.removeStamp')}
                    aria-label={t(docs.length > 1 ? 'sig.removeStampAll' : 'sig.removeStamp')}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      onStampX(stamp.id)
                    }}
                  >
                    <CloseIcon size={10} />
                  </button>
                  <span
                    className="sig-handle"
                    onPointerDown={(e) => beginStampDrag(e, 'resize', stamp.id, b, sig.height / sig.width)}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                  />
                  <span
                    className="sig-rotate"
                    title={t('sig.rotate')}
                    onPointerDown={(e) => beginStampDrag(e, 'rotate', stamp.id, b, sig.height / sig.width)}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      commitBox(stamp.id, b, false, 0)
                    }}
                  />
                </div>
              ))}
          </div>
          {docs.length > 1 && (
            <div className="stack-badge">{t('stage.stackMore', { count: docs.length - 1 })}</div>
          )}
        </div>
      )}

      {confirmRemove && doc && (
        <div className="modal-veil" onClick={() => setConfirmRemove(null)}>
          <div className="modal dialog confirm-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h2>{t('sig.removeAllTitle')}</h2>
            <p className="muted">{t('sig.removeAllBody', { count: docs.length })}</p>
            <div className="dialog-actions">
              <button
                className="ghost-btn"
                onClick={() => {
                  if (confirmRemove === 'primary') disablePrimary(doc.id)
                  else excludeStampForDoc(doc.id, confirmRemove)
                  setConfirmRemove(null)
                }}
              >
                {t('sig.removeStampDoc')}
              </button>
              <div className="spacer" />
              <button className="ghost-btn" onClick={() => setConfirmRemove(null)}>
                {t('studio.cancel')}
              </button>
              <button
                className="btn-primary btn-danger"
                onClick={() => {
                  removeStampEverywhere(confirmRemove)
                  setConfirmRemove(null)
                }}
              >
                {t('sig.removeStampAll')}
              </button>
            </div>
          </div>
        </div>
      )}

      {doc && docOk && doc.pageCount > 1 && (
        <div className="page-nav">
          <button
            aria-label="Previous page"
            disabled={page === 0}
            onClick={() => setPreviewPage(page - 1)}
          >
            <ChevronLeftIcon size={14} />
          </button>
          <span>{t('stage.page', { page: page + 1, pages: doc.pageCount })}</span>
          <button
            aria-label="Next page"
            disabled={page >= doc.pageCount - 1}
            onClick={() => setPreviewPage(page + 1)}
          >
            <ChevronRightIcon size={14} />
          </button>
        </div>
      )}
    </section>
  )
}
