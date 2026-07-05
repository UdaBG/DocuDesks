import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../../store'
import { mergePdfs } from '../../editor/exportPdf'
import { getPageCount } from '../../lib/pdf'
import { ChevronLeftIcon, ChevronRightIcon } from '../icons'

export default function MergeDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const docs = useApp((s) => s.docs).filter((d) => d.status !== 'error')
  const addGeneratedDoc = useApp((s) => s.addGeneratedDoc)
  const [order, setOrder] = useState<string[]>(docs.map((d) => d.id))
  const [checked, setChecked] = useState<Set<string>>(new Set(docs.map((d) => d.id)))
  const [busy, setBusy] = useState(false)

  const move = (id: string, dir: -1 | 1) => {
    setOrder((o) => {
      const i = o.indexOf(id)
      const j = i + dir
      if (j < 0 || j >= o.length) return o
      const next = [...o]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  const selectedCount = order.filter((id) => checked.has(id)).length

  async function merge() {
    setBusy(true)
    try {
      const sources = order
        .filter((id) => checked.has(id))
        .map((id) => docs.find((d) => d.id === id)!.bytes)
      const bytes = await mergePdfs(sources)
      const pageCount = await getPageCount(bytes)
      addGeneratedDoc(t('merge.resultName'), bytes, pageCount)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-veil" onClick={onClose}>
      <div className="modal dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2>{t('merge.title')}</h2>
        <p className="muted">{t('merge.hint')}</p>
        <ul className="merge-list">
          {order.map((id, i) => {
            const d = docs.find((x) => x.id === id)
            if (!d) return null
            return (
              <li key={id} className="merge-row">
                <label className="merge-pick">
                  <input
                    type="checkbox"
                    checked={checked.has(id)}
                    onChange={(e) => {
                      const next = new Set(checked)
                      if (e.target.checked) next.add(id)
                      else next.delete(id)
                      setChecked(next)
                    }}
                  />
                  <span className="merge-name" title={d.name}>
                    {i + 1}. {d.name}
                  </span>
                  <span className="muted">{t('docs.pages', { count: d.pageCount })}</span>
                </label>
                <button className="icon-btn" aria-label="up" disabled={i === 0} onClick={() => move(id, -1)}>
                  <ChevronLeftIcon size={13} className="rot90" />
                </button>
                <button className="icon-btn" aria-label="down" disabled={i === order.length - 1} onClick={() => move(id, 1)}>
                  <ChevronRightIcon size={13} className="rot90" />
                </button>
              </li>
            )
          })}
        </ul>
        <div className="dialog-actions">
          <div className="spacer" />
          <button className="ghost-btn" onClick={onClose}>
            {t('studio.cancel')}
          </button>
          <button className="btn-primary" disabled={selectedCount < 2 || busy} onClick={() => void merge()}>
            {t('merge.action', { count: selectedCount })}
          </button>
        </div>
      </div>
    </div>
  )
}
