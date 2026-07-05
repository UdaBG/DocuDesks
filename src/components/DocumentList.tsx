import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../store'
import type { SigDoc } from '../types'
import { CheckIcon, CloseIcon, CopyIcon, DocIcon, MergeIcon, PlusIcon, WarnIcon } from './icons'
import MergeDialog from './edit/MergeDialog'

function StatusDot({ doc }: { doc: SigDoc }) {
  if (doc.status === 'signed') return <span className="dot dot-green"><CheckIcon size={11} /></span>
  if (doc.status === 'no-target') return <span className="dot dot-amber"><WarnIcon size={11} /></span>
  if (doc.status === 'error') return <span className="dot dot-red"><CloseIcon size={11} /></span>
  return <span className="dot dot-neutral"><DocIcon size={11} /></span>
}

export default function DocumentList() {
  const { t } = useTranslation()
  const docs = useApp((s) => s.docs)
  const selectedDocId = useApp((s) => s.selectedDocId)
  const selectDoc = useApp((s) => s.selectDoc)
  const removeDoc = useApp((s) => s.removeDoc)
  const clearDocs = useApp((s) => s.clearDocs)
  const openFileDialog = useApp((s) => s.openFileDialog)
  const duplicateDoc = useApp((s) => s.duplicateDoc)
  const [mergeOpen, setMergeOpen] = useState(false)
  const mergeable = docs.filter((d) => d.status !== 'error').length

  return (
    <aside className="panel docs-panel">
      <div className="panel-head">
        <h2>{t('docs.title')}</h2>
        {docs.length > 0 && <span className="count-chip">{docs.length}</span>}
        <div className="spacer" />
        {docs.length > 0 && (
          <button className="ghost-btn" onClick={clearDocs}>
            {t('docs.clear')}
          </button>
        )}
      </div>
      <button className="add-btn" onClick={() => void openFileDialog()}>
        <PlusIcon size={15} />
        {t('docs.add')}
      </button>
      {mergeable >= 2 && (
        <button className="ghost-btn wide" onClick={() => setMergeOpen(true)}>
          <MergeIcon size={14} />
          {t('edit.merge')}
        </button>
      )}
      <ul className="doc-list">
        {docs.map((d) => (
          <li key={d.id} className={d.id === selectedDocId ? 'doc-item selected' : 'doc-item'}>
            <button className="doc-main" onClick={() => selectDoc(d.id)} title={d.name}>
              <StatusDot doc={d} />
              <span className="doc-text">
                <span className="doc-name">{d.name}</span>
                <span className="doc-meta">
                  {d.status === 'error'
                    ? t('docs.status.error')
                    : d.status === 'signed'
                      ? t('docs.status.signed')
                      : d.status === 'no-target'
                        ? t('docs.status.noTarget')
                        : t('docs.pages', { count: d.pageCount })}
                  {d.encrypted && (
                    <span className="chip chip-amber doc-protected" title={t('stage.encrypted')}>
                      {t('docs.protected')}
                    </span>
                  )}
                </span>
              </span>
            </button>
            <button
              className="doc-remove doc-dup"
              aria-label={t('docs.duplicate')}
              title={t('docs.duplicate')}
              onClick={() => duplicateDoc(d.id)}
            >
              <CopyIcon size={12} />
            </button>
            <button
              className="doc-remove"
              aria-label={t('docs.remove')}
              onClick={() => removeDoc(d.id)}
            >
              <CloseIcon size={12} />
            </button>
          </li>
        ))}
      </ul>
      {mergeOpen && <MergeDialog onClose={() => setMergeOpen(false)} />}
    </aside>
  )
}
