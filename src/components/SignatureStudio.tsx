import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../store'
import { drawStrokes, SIG_PENS, type SigPen, type Stroke } from '../lib/drawing'
import { applySheen, inkHex, inkSwatchCss } from '../lib/ink'
import { DEFAULT_EXTRACT, extractSignature, type ExtractOptions } from '../lib/extractSignature'
import { renderTypedSignature, SIGNATURE_FONTS } from '../lib/typedSignature'
import { trimCanvas, loadImage } from '../lib/imageUtils'
import { ColorPopover } from './edit/ColorField'
import { CloseIcon, TrashIcon, UndoIcon } from './icons'

type Tab = 'draw' | 'photo' | 'type'
type Results = Partial<Record<Tab, HTMLCanvasElement | null>>

// ---------------------------------------------------------------------------

function InkPicker({
  value,
  onChange,
  withOriginal,
}: {
  value: string
  onChange: (v: string) => void
  withOriginal?: boolean
}) {
  const { t } = useTranslation()
  const [mixerOpen, setMixerOpen] = useState(false)
  const options: { key: string; label: string; swatch?: string }[] = [
    ...(withOriginal ? [{ key: 'original', label: t('ink.original') }] : []),
    { key: 'black', label: t('ink.black'), swatch: inkSwatchCss('black') },
    { key: 'blue-black', label: t('ink.blueBlack'), swatch: inkSwatchCss('blue-black') },
    { key: 'royal', label: t('ink.royal'), swatch: inkSwatchCss('royal') },
    { key: 'gold', label: t('ink.gold'), swatch: inkSwatchCss('gold') },
    { key: 'silver', label: t('ink.silver'), swatch: inkSwatchCss('silver') },
  ]
  // anything that isn't a preset key is a mixed custom colour (hex)
  const isCustom = /^#[0-9a-f]{6}$/i.test(value)
  return (
    <div className="ink-picker color-row" role="group" aria-label={t('studio.ink')}>
      <span className="field-label">{t('studio.ink')}</span>
      {options.map((o) => (
        <button
          key={o.key}
          className={value === o.key ? 'ink-swatch active' : 'ink-swatch'}
          style={o.swatch ? { background: o.swatch } : undefined}
          title={o.label}
          aria-label={o.label}
          onClick={() => {
            setMixerOpen(false)
            onChange(o.key)
          }}
        >
          {!o.swatch && <span className="ink-orig">◐</span>}
        </button>
      ))}
      <button
        className={isCustom || mixerOpen ? 'ink-swatch custom active' : 'ink-swatch custom'}
        style={isCustom ? { background: value } : undefined}
        title={t('edit.customColor')}
        aria-label={t('edit.customColor')}
        onClick={() => setMixerOpen((o) => !o)}
      />
      {mixerOpen && (
        <ColorPopover
          value={isCustom ? value : '#2f45c4'}
          onChange={onChange}
          onClose={() => setMixerOpen(false)}
        />
      )}
    </div>
  )
}

function PenPicker({ value, onChange }: { value: SigPen; onChange: (p: SigPen) => void }) {
  const { t } = useTranslation()
  return (
    <div className="pen-picker" role="group" aria-label={t('studio.pen')}>
      <span className="field-label">{t('studio.pen')}</span>
      {(Object.keys(SIG_PENS) as SigPen[]).map((p) => (
        <button
          key={p}
          className={value === p ? 'pen-opt active' : 'pen-opt'}
          onClick={() => onChange(p)}
        >
          {t(`studio.pen.${p}`)}
        </button>
      ))}
    </div>
  )
}

// --- Draw ------------------------------------------------------------------

const DRAW_W = 640
const DRAW_H = 240

