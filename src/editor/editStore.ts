import { create } from 'zustand'
import type { SigDoc } from '../types'
import { uid } from '../types'
import type { EditObj, EditSession, EditorStyle, PageRef, ToolId, Watermark } from './types'
import { snapshotOf } from './types'

const HISTORY_LIMIT = 60

function newSession(doc: SigDoc): EditSession {
  return {
    docId: doc.id,
    pages: Array.from({ length: Math.max(doc.pageCount, 1) }, (_, i) => ({
      id: uid(),
      src: { type: 'orig', index: i },
    })),
    objects: [],
    watermark: null,
    selectedId: null,
    editingId: null,
    pageIndex: 0,
    dims: {},
    undo: [],
    redo: [],
    dirty: false,
  }
}

interface EditState {
  sessions: Record<string, EditSession>
  tool: ToolId
  style: EditorStyle
  savedPath: string | null
  /** color-picker "sample from document" mode */
  sampling: boolean
  setSampling(v: boolean): void

  openSession(doc: SigDoc): void
  dropSession(docId: string): void
  /** bring back a stashed session (undoing a document removal) */
  restoreSession(docId: string, session: EditSession): void
  setTool(tool: ToolId): void
  setStyle(patch: Partial<EditorStyle>): void
  setSavedPath(path: string | null): void

  /** Push an undo snapshot — call once at the start of every user gesture. */
  pushHistory(docId: string): void
  undo(docId: string): void
  redo(docId: string): void

  addObject(docId: string, obj: EditObj): void
  updateObject(docId: string, id: string, patch: Partial<EditObj>): void
  removeObject(docId: string, id: string): void
  /** removal without a history entry — for the eraser, which snapshots once per gesture */
  removeObjectSilent(docId: string, id: string): void
  select(docId: string, id: string | null): void
  setEditing(docId: string, id: string | null): void

  setPageIndex(docId: string, index: number): void
  setDims(docId: string, pageId: string, wPt: number, hPt: number): void
  addBlankPage(docId: string, afterIndex: number): void
  duplicatePage(docId: string, index: number): void
  deletePage(docId: string, index: number): void
  movePage(docId: string, index: number, dir: -1 | 1): void
  /** drag-reorder: move the page at `from` so it ends up at index `to` */
  reorderPage(docId: string, from: number, to: number): void

  setWatermark(docId: string, wm: Watermark | null): void
}

