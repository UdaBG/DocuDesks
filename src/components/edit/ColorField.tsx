import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useEdit } from '../../editor/editStore'
import { isTauri } from '../../platform/tauriApi'

const SWATCHES = ['#1c1c1e', '#2f45c4', '#26357c', '#bb3a30', '#17804d', '#a86500', '#ffffff']

/**
 * WebView2 exposes the EyeDropper constructor but never renders its picking
 * UI — invoking it just swallows all input. Use it only where it works.
 */
function nativeEyeDropperUsable(): boolean {
  return (
    'EyeDropper' in window &&
    !isTauri() &&
    !(window as unknown as { __forceInAppSample?: boolean }).__forceInAppSample
  )
}

// ---- color math -------------------------------------------------------------

function hexToHsv(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16)
  const r = ((v >> 16) & 255) / 255
  const g = ((v >> 8) & 255) / 255
  const b = (v & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return [h, max === 0 ? 0 : d / max, max]
}

function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let r = 0, g = 0, b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const to = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

// ---- self-contained picker popover (no native color dialog: WebView2's is broken) ----
// Also reused by the signature studio's ink picker.

export function ColorPopover({
  value,
  onChange,
  onClose,
}: {
  value: string
  onChange: (v: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const rootRef = useRef<HTMLDivElement>(null)
  const svRef = useRef<HTMLDivElement>(null)
  const [[h, s, v], setHsv] = useState<[number, number, number]>(() => hexToHsv(value))
  const [hexText, setHexText] = useState(value)
  const sampling = useEdit((st) => st.sampling)
  const setSampling = useEdit((st) => st.setSampling)
  const [inModal, setInModal] = useState(false)

  useEffect(() => {
    setInModal(!!rootRef.current?.closest('.modal'))
  }, [])

  const applyHex = (hex: string) => {
    setHsv(hexToHsv(hex))
    setHexText(hex)
    onChange(hex)
  }

  const commit = (nh: number, ns: number, nv: number) => {
    setHsv([nh, ns, nv])
    const hex = hsvToHex(nh, ns, nv)
    setHexText(hex)
    onChange(hex)
  }

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      // while sampling from the document, clicks on the page must not close us
      if (useEdit.getState().sampling) return
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [onClose])

  // receive the sampled color from the page; cancel sampling when unmounting
  useEffect(() => {
    const onSampled = (e: Event) => {
      applyHex((e as CustomEvent<string>).detail)
    }
    window.addEventListener('signer:color-sampled', onSampled)
    return () => {
      window.removeEventListener('signer:color-sampled', onSampled)
      if (useEdit.getState().sampling) setSampling(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function startEyedrop() {
    if (nativeEyeDropperUsable()) {
      try {
        const EyeDropperCtor = (
          window as unknown as { EyeDropper: new () => { open(): Promise<{ sRGBHex: string }> } }
        ).EyeDropper
        const res = await new EyeDropperCtor().open()
        applyHex(res.sRGBHex.toLowerCase())
      } catch {
        /* cancelled */
      }
    } else {
      setSampling(true) // EditStage samples the next click on the page
    }
  }

  const showEyedrop = nativeEyeDropperUsable() || !inModal

  const pickSv = (e: React.PointerEvent) => {
    const rect = svRef.current!.getBoundingClientRect()
    const ns = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    const nv = Math.min(1, Math.max(0, 1 - (e.clientY - rect.top) / rect.height))
    commit(h, ns, nv)
  }

  return (
    <div className="color-popover" ref={rootRef} onPointerDown={(e) => e.stopPropagation()}>
      <div
        ref={svRef}
        className="cp-sv"
        style={{ backgroundColor: `hsl(${h} 100% 50%)` }}
        onPointerDown={(e) => {
          ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
          pickSv(e)
        }}
        onPointerMove={(e) => {
          if (e.buttons) pickSv(e)
        }}
      >
        <span className="cp-dot" style={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%` }} />
      </div>
      <input
        className="cp-hue"
        type="range"
        min={0}
        max={360}
        step={1}
        value={Math.round(h)}
        onChange={(e) => commit(Number(e.target.value), s, v)}
      />
      <div className="cp-row">
        <span className="cp-preview" style={{ background: hsvToHex(h, s, v) }} />
        {showEyedrop && (
          <button
            className={sampling ? 'cp-eyedrop active' : 'cp-eyedrop'}
            title={t(nativeEyeDropperUsable() ? 'edit.eyedropScreen' : 'edit.eyedropPage')}
            onClick={() => void startEyedrop()}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M13.5 7.5l3 3M12 9l-7 7-1 4 4-1 7-7M15 4.5l1.8-1.8a2.3 2.3 0 0 1 3.2 3.2l-1.8 1.8a1.5 1.5 0 0 1-2.1 0l-1.1-1.1a1.5 1.5 0 0 1 0-2.1Z" />
            </svg>
          </button>
        )}
        <input
          className="cp-hex"
          type="text"
          value={hexText}
          spellCheck={false}
          onChange={(e) => {
            const t = e.target.value.trim()
            setHexText(t)
            if (/^#[0-9a-fA-F]{6}$/.test(t)) {
              setHsv(hexToHsv(t.toLowerCase()))
              onChange(t.toLowerCase())
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') onClose()
          }}
        />
      </div>
    </div>
  )
}

export default function ColorField({
  label,
  value,
  onChange,
  allowNone,
}: {
  label: string
  value: string | null
  onChange: (v: string | null) => void
  allowNone?: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div className="color-field">
      <span className="field-label">{label}</span>
      <div className="color-row">
        {allowNone && (
          <button
            className={value === null ? 'swatch none active' : 'swatch none'}
            title={t('edit.none')}
            aria-label={t('edit.none')}
            onClick={() => {
              setOpen(false)
              onChange(null)
            }}
          />
        )}
        {SWATCHES.map((c) => (
          <button
            key={c}
            className={value === c ? 'swatch active' : 'swatch'}
            style={{ background: c }}
            aria-label={c}
            onClick={() => {
              setOpen(false)
              onChange(c)
            }}
          />
        ))}
        <button
          className={open ? 'swatch custom active' : 'swatch custom'}
          title={t('edit.customColor')}
          aria-label={t('edit.customColor')}
          onClick={() => setOpen((o) => !o)}
        />
        {open && (
          <ColorPopover
            value={value && /^#[0-9a-f]{6}$/i.test(value) ? value : '#2f45c4'}
            onChange={(v) => onChange(v)}
            onClose={() => setOpen(false)}
          />
        )}
      </div>
    </div>
  )
}
