import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useEdit } from '../../editor/editStore'
import type { Watermark } from '../../editor/types'
import { loadImage } from '../../lib/imageUtils'
import ColorField from './ColorField'

const DEFAULT: Watermark = {
  kind: 'text',
  text: '',
  sizePt: 56,
  color: '#bb3a30',
  scale: 0.4,
  opacity: 0.18,
  angleDeg: 35,
  tile: false,
}

/** Downscale + normalize the picked image to a PNG data URL. */
async function toWatermarkImage(file: File): Promise<Watermark['image']> {
  const img = await loadImage(file)
  const max = 1200
  const s = Math.min(1, max / Math.max(img.width, img.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.width * s))
  canvas.height = Math.max(1, Math.round(img.height * s))
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
  return { dataUrl: canvas.toDataURL('image/png'), w: canvas.width, h: canvas.height }
}

export default function WatermarkDialog({
  docId,
  current,
  onClose,
}: {
  docId: string
  current: Watermark | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const setWatermark = useEdit((s) => s.setWatermark)
  const [wm, setWm] = useState<Watermark>(current ?? DEFAULT)
  const fileRef = useRef<HTMLInputElement>(null)

  const valid = wm.kind === 'image' ? !!wm.image : !!wm.text.trim()

  return (
    <div className="modal-veil" onClick={onClose}>
      <div className="modal dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2>{t('edit.watermark')}</h2>

        <div className="mode-toggle wm-kind">
          <button
            className={wm.kind === 'text' ? 'seg active' : 'seg'}
            onClick={() => setWm({ ...wm, kind: 'text' })}
          >
            {t('wm.kind.text')}
          </button>
          <button
            className={wm.kind === 'image' ? 'seg active' : 'seg'}
            onClick={() => setWm({ ...wm, kind: 'image' })}
          >
            {t('wm.kind.image')}
          </button>
        </div>

        {wm.kind === 'text' ? (
          <>
            <label className="field">
              <span>{t('wm.text')}</span>
              <input
                type="text"
                autoFocus
                value={wm.text}
                placeholder={t('wm.placeholder')}
                onChange={(e) => setWm({ ...wm, text: e.target.value })}
              />
            </label>
            <label className="field">
              <span>
                {t('edit.fontSize')} — {wm.sizePt} pt
              </span>
              <input type="range" min={16} max={140} step={2} value={wm.sizePt}
                onChange={(e) => setWm({ ...wm, sizePt: Number(e.target.value) })} />
            </label>
            <ColorField label={t('wm.color')} value={wm.color} onChange={(v) => setWm({ ...wm, color: v ?? '#bb3a30' })} />
          </>
        ) : (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void toWatermarkImage(f).then((image) => setWm((w) => ({ ...w, image })))
              }}
            />
            <button className="ghost-btn wide wm-image-pick" onClick={() => fileRef.current?.click()}>
              {wm.image ? (
                <img src={wm.image.dataUrl} alt="" className="wm-image-preview" />
              ) : (
                t('wm.chooseImage')
              )}
            </button>
            <label className="field">
              <span>
                {t('wm.scale')} — {Math.round(wm.scale * 100)}%
              </span>
              <input type="range" min={0.1} max={0.9} step={0.02} value={wm.scale}
                onChange={(e) => setWm({ ...wm, scale: Number(e.target.value) })} />
            </label>
          </>
        )}

        <label className="field">
          <span>
            {t('edit.opacity')} — {Math.round(wm.opacity * 100)}%
          </span>
          <input type="range" min={0.04} max={0.9} step={0.02} value={wm.opacity}
            onChange={(e) => setWm({ ...wm, opacity: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>
            {t('wm.angle')} — {wm.angleDeg}°
          </span>
          <input type="range" min={-90} max={90} step={5} value={wm.angleDeg}
            onChange={(e) => setWm({ ...wm, angleDeg: Number(e.target.value) })} />
        </label>
        <label className="check-field">
          <input type="checkbox" checked={wm.tile} onChange={(e) => setWm({ ...wm, tile: e.target.checked })} />
          {t('wm.tile')}
        </label>

        <div className="dialog-actions">
          {current && (
            <button
              className="ghost-btn danger-btn"
              onClick={() => {
                setWatermark(docId, null)
                onClose()
              }}
            >
              {t('wm.remove')}
            </button>
          )}
          <div className="spacer" />
          <button className="ghost-btn" onClick={onClose}>
            {t('studio.cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={!valid}
            onClick={() => {
              setWatermark(docId, { ...wm, text: wm.text.trim() })
              onClose()
            }}
          >
            {t('wm.apply')}
          </button>
        </div>
      </div>
    </div>
  )
}
