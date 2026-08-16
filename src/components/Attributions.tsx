import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ATTRIBUTIONS, LICENSE_TEXTS } from '../lib/licenses'
import {
  BookIcon,
  CalendarIcon,
  CloseIcon,
  DocIcon,
  LockIcon,
  NibIcon,
  PagePlusIcon,
  RetypeIcon,
} from './icons'

/**
 * The info window: a how-to guide (default tab) and the open-source
 * attributions + license texts. Everything is offline, like the app.
 */
export default function Attributions({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'guide' | 'licenses'>('guide')

  const sections = [
    { icon: <DocIcon size={18} />, title: t('guide.docs.title'), body: t('guide.docs.body') },
    { icon: <BookIcon size={18} />, title: t('guide.views.title'), body: t('guide.views.body') },
    { icon: <NibIcon size={18} />, title: t('guide.sign.title'), body: t('guide.sign.body') },
    { icon: <CalendarIcon size={18} />, title: t('guide.date.title'), body: t('guide.date.body') },
    { icon: <RetypeIcon size={18} />, title: t('guide.edit.title'), body: t('guide.edit.body') },
    { icon: <PagePlusIcon size={18} />, title: t('guide.pages.title'), body: t('guide.pages.body') },
    { icon: <LockIcon size={18} />, title: t('guide.save.title'), body: t('guide.save.body') },
  ]

  return (
    <div className="modal-veil" onClick={onClose}>
      <div
        className="modal licenses"
        role="dialog"
        aria-modal="true"
        aria-label={t('guide.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="studio-head">
          <h2>{t('guide.title')}</h2>
          <button className="icon-btn" aria-label={t('studio.cancel')} onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        </div>
        <div className="mode-toggle guide-tabs" role="tablist">
          <button
            className={tab === 'guide' ? 'seg active' : 'seg'}
            role="tab"
            aria-selected={tab === 'guide'}
            onClick={() => setTab('guide')}
          >
            {t('guide.tabGuide')}
          </button>
          <button
            className={tab === 'licenses' ? 'seg active' : 'seg'}
            role="tab"
            aria-selected={tab === 'licenses'}
            onClick={() => setTab('licenses')}
          >
            {t('guide.tabLicenses')}
          </button>
        </div>
        {tab === 'guide' ? (
          <div className="licenses-body guide-body">
            {sections.map((s) => (
              <section key={s.title} className="guide-sec">
                <span className="guide-icon">{s.icon}</span>
                <div>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                </div>
              </section>
            ))}
          </div>
        ) : (
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
        )}
      </div>
    </div>
  )
}
