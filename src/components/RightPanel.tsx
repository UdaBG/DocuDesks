import { useTranslation } from 'react-i18next'
import { useApp } from '../store'
import { effectivePlacement } from '../types'
import { CheckIcon, PlusIcon, TrashIcon } from './icons'

export default function RightPanel() {
  const { t } = useTranslation()
  const docs = useApp((s) => s.docs)
  const selectedDocId = useApp((s) => s.selectedDocId)
  const mode = useApp((s) => s.mode)
  const placement = useApp((s) => s.placement)
  const signatures = useApp((s) => s.signatures)
  const activeSignatureId = useApp((s) => s.activeSignatureId)
  const setActiveSignature = useApp((s) => s.setActiveSignature)
  const deleteSignature = useApp((s) => s.deleteSignature)
  const openStudio = useApp((s) => s.openStudio)
  const updatePlacementBox = useApp((s) => s.updatePlacementBox)
  const updateExtraStamp = useApp((s) => s.updateExtraStamp)
  const selectedStampId = useApp((s) => s.selectedStampId)
  const updateExtraStampSignature = useApp((s) => s.updateExtraStampSignature)
  const extraStamps = useApp((s) => s.extraStamps)

  const doc = docs.find((d) => d.id === selectedDocId)
  const pl = doc ? effectivePlacement(doc, mode, placement) : mode === 'manual' ? placement : null

  // an extra stamp is selected on the paper: signature clicks re-assign it
  const selectedExtra =
    selectedStampId && selectedStampId !== 'primary'
      ? extraStamps.find((st) => st.id === selectedStampId) ?? null
      : null

  function onSignatureClick(sigId: string) {
    if (selectedExtra) updateExtraStampSignature(selectedExtra.id, sigId)
    else setActiveSignature(sigId)
  }

  const onSize = (w: number) => {
    if (!pl) return
    updatePlacementBox({ x: Math.min(pl.x, 1 - w), yb: pl.yb, w })
  }

  return (
    <aside className="panel right-panel">
      <section>
        <div className="panel-head">
          <h2>{t('sig.title')}</h2>
        </div>
        <div className="sig-grid">
          {signatures.map((sig) => (
            <div
              key={sig.id}
              className={[
                'sig-card',
                sig.id === activeSignatureId && !selectedExtra ? 'active' : '',
                selectedExtra && sig.id === selectedExtra.signatureId ? 'linked' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <button className="sig-pick" onClick={() => onSignatureClick(sig.id)} title={sig.name}>
                <img src={sig.dataUrl} alt={sig.name} />
              </button>
              <span className="sig-name" title={sig.name}>
                {sig.name}
              </span>
              {sig.id === activeSignatureId && (
                <span className="sig-check">
                  <CheckIcon size={11} />
                </span>
              )}
              <button
                className="sig-del"
                aria-label={t('sig.delete')}
                onClick={() => deleteSignature(sig.id)}
              >
                <TrashIcon size={13} />
              </button>
            </div>
          ))}
          <button className="sig-new" onClick={openStudio}>
            <PlusIcon size={15} />
            {t('sig.new')}
          </button>
        </div>
        {!signatures.length && <p className="muted">{t('sig.empty')}</p>}
        {selectedExtra && <p className="muted">{t('sig.linkedHint')}</p>}
      </section>

      <section>
        <div className="panel-head">
          <h2>{t('placement.title')}</h2>
        </div>
        {mode === 'smart' ? (
          <>
            <label className="field">
              <span>{t('placement.size')}</span>
              <input
                type="range"
                min={0.08}
                max={0.6}
                step={0.01}
                value={pl?.w ?? placement.w}
                disabled={!pl || !doc}
                onChange={(e) => onSize(Number(e.target.value))}
              />
            </label>
            <p className="muted">{t('placement.smartNote')}</p>
          </>
        ) : selectedExtra ? (
          <>
            <label className="field">
              <span>{t('placement.size')}</span>
              <input
                type="range"
                min={0.08}
                max={0.6}
                step={0.01}
                value={selectedExtra.placement.w}
                onChange={(e) => {
                  const w = Number(e.target.value)
                  updateExtraStamp(selectedExtra.id, {
                    x: Math.min(selectedExtra.placement.x, 1 - w),
                    yb: selectedExtra.placement.yb,
                    w,
                  })
                }}
              />
            </label>
            <p className="muted">{t('placement.appliesAll')}</p>
          </>
        ) : (
          <p className="muted">{t('sig.clickToPlace')}</p>
        )}
      </section>
    </aside>
  )
}
