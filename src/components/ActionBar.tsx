import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../store'
import { useEdit } from '../editor/editStore'
import { buildEditedPdf } from '../editor/exportPdf'
import { getPageCount } from '../lib/pdf'
import { signedName } from '../lib/pdfSign'
import { CheckIcon, FolderIcon, NibIcon, PrinterIcon, RedoIcon, UndoIcon, WarnIcon } from './icons'

function editedName(original: string): string {
  return signedName(original).replace(/_signed\.pdf$/, '_edited.pdf')
}

function EditActionBar() {
  const { t } = useTranslation()
  const docs = useApp((s) => s.docs)
  const selectedDocId = useApp((s) => s.selectedDocId)
  const replaceDocBytes = useApp((s) => s.replaceDocBytes)
  const doc = docs.find((d) => d.id === selectedDocId)
  const session = useEdit((s) => (doc ? s.sessions[doc.id] : undefined))
  const undo = useEdit((s) => s.undo)
  const redo = useEdit((s) => s.redo)
  const dropSession = useEdit((s) => s.dropSession)
  const savedPath = useEdit((s) => s.savedPath)
  const setSavedPath = useEdit((s) => s.setSavedPath)
  const [busy, setBusy] = useState(false)

  const hasEdits =
    !!session &&
    (session.objects.length > 0 ||
      session.watermark !== null ||
      session.pages.some((p) => p.src.type === 'blank') ||
      session.pages.length !== (doc?.pageCount ?? 0))

  async function build(): Promise<Uint8Array | null> {
    if (!doc || !session) return null
    return buildEditedPdf(doc.bytes, session)
  }

  async function applyToStack() {
    if (!doc) return
    setBusy(true)
    try {
      const bytes = await build()
      if (!bytes) return
      const pageCount = await getPageCount(bytes)
      dropSession(doc.id)
      replaceDocBytes(doc.id, bytes, pageCount)
    } finally {
      setBusy(false)
    }
  }

  async function printCurrent() {
    if (!doc) return
    setBusy(true)
    try {
      const bytes = await build()
      if (bytes) await window.signer.printPdfData(editedName(doc.name), bytes)
    } finally {
      setBusy(false)
    }
  }

  async function saveCopy() {
    if (!doc) return
    setBusy(true)
    try {
      const bytes = await build()
      if (!bytes) return
      const dir = await window.signer.chooseOutputDir()
      if (!dir) return
      const path = await window.signer.writeSigned(dir, editedName(doc.name), bytes)
      setSavedPath(path)
    } finally {
      setBusy(false)
    }
  }

  return (
    <footer className="actionbar">
      <div className="ab-status">
        {doc && session && (
          <span className="muted">{t('docs.pages', { count: session.pages.length })}</span>
        )}
        {hasEdits && <span className="chip chip-amber">{t('edit.unsaved')}</span>}
        {savedPath && (
          <>
            <button
              className="ghost-btn"
              onClick={() =>
                window.signer.canRevealFiles ? window.signer.showItemInFolder(savedPath) : undefined
              }
              title={savedPath}
            >
              <FolderIcon size={13} />
              {t('edit.saved')}
            </button>
            {window.signer.canPrint && (
              <button
                className="ghost-btn"
                onClick={() => void window.signer.printFiles([savedPath])}
                title={savedPath}
              >
                <PrinterIcon size={13} />
                {t('result.print', { count: 1 })}
              </button>
            )}
          </>
        )}
      </div>
      <div className="ab-right">
        <button
          className="ghost-btn"
          disabled={!session || session.undo.length === 0}
          onClick={() => doc && undo(doc.id)}
        >
          <UndoIcon size={14} />
          {t('edit.undo')}
        </button>
        <button
          className="ghost-btn"
          disabled={!session || session.redo.length === 0}
          onClick={() => doc && redo(doc.id)}
        >
          <RedoIcon size={14} />
          {t('edit.redo')}
        </button>
        {window.signer.canPrint && (
          <button
            className="ghost-btn"
            disabled={!doc || !session || busy}
            title={t('action.printHint')}
            onClick={() => void printCurrent()}
          >
            <PrinterIcon size={14} />
            {t('result.print', { count: 1 })}
          </button>
        )}
        <button className="ghost-btn" disabled={!hasEdits || busy} onClick={() => void applyToStack()}>
          {t('edit.apply')}
        </button>
        <button className="btn-primary" disabled={!doc || !session || busy} onClick={() => void saveCopy()}>
          {busy ? '…' : t('edit.save')}
        </button>
      </div>
    </footer>
  )
}

export default function ActionBar() {
  const { t } = useTranslation()
  const view = useApp((s) => s.view)
  const docs = useApp((s) => s.docs)
  const signatures = useApp((s) => s.signatures)
  const activeSignatureId = useApp((s) => s.activeSignatureId)
  const signing = useApp((s) => s.signing)
  const detecting = useApp((s) => s.detecting)
  const signAll = useApp((s) => s.signAll)
  const printAll = useApp((s) => s.printAll)

  const signable = docs.filter((d) => d.status !== 'error').length
  const signedCount = docs.filter((d) => d.status === 'signed').length
  const noTarget = docs.filter((d) => d.status === 'no-target').length
  const extraStamps = useApp((s) => s.extraStamps)
  const primaryRemoved = useApp((s) => s.primaryRemoved)
  const mode = useApp((s) => s.mode)
  const hasAnySignature = signatures.length > 0
  const hasSig =
    (mode === 'smart' && !primaryRemoved && signatures.some((s) => s.id === activeSignatureId)) ||
    extraStamps.length > 0
  const blockReason = !signable
    ? t('action.noDocs')
    : !hasAnySignature
      ? t('action.noSig')
      : !hasSig
        ? t('sig.clickToPlace')
        : null

  if (view === 'edit') return <EditActionBar />

  return (
    <footer className="actionbar">
      <div className="ab-status">
        {docs.length > 0 && <span className="muted">{t('docs.count', { count: docs.length })}</span>}
        {signedCount > 0 && (
          <span className="chip chip-green">
            <CheckIcon size={11} />
            {signedCount}
          </span>
        )}
        {noTarget > 0 && (
          <span className="chip chip-amber">
            <WarnIcon size={11} />
            {noTarget}
          </span>
        )}
      </div>

      {signing ? (
        <div className="ab-progress">
          <span className="muted">{t('action.signing', { done: signing.done, total: signing.total })}</span>
          <div className="progress">
            <div style={{ width: `${(signing.done / Math.max(signing.total, 1)) * 100}%` }} />
          </div>
        </div>
      ) : (
        <div className="ab-right">
          {detecting ? (
            <span className="muted pulse">{t('action.detecting')}</span>
          ) : (
            blockReason && <span className="muted">{blockReason}</span>
          )}
          {window.signer.canPrint && (
            <button
              className="ghost-btn"
              disabled={!signable || detecting}
              title={t('action.printHint')}
              onClick={() => void printAll()}
            >
              <PrinterIcon size={14} />
              {t('result.print', { count: Math.max(signable, 1) })}
            </button>
          )}
          <button
            className="btn-primary btn-sign"
            disabled={!signable || !hasSig || detecting}
            onClick={() => void signAll()}
          >
            <NibIcon size={15} />
            {signable > 0 ? t('action.sign', { count: signable }) : t('action.signNone')}
          </button>
        </div>
      )}
    </footer>
  )
}
