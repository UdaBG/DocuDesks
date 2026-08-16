import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../store'
import type { DateStamp } from '../types'
import { DATE_FONTS, DATE_FORMATS, formatDate, type DateFormatId } from '../lib/dateStamp'
import { ColorPopover } from './edit/ColorField'
import { TrashIcon } from './icons'

const QUICK_COLORS = ['#1c1c1e', '#26357c', '#2f45c4', '#17804d', '#b3261e']

/**
 * Style drawer for a selected date stamp (sign view): format, color, face,
 * remove. Slides in from the right like the phone edit tools; same layout on
 * desktop — a date stamp's options are few enough for one narrow panel.
 */
export default function DateStyleDrawer({ stamp, onClose }: { stamp: DateStamp; onClose: () => void }) {
  const { t, i18n } = useTranslation()
  const restyleDateStamp = useApp((s) => s.restyleDateStamp)
  const removeDateStampEverywhere = useApp((s) => s.removeDateStampEverywhere)
  const [mixerOpen, setMixerOpen] = useState(false)
  const today = new Date()

  return (
    <>
      <div className="drawer-veil" onClick={onClose} />
      <div className="date-drawer" role="dialog" aria-label={t('date.title')}>
        <div className="panel-head">
          <h2>{t('date.title')}</h2>
        </div>

        <h3 className="date-drawer-sub">{t('date.format')}</h3>
        <div className="date-formats">
          {DATE_FORMATS.map((f) => (
            <button
              key={f}
              className={f === stamp.format ? 'date-format active' : 'date-format'}
              onClick={() => void restyleDateStamp(stamp.id, { format: f })}
            >
              {formatDate(today, f, i18n.language)}
            </button>
          ))}
        </div>

        <h3 className="date-drawer-sub">{t('date.color')}</h3>
        <div className="date-colors">
          {QUICK_COLORS.map((c) => (
            <button
              key={c}
              className={c.toLowerCase() === stamp.color.toLowerCase() ? 'color-chip active' : 'color-chip'}
              style={{ background: c }}
              aria-label={c}
              onClick={() => void restyleDateStamp(stamp.id, { color: c })}
            />
          ))}
          <span className="date-mixer-anchor">
            <button
              className="color-chip color-chip-custom"
              aria-label={t('date.color')}
              onClick={() => setMixerOpen((v) => !v)}
            />
            {mixerOpen && (
              <ColorPopover
                value={/^#[0-9a-f]{6}$/i.test(stamp.color) ? stamp.color : '#1c1c1e'}
                onChange={(v) => void restyleDateStamp(stamp.id, { color: v })}
                onClose={() => setMixerOpen(false)}
              />
            )}
          </span>
        </div>

        <h3 className="date-drawer-sub">{t('date.font')}</h3>
        <div className="date-fonts">
          {DATE_FONTS.map((f) => (
            <button
              key={f.id}
              className={f.id === stamp.fontId ? 'date-font active' : 'date-font'}
              style={{ fontFamily: f.css, color: stamp.color }}
              onClick={() => void restyleDateStamp(stamp.id, { fontId: f.id })}
            >
              <span className="date-font-sample">
                {formatDate(today, stamp.format as DateFormatId, i18n.language)}
              </span>
              <span className="date-font-label">{t(f.labelKey)}</span>
            </button>
          ))}
        </div>

        <div className="spacer" />
        <button
          className="ghost-btn wide btn-danger-ghost"
          onClick={() => {
            removeDateStampEverywhere(stamp.id)
            onClose()
          }}
        >
          <TrashIcon size={14} />
          {t('date.remove')}
        </button>
      </div>
    </>
  )
}
