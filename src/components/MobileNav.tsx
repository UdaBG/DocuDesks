import { useTranslation } from 'react-i18next'
import { useApp } from '../store'
import { DocIcon, NibIcon, SquiggleIcon } from './icons'

export type MobileTab = 'docs' | 'sign' | 'sigs'

export default function MobileNav({
  tab,
  onChange,
}: {
  tab: MobileTab
  onChange: (t: MobileTab) => void
}) {
  const { t } = useTranslation()
  const docCount = useApp((s) => s.docs.length)
  const sigCount = useApp((s) => s.signatures.length)

  const tabs: { id: MobileTab; label: string; icon: React.ReactNode; badge?: number }[] = [
    { id: 'docs', label: t('docs.title'), icon: <DocIcon size={18} />, badge: docCount },
    { id: 'sign', label: t('tab.sign'), icon: <NibIcon size={18} /> },
    { id: 'sigs', label: t('sig.title'), icon: <SquiggleIcon size={18} />, badge: sigCount },
  ]

  return (
    <nav className="mobile-nav">
      {tabs.map(({ id, label, icon, badge }) => (
        <button
          key={id}
          className={tab === id ? 'mobile-tab active' : 'mobile-tab'}
          aria-current={tab === id}
          onClick={() => onChange(id)}
        >
          <span className="mobile-tab-icon">
            {icon}
            {badge ? <span className="mobile-tab-badge">{badge}</span> : null}
          </span>
          {label}
        </button>
      ))}
    </nav>
  )
}
