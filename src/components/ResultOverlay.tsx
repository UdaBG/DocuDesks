import { useTranslation } from 'react-i18next'
import { useApp } from '../store'
import { CheckIcon, FolderIcon, PrinterIcon } from './icons'

export default function ResultOverlay() {
  const { t } = useTranslation()
  const result = useApp((s) => s.result)
  const dismissResult = useApp((s) => s.dismissResult)
  if (!result) return null

  return (
    <div className="modal-veil" onClick={dismissResult}>
      <div className="modal result-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="result-check">
          <CheckIcon size={26} />
        </div>
        <h2>{t('result.title', { count: result.signed })}</h2>
        {result.skipped > 0 && (
          <p className="muted">{t('result.skipped', { count: result.skipped })}</p>
        )}
        {window.signer.canRevealFiles && (
          // on mobile the user picked each spot themselves in the save dialog
          <p className="muted result-dir">{t('result.savedTo', { dir: result.dir })}</p>
        )}
        <div className="result-actions">
          {result.paths.length > 0 && window.signer.canPrint && (
            <button className="ghost-btn" onClick={() => void window.signer.printFiles(result.paths)}>
              <PrinterIcon size={14} />
              {t('result.print', { count: result.paths.length })}
            </button>
          )}
          {result.firstPath && window.signer.canRevealFiles && (
            <button
              className="ghost-btn"
              onClick={() => window.signer.showItemInFolder(result.firstPath!)}
            >
              <FolderIcon size={14} />
              {t('result.openFolder')}
            </button>
          )}
          <button className="btn-primary" onClick={dismissResult}>
            {t('result.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
