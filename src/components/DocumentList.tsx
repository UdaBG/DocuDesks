import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../store'
import type { SigDoc } from '../types'
import { CheckIcon, CloseIcon, CopyIcon, DocIcon, InfoIcon, LockIcon, MergeIcon, PlusIcon, TrashIcon, WarnIcon } from './icons'
import MergeDialog from './edit/MergeDialog'
import ProtectDialog from './ProtectDialog'
import Attributions from './Attributions'
import { useMediaQuery } from '../lib/useMediaQuery'

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
  const removeDocs = useApp((s) => s.removeDocs)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [showLicenses, setShowLicenses] = useState(false)
  const [protectIds, setProtectIds] = useState<string[] | null>(null)

  // multi-select: hold a document (or right-click) to start selecting; the
  // header then offers select-all and the bulk actions
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const holdRef = useRef<{ id: string; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  const clearHold = () => {
    if (holdRef.current) clearTimeout(holdRef.current.timer)
    holdRef.current = null
  }
  const startSelection = (id: string) => {
    setSelecting(true)
    setSelected([id])
  }
  const exitSelection = () => {
    setSelecting(false)
    setSelected([])
  }
  const toggle = (id: string) =>
    setSelected((sel) => (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]))
  const mergeable = docs.filter((d) => d.status !== 'error').length
  // phones hide the top bar's licenses button (no room at 360dp) — it lives
  // here in the Documents panel head instead
  const narrow = useMediaQuery('(max-width: 760px)')

  return (
    <aside className="panel docs-panel">
      {selecting ? (
        <div className="panel-head">
          <h2>{t('docs.selected', { count: selected.length })}</h2>
          <div className="spacer" />
          <button
            className="ghost-btn"
            onClick={() =>
              setSelected(selected.length === docs.length ? [] : docs.map((d) => d.id))
            }
          >
            {t('docs.selectAll')}
          </button>
          <button className="icon-btn" aria-label={t('studio.cancel')} onClick={exitSelection}>
            <CloseIcon size={15} />
          </button>
        </div>
      ) : (
        <div className="panel-head">
          <h2>{t('docs.title')}</h2>
          {docs.length > 0 && <span className="count-chip">{docs.length}</span>}
          <div className="spacer" />
          {docs.length > 0 && (
            <button className="ghost-btn" onClick={clearDocs}>
              {t('docs.clear')}
            </button>
          )}
          {narrow && (
            <button
              className="icon-btn"
              aria-label={t('licenses.title')}
              title={t('licenses.title')}
              onClick={() => setShowLicenses(true)}
            >
              <InfoIcon size={15} />
            </button>
          )}
        </div>
      )}
      {selecting && (
        <div className="bulk-actions">
          <button
            className="ghost-btn"
            disabled={!selected.some((id) => docs.find((d) => d.id === id)?.status !== 'error')}
            onClick={() => setProtectIds(selected)}
          >
            <LockIcon size={13} />
            {t('protect.section')}
          </button>
          <button
            className="ghost-btn"
            disabled={!selected.length}
            onClick={() => {
              selected.forEach((id) => duplicateDoc(id))
              exitSelection()
            }}
          >
            <CopyIcon size={13} />
            {t('docs.duplicate')}
          </button>
          <button
            className="ghost-btn btn-danger-ghost"
            disabled={!selected.length}
            onClick={() => {
              removeDocs(selected)
              exitSelection()
            }}
          >
            <TrashIcon size={13} />
            {t('docs.remove')}
          </button>
        </div>
      )}
      {showLicenses && <Attributions onClose={() => setShowLicenses(false)} />}
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
          <li key={d.id} className={d.id === selectedDocId && !selecting ? 'doc-item selected' : 'doc-item'}>
            <button
              className="doc-main"
              title={d.name}
              onClick={() => (selecting ? toggle(d.id) : selectDoc(d.id))}
              // hold to start selecting (right-click works on desktop too)
              onPointerDown={(e) => {
                if (selecting || e.button !== 0) return
                clearHold()
                holdRef.current = {
                  id: d.id,
                  x: e.clientX,
                  y: e.clientY,
                  timer: setTimeout(() => {
                    holdRef.current = null
                    startSelection(d.id)
                  }, 450),
                }
              }}
              onPointerMove={(e) => {
                const h = holdRef.current
                if (h && Math.hypot(e.clientX - h.x, e.clientY - h.y) > 8) clearHold()
              }}
              onPointerUp={clearHold}
              onPointerLeave={clearHold}
              onPointerCancel={clearHold}
              onContextMenu={(e) => {
                e.preventDefault()
                if (!selecting) startSelection(d.id)
              }}
            >
              {selecting && (
                <span className={selected.includes(d.id) ? 'doc-check on' : 'doc-check'}>
                  {selected.includes(d.id) && <CheckIcon size={11} />}
                </span>
              )}
              <StatusDot doc={d} />
              <span className="doc-text">
                <span className="doc-name">{d.name}</span>
                <span className="doc-meta">
                  {d.status === 'error'
                    ? d.locked
                      ? t('locked.badge')
                      : t('docs.status.error')
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
            {!selecting && (
              <>
                <button
                  className="doc-remove doc-dup"
                  aria-label={t('docs.duplicate')}
                  title={t('docs.duplicate')}
                  onClick={() => duplicateDoc(d.id)}
                >
                  <CopyIcon size={12} />
                </button>
                {d.status !== 'error' && (
                  <button
                    className="doc-remove doc-dup"
                    aria-label={t('protect.button')}
                    title={t('protect.button')}
                    onClick={() => setProtectIds([d.id])}
                  >
                    <LockIcon size={12} />
                  </button>
                )}
                <button
                  className="doc-remove"
                  aria-label={t('docs.remove')}
                  onClick={() => removeDoc(d.id)}
                >
                  <CloseIcon size={12} />
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {mergeOpen && <MergeDialog onClose={() => setMergeOpen(false)} />}
      {protectIds && (
        <ProtectDialog
          docIds={protectIds}
          onClose={() => {
            setProtectIds(null)
            exitSelection()
          }}
        />
      )}
    </aside>
  )
}
