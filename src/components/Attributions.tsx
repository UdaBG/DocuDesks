import { useTranslation } from 'react-i18next'
import { ATTRIBUTIONS, LICENSE_TEXTS } from '../lib/licenses'
import { CloseIcon } from './icons'

/** In-app third-party attributions + full license texts (OFL/Apache/MIT). */
export default function Attributions({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="modal-veil" onClick={onClose}>
      <div
        className="modal licenses"
        role="dialog"
        aria-modal="true"
        aria-label={t('licenses.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="studio-head">
          <h2>{t('licenses.title')}</h2>
          <button className="icon-btn" aria-label={t('studio.cancel')} onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        </div>
        <div className="licenses-body">
          <p className="muted">{t('licenses.intro')}</p>
          <ul className="lic-list">
            {ATTRIBUTIONS.map((a) => (
              <li key={a.name}>
                <span className="lic-name">{a.name}</span>
                <span className="lic-copy">{a.copyright}</span>
                <span className="lic-badge">{a.license}</span>
              </li>
            ))}
          </ul>
          {LICENSE_TEXTS.map((l) => (
            <details key={l.id} className="lic-text">
              <summary>{l.id}</summary>
              <pre>{l.text}</pre>
            </details>
          ))}
        </div>
      </div>
    </div>
  )
}
