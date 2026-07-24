import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../store'
import { LANGUAGES, type LanguageCode } from '../i18n'
import { isTauri } from '../platform/tauriApi'
import { InfoIcon, NibIcon, SparkIcon } from './icons'
import Attributions from './Attributions'

export default function TopBar() {
  const { t } = useTranslation()
  const [showLicenses, setShowLicenses] = useState(false)
  const mode = useApp((s) => s.mode)
  const setMode = useApp((s) => s.setMode)
  const view = useApp((s) => s.view)
  const setView = useApp((s) => s.setView)
  const language = useApp((s) => s.language)
  const setLanguage = useApp((s) => s.setLanguage)

  return (
    <header className="topbar">
      <div className="brand">
        <NibIcon size={20} className="brand-nib" />
        <span className="wordmark">DocuDesk</span>
        {isTauri() && <span className="lite-badge">LITE</span>}
      </div>

      <div className="mode-toggle view-toggle" role="group" aria-label="View">
        <button className={view === 'sign' ? 'seg active' : 'seg'} onClick={() => setView('sign')}>
          {t('view.sign')}
        </button>
        <button className={view === 'edit' ? 'seg active' : 'seg'} onClick={() => setView('edit')}>
          {t('view.edit')}
        </button>
      </div>

      {view === 'sign' && (
        <div className="mode-wrap">
          <div className="mode-toggle" role="group" aria-label="Signing mode">
            <button
              className={mode === 'manual' ? 'seg active' : 'seg'}
              onClick={() => setMode('manual')}
            >
              {t('mode.manual')}
            </button>
            <button
              className={mode === 'smart' ? 'seg active seg-smart' : 'seg seg-smart'}
              onClick={() => setMode('smart')}
            >
              <SparkIcon size={13} />
              {t('mode.smart')}
            </button>
          </div>
          <span className="mode-hint">
            {t(mode === 'manual' ? 'mode.hint.manual' : 'mode.hint.smart')}
          </span>
        </div>
      )}

      <label className="lang">
        <span className="visually-hidden">{t('language')}</span>
        <select
          value={language}
          onChange={(e) => void setLanguage(e.target.value as LanguageCode)}
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </label>

      <button
        className="icon-btn topbar-info"
        aria-label={t('licenses.title')}
        title={t('licenses.title')}
        onClick={() => setShowLicenses(true)}
      >
        <InfoIcon size={16} />
      </button>
      {showLicenses && <Attributions onClose={() => setShowLicenses(false)} />}
    </header>
  )
}