function DrawTab({ onResult }: { onResult: (c: HTMLCanvasElement | null) => void }) {
  const { t } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [ink, setInk] = useState<string>('blue-black')
  const [pen, setPen] = useState<SigPen>('fountain')
  const liveStroke = useRef<Stroke | null>(null)

  const repaint = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    if (canvas.width !== DRAW_W * dpr) {
      canvas.width = DRAW_W * dpr
      canvas.height = DRAW_H * dpr
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const all = liveStroke.current ? [...strokes, liveStroke.current] : strokes
    drawStrokes(ctx, all, inkHex(ink), dpr)
    applySheen(canvas, ink)
  }, [strokes, ink])

  useEffect(() => {
    repaint()
    if (!strokes.length) {
      onResult(null)
      return
    }
    const out = document.createElement('canvas')
    out.width = DRAW_W * 2
    out.height = DRAW_H * 2
    drawStrokes(out.getContext('2d')!, strokes, inkHex(ink), 2)
    const trimmed = trimCanvas(out, 8, 16)
    if (trimmed) applySheen(trimmed, ink)
    onResult(trimmed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strokes, ink])

  function toLocal(e: React.PointerEvent): [number, number, number] {
    const rect = canvasRef.current!.getBoundingClientRect()
    return [
      ((e.clientX - rect.left) / rect.width) * DRAW_W,
      ((e.clientY - rect.top) / rect.height) * DRAW_H,
      e.pressure || 0.5,
    ]
  }

  return (
    <div className="tab-body">
      <p className="muted">{t('studio.draw.hint')}</p>
      <div className="draw-paper">
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: 'auto', touchAction: 'none', display: 'block', aspectRatio: `${DRAW_W}/${DRAW_H}` }}
          onPointerDown={(e) => {
            e.preventDefault()
            ;(e.target as Element).setPointerCapture(e.pointerId)
            liveStroke.current = {
              points: [toLocal(e)],
              simulatePressure: e.pointerType !== 'pen',
              pen,
            }
            repaint()
          }}
          onPointerMove={(e) => {
            if (!liveStroke.current) return
            liveStroke.current.points.push(toLocal(e))
            repaint()
          }}
          onPointerUp={() => {
            const s = liveStroke.current
            liveStroke.current = null
            if (s && s.points.length > 1) setStrokes((prev) => [...prev, s])
          }}
        />
        <div className="draw-baseline" />
      </div>
      <div className="tab-tools">
        <InkPicker value={ink} onChange={setInk} />
        <div className="spacer" />
        <button
          className="ghost-btn"
          disabled={!strokes.length}
          onClick={() => setStrokes((s) => s.slice(0, -1))}
        >
          <UndoIcon size={14} />
          {t('studio.undo')}
        </button>
        <button className="ghost-btn" disabled={!strokes.length} onClick={() => setStrokes([])}>
          <TrashIcon size={14} />
          {t('studio.clear')}
        </button>
      </div>
      <div className="tab-tools">
        <PenPicker value={pen} onChange={setPen} />
      </div>
    </div>
  )
}

// --- Photo -----------------------------------------------------------------

