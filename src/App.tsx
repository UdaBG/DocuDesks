import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp, type IncomingFile } from './store'
import TopBar from './components/TopBar'
import DocumentList from './components/DocumentList'
import Stage from './components/Stage'
import RightPanel from './components/RightPanel'
import ActionBar from './components/ActionBar'
import SignatureStudio from './components/SignatureStudio'
import ResultOverlay from './components/ResultOverlay'
import MobileNav, { type MobileTab } from './components/MobileNav'
import EditStage from './components/edit/EditStage'
import EditPanel from './components/edit/EditPanel'

export default function App() {
  const { t } = useTranslation()
  const studioOpen = useApp((s) => s.studioOpen)
  const result = useApp((s) => s.result)
  const addFiles = useApp((s) => s.addFiles)
  const view = useApp((s) => s.view)
  const docCount = useApp((s) => s.docs.length)
  const undoStash = useApp((s) => s.undoStash)
  const restoreRemoved = useApp((s) => s.restoreRemoved)
  const dismissUndo = useApp((s) => s.dismissUndo)
  const [dragDepth, setDragDepth] = useState(0)
  const [mobileTab, setMobileTab] = useState<MobileTab>('docs')
  const [appError, setAppError] = useState<string | null>(null)

  // Production resilience: surface unexpected failures instead of dying
  // silently. Routine render cancellations and observer churn are ignored.
  useEffect(() => {
    const benign = /ResizeObserver loop|RenderingCancelled|AbortException|TransportDestroyed/
    const show = (msg: string) => {
      if (!benign.test(msg)) setAppError(msg.slice(0, 200))
    }
    const onError = (e: ErrorEvent) => show(e.message || 'Unknown error')
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason as { message?: string } | undefined
      show(String(r?.message ?? e.reason ?? 'Unknown error'))
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  useEffect(() => {
    if (!appError) return
    const timer = setTimeout(() => setAppError(null), 12000)
    return () => clearTimeout(timer)
  }, [appError])

  // removal toast auto-dismisses; Ctrl+Z restores while it is up (sign view —
  // the edit view has its own undo stack)
  useEffect(() => {
    if (!undoStash) return
    const timer = setTimeout(dismissUndo, 8000)
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).tagName === 'TEXTAREA' || (e.target as HTMLElement).tagName === 'INPUT'
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === 'z' &&
        !typing &&
        useApp.getState().view === 'sign'
      ) {
        e.preventDefault()
        restoreRemoved()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('keydown', onKey)
    }
  }, [undoStash, dismissUndo, restoreRemoved])

  // On a phone, adding the first documents moves you to the signing stage.
  const prevDocCount = useRef(docCount)
  useEffect(() => {
    if (prevDocCount.current === 0 && docCount > 0) setMobileTab('sign')
    prevDocCount.current = docCount
  }, [docCount])

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      setDragDepth(0)
      const incoming: IncomingFile[] = []
      for (const file of Array.from(e.dataTransfer.files)) {
        if (!file.name.toLowerCase().endsWith('.pdf')) continue
        let path: string | undefined
        try {
          path = window.signer.getPathForFile(file) || undefined
        } catch {
          path = undefined
        }
        incoming.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), path })
      }
      if (incoming.length) void addFiles(incoming)
    },
    [addFiles],
  )

  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDragEnter={(e) => {
        e.preventDefault()
        if (e.dataTransfer.types.includes('Files')) setDragDepth((d) => d + 1)
      }}
      onDragLeave={() => setDragDepth((d) => Math.max(0, d - 1))}
      onDrop={(e) => void onDrop(e)}
    >
      <TopBar />
      <div className="layout" data-tab={mobileTab} data-view={view}>
        <DocumentList />
        {view === 'edit' ? <EditStage /> : <Stage />}
        {view === 'edit' ? <EditPanel /> : <RightPanel />}
      </div>
      <ActionBar />
      <MobileNav tab={mobileTab} onChange={setMobileTab} />
      {studioOpen && <SignatureStudio />}
      {result && <ResultOverlay />}
      {dragDepth > 0 && (
        <div className="drop-veil">
          <div className="drop-veil-card">{t('stage.dropHint')}</div>
        </div>
      )}
      {appError && (
        <div className="undo-toast error-toast" role="alert">
          <span className="undo-toast-text">{t('error.unexpected', { message: appError })}</span>
          <button className="undo-toast-btn" onClick={() => setAppError(null)}>
            ✕
          </button>
        </div>
      )}
      {undoStash && (
        <div className="undo-toast" role="status">
          <span className="undo-toast-text">
            {undoStash.entries.length === 1
              ? t('undo.removed', { name: undoStash.entries[0].doc.name })
              : t('undo.cleared', { count: undoStash.entries.length })}
          </span>
          <button className="undo-toast-btn" onClick={restoreRemoved}>
            {t('undo.action')}
          </button>
        </div>
      )}
    </div>
  )
}