export const useEdit = create<EditState>((set, get) => {
  function mutate(docId: string, fn: (s: EditSession) => Partial<EditSession>) {
    set((state) => {
      const s = state.sessions[docId]
      if (!s) return state
      return { sessions: { ...state.sessions, [docId]: { ...s, ...fn(s) } } }
    })
  }

  function withHistory(docId: string, fn: (s: EditSession) => Partial<EditSession>) {
    get().pushHistory(docId)
    mutate(docId, (s) => ({ ...fn(s), dirty: true }))
  }

  return {
    sessions: {},
    tool: 'select',
    style: {
      stroke: '#2f45c4',
      fill: null,
      strokeWidthPt: 2,
      dash: 'solid',
      opacity: 1,
      fontId: 'std:helvetica',
      fontSizePt: 14,
      textColor: '#1c1c1e',
      whiteoutFill: '#ffffff',
      pen: 'ball',
      bold: false,
      italic: false,
      underline: false,
      strike: false,
      highlight: null,
    },
    savedPath: null,
    sampling: false,
    setSampling: (sampling) => set({ sampling }),

    openSession(doc) {
      if (get().sessions[doc.id]) return
      set((state) => ({ sessions: { ...state.sessions, [doc.id]: newSession(doc) } }))
    },

    dropSession(docId) {
      set((state) => {
        const sessions = { ...state.sessions }
        delete sessions[docId]
        return { sessions }
      })
    },

    restoreSession(docId, session) {
      set((state) => ({ sessions: { ...state.sessions, [docId]: session } }))
    },

    setTool: (tool) => set({ tool }),
    setStyle: (patch) => set((s) => ({ style: { ...s.style, ...patch } })),
    setSavedPath: (savedPath) => set({ savedPath }),

    pushHistory(docId) {
      mutate(docId, (s) => ({
        undo: [...s.undo.slice(-HISTORY_LIMIT + 1), snapshotOf(s)],
        redo: [],
      }))
    },

    undo(docId) {
      mutate(docId, (s) => {
        const last = s.undo[s.undo.length - 1]
        if (!last) return {}
        return {
          undo: s.undo.slice(0, -1),
          redo: [...s.redo, snapshotOf(s)],
          pages: last.pages,
          objects: last.objects,
          watermark: last.watermark,
          selectedId: null,
          editingId: null,
          pageIndex: Math.min(s.pageIndex, last.pages.length - 1),
          dirty: true,
        }
      })
    },

    redo(docId) {
      mutate(docId, (s) => {
        const next = s.redo[s.redo.length - 1]
        if (!next) return {}
        return {
          redo: s.redo.slice(0, -1),
          undo: [...s.undo, snapshotOf(s)],
          pages: next.pages,
          objects: next.objects,
          watermark: next.watermark,
          selectedId: null,
          editingId: null,
          pageIndex: Math.min(s.pageIndex, next.pages.length - 1),
          dirty: true,
        }
      })
    },

    addObject(docId, obj) {
      mutate(docId, (s) => ({ objects: [...s.objects, obj], dirty: true }))
    },

    updateObject(docId, id, patch) {
      mutate(docId, (s) => ({
        objects: s.objects.map((o) => (o.id === id ? ({ ...o, ...patch } as EditObj) : o)),
        dirty: true,
      }))
    },

    removeObject(docId, id) {
      withHistory(docId, (s) => ({
        objects: s.objects.filter((o) => o.id !== id),
        selectedId: s.selectedId === id ? null : s.selectedId,
        editingId: s.editingId === id ? null : s.editingId,
      }))
    },

    removeObjectSilent(docId, id) {
      mutate(docId, (s) => ({
        objects: s.objects.filter((o) => o.id !== id),
        selectedId: s.selectedId === id ? null : s.selectedId,
        dirty: true,
      }))
    },

    select(docId, id) {
      mutate(docId, () => ({ selectedId: id }))
    },

    setEditing(docId, id) {
      mutate(docId, () => ({ editingId: id }))
    },

    setPageIndex(docId, index) {
      mutate(docId, (s) => ({
        pageIndex: Math.max(0, Math.min(index, s.pages.length - 1)),
        selectedId: null,
        editingId: null,
      }))
    },

    setDims(docId, pageId, wPt, hPt) {
      mutate(docId, (s) =>
        s.dims[pageId] ? {} : { dims: { ...s.dims, [pageId]: { wPt, hPt } } },
      )
    },

    addBlankPage(docId, afterIndex) {
      withHistory(docId, (s) => {
        // size ladder: a blank current page knows its own size; a rendered page
        // has measured dims; otherwise any measured page beats the A4 default
        const current = s.pages[afterIndex]
        const size =
          (current?.src.type === 'blank' ? current.src : undefined) ??
          (current ? s.dims[current.id] : undefined) ??
          Object.values(s.dims)[0] ?? { wPt: 595.28, hPt: 841.89 }
        const page: PageRef = {
          id: uid(),
          src: { type: 'blank', wPt: size.wPt, hPt: size.hPt },
        }
        const pages = [...s.pages]
        pages.splice(afterIndex + 1, 0, page)
        return {
          pages,
          pageIndex: afterIndex + 1,
          dims: { ...s.dims, [page.id]: { wPt: size.wPt, hPt: size.hPt } },
        }
      })
    },

    duplicatePage(docId, index) {
      withHistory(docId, (s) => {
        const orig = s.pages[index]
        if (!orig) return {}
        const copy: PageRef = { id: uid(), src: { ...orig.src } }
        const pages = [...s.pages]
        pages.splice(index + 1, 0, copy)
        // objects on the duplicated page are cloned too
        const clones = s.objects
          .filter((o) => o.pageId === orig.id)
          .map((o) => ({ ...structuredClone(o), id: uid(), pageId: copy.id }))
        const dims = s.dims[orig.id]
        return {
          pages,
          objects: [...s.objects, ...clones],
          pageIndex: index + 1,
          dims: dims ? { ...s.dims, [copy.id]: dims } : s.dims,
        }
      })
    },

    deletePage(docId, index) {
      withHistory(docId, (s) => {
        if (s.pages.length <= 1) return {}
        const removed = s.pages[index]
        const pages = s.pages.filter((_, i) => i !== index)
        return {
          pages,
          objects: s.objects.filter((o) => o.pageId !== removed.id),
          pageIndex: Math.min(index, pages.length - 1),
        }
      })
    },

    movePage(docId, index, dir) {
      withHistory(docId, (s) => {
        const target = index + dir
        if (target < 0 || target >= s.pages.length) return {}
        const pages = [...s.pages]
        const [page] = pages.splice(index, 1)
        pages.splice(target, 0, page)
        return { pages, pageIndex: target }
      })
    },

    reorderPage(docId, from, to) {
      withHistory(docId, (s) => {
        if (from === to || from < 0 || to < 0 || from >= s.pages.length || to >= s.pages.length) return {}
        const pages = [...s.pages]
        const [page] = pages.splice(from, 1)
        pages.splice(to, 0, page)
        return { pages, pageIndex: to }
      })
    },

    setWatermark(docId, wm) {
      withHistory(docId, () => ({ watermark: wm }))
    },
  }
})