function PhotoTab({ onResult }: { onResult: (c: HTMLCanvasElement | null) => void }) {
  const { t } = useTranslation()
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [opts, setOpts] = useState<ExtractOptions>(DEFAULT_EXTRACT)
  const [out, setOut] = useState<HTMLCanvasElement | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!img) {
      setOut(null)
      onResult(null)
      return
    }
    const timer = setTimeout(() => {
      const result = extractSignature(img, opts)
      setOut(result)
      onResult(result)
    }, 130)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, opts])

  async function pick(file: File | undefined) {
    if (!file || !file.type.startsWith('image/')) return
    setImg(await loadImage(file))
  }

  return (
    <div className="tab-body">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      {!img ? (
        <button
          className="photo-drop"
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            e.stopPropagation()
            void pick(e.dataTransfer.files[0])
          }}
        >
          <span className="photo-drop-title">{t('studio.photo.pick')}</span>
          <span className="muted">{t('studio.photo.drop')}</span>
        </button>
      ) : (
        <>
          <div className="checker photo-preview">
            {out ? (
              <div
                className="canvas-view"
                ref={(el) => {
                  if (el && out) {
                    out.style.maxWidth = '100%'
                    out.style.maxHeight = '200px'
                    el.replaceChildren(out)
                  }
                }}
              />
            ) : (
              <span className="muted">…</span>
            )}
          </div>
          <div className="tab-tools photo-tools">
            <label className="field slider-field">
              <span>{t('studio.photo.sensitivity')}</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.02}
                value={opts.sensitivity}
                onChange={(e) => setOpts((o) => ({ ...o, sensitivity: Number(e.target.value) }))}
              />
            </label>
            <label className="field slider-field">
              <span>{t('studio.photo.despeckle')}</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.02}
                value={opts.despeckle}
                onChange={(e) => setOpts((o) => ({ ...o, despeckle: Number(e.target.value) }))}
              />
            </label>
          </div>
          <div className="tab-tools">
            <InkPicker
              withOriginal
              value={opts.ink}
              onChange={(v) => setOpts((o) => ({ ...o, ink: v as ExtractOptions['ink'] }))}
            />
            <div className="spacer" />
            <button className="ghost-btn" onClick={() => fileRef.current?.click()}>
              {t('studio.photo.retake')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// --- Type ------------------------------------------------------------------

function TypeTab({ onResult }: { onResult: (c: HTMLCanvasElement | null) => void }) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [fontId, setFontId] = useState(SIGNATURE_FONTS[0].id)
  const [ink, setInk] = useState<string>('blue-black')

  useEffect(() => {
    const trimmed = text.trim()
    if (!trimmed) {
      onResult(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      const font = SIGNATURE_FONTS.find((f) => f.id === fontId) ?? SIGNATURE_FONTS[0]
      void renderTypedSignature(trimmed, font, ink).then((c) => {
        if (!cancelled) onResult(c)
      })
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, fontId, ink])

  return (
    <div className="tab-body">
      <input
        className="type-input"
        type="text"
        value={text}
        placeholder={t('studio.type.placeholder')}
        onChange={(e) => setText(e.target.value)}
        autoFocus
      />
      <span className="field-label">{t('studio.type.style')}</span>
      <div className="font-grid">
        {SIGNATURE_FONTS.map((f) => (
          <button
            key={f.id}
            className={f.id === fontId ? 'font-card active' : 'font-card'}
            style={{ fontFamily: `"${f.family}"`, color: inkHex(ink) }}
            onClick={() => setFontId(f.id)}
          >
            {text.trim() || t('studio.type.placeholder')}
          </button>
        ))}
      </div>
      <div className="tab-tools">
        <InkPicker value={ink} onChange={setInk} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

export default function SignatureStudio() {
  const { t } = useTranslation()
  const closeStudio = useApp((s) => s.closeStudio)
  const addSignature = useApp((s) => s.addSignature)
  const signatures = useApp((s) => s.signatures)
  const [tab, setTab] = useState<Tab>('draw')
  const [name, setName] = useState('')
  const [results, setResults] = useState<Results>({})

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeStudio()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeStudio])

  const setResult = useCallback(
    (forTab: Tab) => (c: HTMLCanvasElement | null) =>
      setResults((r) => (r[forTab] === c ? r : { ...r, [forTab]: c })),
    [],
  )

  const current = results[tab] ?? null

  function save() {
    if (!current) return
    addSignature({
      name: name.trim() || `${t('sig.title')} ${signatures.length + 1}`,
      dataUrl: current.toDataURL('image/png'),
      width: current.width,
      height: current.height,
    })
    closeStudio()
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'draw', label: t('studio.tab.draw') },
    { id: 'photo', label: t('studio.tab.photo') },
    { id: 'type', label: t('studio.tab.type') },
  ]

  return (
    <div className="modal-veil" onClick={closeStudio}>
      <div
        className="modal studio"
        role="dialog"
        aria-modal="true"
        aria-label={t('studio.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="studio-head">
          <h2>{t('studio.title')}</h2>
          <button className="icon-btn" aria-label={t('studio.cancel')} onClick={closeStudio}>
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="studio-tabs" role="tablist">
          {tabs.map(({ id, label }) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? 'studio-tab active' : 'studio-tab'}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div style={{ display: tab === 'draw' ? 'block' : 'none' }}>
          <DrawTab onResult={setResult('draw')} />
        </div>
        <div style={{ display: tab === 'photo' ? 'block' : 'none' }}>
          <PhotoTab onResult={setResult('photo')} />
        </div>
        <div style={{ display: tab === 'type' ? 'block' : 'none' }}>
          <TypeTab onResult={setResult('type')} />
        </div>

        <div className="studio-foot">
          <label className="field name-field">
            <span>{t('studio.name')}</span>
            <input
              type="text"
              value={name}
              placeholder={t('studio.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="spacer" />
          <button className="ghost-btn" onClick={closeStudio}>
            {t('studio.cancel')}
          </button>
          <button className="btn-primary" disabled={!current} onClick={save}>
            {t('studio.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
