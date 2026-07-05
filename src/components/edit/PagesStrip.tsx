import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useEdit } from '../../editor/editStore'
import type { EditSession } from '../../editor/types'
import { ChevronLeftIcon, ChevronRightIcon, CopyIcon, PagePlusIcon, TrashIcon } from '../icons'

const DRAG_THRESHOLD = 5

export default function PagesStrip({ session }: { session: EditSession }) {
  const { t } = useTranslation()
  const setPageIndex = useEdit((s) => s.setPageIndex)
  const addBlankPage = useEdit((s) => s.addBlankPage)
  const duplicatePage = useEdit((s) => s.duplicatePage)
  const deletePage = useEdit((s) => s.deletePage)
  const movePage = useEdit((s) => s.movePage)
  const reorderPage = useEdit((s) => s.reorderPage)
  const i = session.pageIndex

  const listRef = useRef<HTMLDivElement>(null)
  // the ref is the source of truth: pointer events outpace React renders
  const dragRef = useRef<{ from: number; startX: number; started: boolean; insertAt: number } | null>(null)
  const suppressClickRef = useRef(false)
  const [drag, setDrag] = useState<{ from: number; insertAt: number } | null>(null)

  /** insertion slot (0..n) for the given pointer x, from chip midpoints */
  function insertIndexAt(clientX: number): number {
    const chips = listRef.current ? (Array.from(listRef.current.children) as HTMLElement[]) : []
    let idx = 0
    for (const chip of chips) {
      const r = chip.getBoundingClientRect()
      if (clientX > r.left + r.width / 2) idx++
    }
    return idx
  }

  function onChipPointerDown(e: React.PointerEvent, index: number) {
    dragRef.current = { from: index, startX: e.clientX, started: false, insertAt: index }
    try {
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    } catch {
      /* synthetic or stale pointer */
    }
  }

  function onChipPointerMove(e: React.PointerEvent) {
    const d = dragRef.current
    if (!d) return
    if (!d.started && Math.abs(e.clientX - d.startX) > DRAG_THRESHOLD) d.started = true
    if (d.started) {
      d.insertAt = insertIndexAt(e.clientX)
      setDrag({ from: d.from, insertAt: d.insertAt })
    }
  }

  function onChipPointerUp() {
    const d = dragRef.current
    dragRef.current = null
    if (d?.started) {
      const to = d.insertAt > d.from ? d.insertAt - 1 : d.insertAt
      if (to !== d.from) reorderPage(session.docId, d.from, to)
      // the browser fires a click right after the drop — swallow it
      suppressClickRef.current = true
      setTimeout(() => (suppressClickRef.current = false), 0)
    }
    setDrag(null)
  }

  const dropIsNoop = drag ? drag.insertAt === drag.from || drag.insertAt === drag.from + 1 : true

  return (
    <div className="pages-strip">
      <div className="pages-list" ref={listRef}>
        {session.pages.map((p, idx) => {
          const cls = ['page-chip']
          if (idx === i) cls.push('active')
          if (drag && idx === drag.from) cls.push('dragging')
          if (drag && !dropIsNoop && idx === drag.insertAt) cls.push('drop-before')
          if (drag && !dropIsNoop && drag.insertAt === session.pages.length && idx === session.pages.length - 1)
            cls.push('drop-after')
          return (
            <button
              key={p.id}
              className={cls.join(' ')}
              title={p.src.type === 'blank' ? t('edit.blankPage') : undefined}
              onPointerDown={(e) => onChipPointerDown(e, idx)}
              onPointerMove={onChipPointerMove}
              onPointerUp={onChipPointerUp}
              onClick={() => {
                if (suppressClickRef.current) return
                setPageIndex(session.docId, idx)
              }}
            >
              {idx + 1}
              {p.src.type === 'blank' && <span className="page-chip-dot" />}
            </button>
          )
        })}
      </div>
      <div className="pages-actions">
        <button className="icon-btn" title={t('edit.addPage')} onClick={() => addBlankPage(session.docId, i)}>
          <PagePlusIcon size={15} />
        </button>
        <button className="icon-btn" title={t('edit.duplicatePage')} onClick={() => duplicatePage(session.docId, i)}>
          <CopyIcon size={14} />
        </button>
        <button
          className="icon-btn"
          title={t('edit.movePageLeft')}
          disabled={i === 0}
          onClick={() => movePage(session.docId, i, -1)}
        >
          <ChevronLeftIcon size={15} />
        </button>
        <button
          className="icon-btn"
          title={t('edit.movePageRight')}
          disabled={i >= session.pages.length - 1}
          onClick={() => movePage(session.docId, i, 1)}
        >
          <ChevronRightIcon size={15} />
        </button>
        <button
          className="icon-btn danger"
          title={t('edit.deletePage')}
          disabled={session.pages.length <= 1}
          onClick={() => deletePage(session.docId, i)}
        >
          <TrashIcon size={14} />
        </button>
      </div>
    </div>
  )
}
