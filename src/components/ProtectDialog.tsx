import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../store'

/**
 * Protect one or more documents with a password. Each saved copy is the
 * FINALIZED paper — edits, signatures and date stamps baked — encrypted
 * offline with the bundled qpdf. AES-256 unless the user needs a very old
 * reader to open it.
 */
export default function ProtectDialog({
  docIds,
  onClose,
}: {
  docIds: string[]
  onClose: () => void
}) {
  const { t } = useTranslation()
  const protectDocs = useApp((s) => s.protectDocs)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [bits, setBits] = useState<128 | 256>(256)
  const [busy, setBusy] = useState(false)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const mismatch = confirm.length > 0 && password !== confirm
  const ready = password.length > 0 && password === confirm && !busy

  async function run() {
    setBusy(true)
    setError(null)
    try {
      const { saved, firstName } = await protectDocs(docIds, password, bits)
      if (saved === 1 && firstName) setSavedMsg(t('protect.saved', { name: firstName }))
      else if (saved > 1) setSavedMsg(t('protect.savedMany', { count: saved }))
      // 0 = user dismissed the save dialog — keep this one open, no error
    } catch {
      setError(t('protect.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-veil" onClick={busy ? undefined : onClose}>
      <div
        className="modal dialog confirm-dialog"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{docIds.length > 1 ? t('protect.titleMany', { count: docIds.length }) : t('protect.title')}</h2>
        {savedMsg ? (
          <>
            <p className="muted">{savedMsg}</p>
            <div className="dialog-actions">
              <div className="spacer" />
              <button className="btn-primary" onClick={onClose}>
                {t('protect.done')}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted">{t('protect.body')}</p>
            <label className="protect-field">
              <span>{t('protect.password')}</span>
              <input
                type="password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label className="protect-field">
              <span>{t('protect.confirm')}</span>
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
            {mismatch && <p className="protect-error">{t('protect.mismatch')}</p>}
            {error && <p className="protect-error">{error}</p>}
            <div className="protect-strength" role="radiogroup" aria-label={t('protect.strength')}>
              <label>
                <input type="radio" checked={bits === 256} onChange={() => setBits(256)} />
                {t('protect.aes256')}
              </label>
              <label>
                <input type="radio" checked={bits === 128} onChange={() => setBits(128)} />
                {t('protect.aes128')}
              </label>
            </div>
            <div className="dialog-actions">
              <button className="ghost-btn" disabled={busy} onClick={onClose}>
                {t('studio.cancel')}
              </button>
              <div className="spacer" />
              <button className="btn-primary" disabled={!ready} onClick={() => void run()}>
                {busy ? t('protect.working') : t('protect.action')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
