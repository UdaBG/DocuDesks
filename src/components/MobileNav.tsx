import { useTranslation } from 'react-i18next'
import { useApp } from '../store'
import { useEdit } from '../editor/editStore'
import { CursorIcon, DocIcon, NibIcon, PenIcon, SquiggleIcon } from './icons'

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
  const view = useApp((s) => s.view)
  const selectedDocId = useApp((s) => s.selectedDocId)
  const editing = useEdit((s) =>
    view === 'edit' && selectedDocId ? (s.sessions[selectedDocId]?.editingId ?? null) : null,
  )

  // typing on a phone: yield the vertical space to the document
  if (editing) return null

  // the middle/right tabs change meaning with the view: stage + its options
  const tabs: { id: MobileTab; label: string; icon: React.ReactNode; badge?: number }[] = [
    { id: 'docs', label: t('docs.title'), icon: <DocIcon size={18} />, badge: docCount },
    view === 'edit'
      ? { id: 'sign', label: t('view.edit'), icon: <PenIcon size={18} /> }
      : { id: 'sign', label: t('tab.sign'), icon: <NibIcon size={18} /> },
    view === 'edit'
      ? { id: 'sigs', label: t('mobile.tools'), icon: <CursorIcon size={18} /> }
      : { id: 'sigs', label: t('sig.title'), icon: <SquiggleIcon size={18} />, badge: sigCount },
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
