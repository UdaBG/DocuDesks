import { create } from 'zustand'
import i18next, { matchLanguage, type LanguageCode } from './i18n'
import type { ExtraStamp, Placement, SavedSignature, SigDoc, SignMode } from './types'
import { effectivePlacement, resolvePageIndex, uid } from './types'
import { getPageCount } from './lib/pdf'
import { detectSignatureSpot } from './lib/smartDetect'
import { applyStamps, signedName, type StampInput } from './lib/pdfSign'
import { useEdit } from './editor/editStore'
import type { EditSession } from './editor/types'

export interface IncomingFile {
  name: string
  bytes: Uint8Array
  path?: string
}

interface SigningProgress {
  done: number
  total: number
}

interface SignResult {
  signed: number
  skipped: number
  dir: string
  firstPath?: string
  /** all files written in this run — for printing */
  paths: string[]
}

export type AppView = 'sign' | 'edit'

interface AppState {
  docs: SigDoc[]
  selectedDocId: string | null
  signatures: SavedSignature[]
  activeSignatureId: string | null
  mode: SignMode
  view: AppView
  placement: Placement
  previewPage: number
  detecting: boolean
  /** which stamp on the preview is selected: 'primary', an extra stamp id, or none */
  selectedStampId: string | null
  /** stack-wide extra stamps — placed once, applied to every document */
  extraStamps: ExtraStamp[]
  /** the bulk/primary stamp was removed from the whole stack */
  primaryRemoved: boolean
  /** last removal, restorable via the toast or Ctrl+Z */
  undoStash: {
    entries: { doc: SigDoc; index: number }[]
    sessions: Record<string, EditSession>
    extraStamps?: ExtraStamp[]
    primaryRemoved?: boolean
  } | null
  signing: SigningProgress | null
  result: SignResult | null
  studioOpen: boolean
  language: LanguageCode

  init(): Promise<void>
  setView(view: AppView): void
  duplicateDoc(id: string): void
  addGeneratedDoc(name: string, bytes: Uint8Array, pageCount: number): void
  replaceDocBytes(id: string, bytes: Uint8Array, pageCount: number): void
  addFiles(files: IncomingFile[]): Promise<void>
  addFromPaths(paths: string[]): Promise<void>
  openFileDialog(): Promise<void>
  removeDoc(id: string): void
  clearDocs(): void
  /** undo the last document removal (single or clear-all) */
  restoreRemoved(): void
  dismissUndo(): void
  selectDoc(id: string): void
  setPreviewPage(page: number): void
  setMode(mode: SignMode): void
  updatePlacementBox(box: { x: number; yb: number; w: number; rot?: number; dropMaxH?: boolean }): void
  setPageAnchor(anchor: Placement['anchor'], pageIndex?: number): void
  addExtraStamp(box: { x: number; yb: number; w: number }): void
  updateExtraStamp(stampId: string, box: { x: number; yb: number; w: number; rot?: number; dropMaxH?: boolean }): void
  /** hide a stack-wide stamp on one document only */
  excludeStampForDoc(docId: string, stampId: string): void
  /** delete a stack-wide stamp from every document */
  removeExtraStampEverywhere(stampId: string): void
  disablePrimary(docId: string): void
  /** remove the bulk/primary stamp from every document */
  removePrimaryEverywhere(): void
  setSelectedStamp(id: string | null): void
  /** swap which saved signature an extra stamp uses (stack-wide) */
  updateExtraStampSignature(stampId: string, signatureId: string): void
  addSignature(sig: Omit<SavedSignature, 'id' | 'createdAt'>): void
  deleteSignature(id: string): void
  setActiveSignature(id: string): void
  openStudio(): void
  closeStudio(): void
  dismissResult(): void
  setLanguage(code: LanguageCode): Promise<void>
  signAll(): Promise<void>
  /** print the documents with their current stamps — nothing is saved */
  printAll(): Promise<void>
}

const DEFAULT_PLACEMENT: Placement = {
  anchor: 'last',
  pageIndex: 0,
  x: 0.56,
  yb: 0.88,
  w: 0.26,
}

export const useApp = create<AppState>((set, get) => ({
  docs: [],
  selectedDocId: null,
  signatures: [],
  activeSignatureId: null,
  mode: 'manual',
  view: 'sign',
  placement: DEFAULT_PLACEMENT,
  previewPage: 0,
  detecting: false,
  selectedStampId: null,
  extraStamps: [],
  primaryRemoved: false,
  undoStash: null,
  signing: null,
  result: null,
  studioOpen: false,
  language: 'en',

  async init() {
    const [saved, settings, locale, pending] = await Promise.all([
      window.signer.loadSignatures() as Promise<SavedSignature[]>,
      window.signer.loadSettings(),
      window.signer.getLocale(),
      window.signer.getPendingFiles(),
    ])
    const language = (settings.language as LanguageCode) || matchLanguage(locale)
    await i18next.changeLanguage(language)
    const signatures = Array.isArray(saved) ? saved : []
    set({
      signatures,
      activeSignatureId: signatures[0]?.id ?? null,
      language,
    })
    window.signer.onFilesOpened((paths) => void get().addFromPaths(paths))
    if (pending.length) await get().addFromPaths(pending)
  },

  setView(view) {
    set({ view })
  },

  duplicateDoc(id) {
    const doc = get().docs.find((d) => d.id === id)
    if (!doc) return
    const dot = doc.name.toLowerCase().lastIndexOf('.pdf')
    const stem = dot > 0 ? doc.name.slice(0, dot) : doc.name
    const copy: SigDoc = {
      ...doc,
      id: uid(),
      name: `${stem} (copy).pdf`,
      path: undefined,
      bytes: doc.bytes.slice(),
      rev: 0,
      status: doc.status === 'error' ? 'error' : 'ready',
      smart: doc.smart ? { ...doc.smart } : doc.smart,
      override: undefined,
      signedPath: undefined,
    }
    set((s) => {
      const at = s.docs.findIndex((d) => d.id === id)
      const docs = [...s.docs]
      docs.splice(at + 1, 0, copy)
      return { docs, selectedDocId: copy.id }
    })
  },

  addGeneratedDoc(name, bytes, pageCount) {
    const doc: SigDoc = { id: uid(), name, bytes, pageCount, rev: 0, status: 'ready' }
    set((s) => ({ docs: [...s.docs, doc], selectedDocId: doc.id }))
  },

  replaceDocBytes(id, bytes, pageCount) {
    set((s) => ({
      docs: s.docs.map((d) =>
        d.id === id
          ? {
              ...d,
              bytes,
              pageCount,
              rev: d.rev + 1,
              status: 'ready',
              smart: undefined, // detection must re-run on the new content
              override: undefined,
              signedPath: undefined,
            }
          : d,
      ),
    }))
    const doc = get().docs.find((d) => d.id === id)
    if (doc) set({ previewPage: Math.min(get().previewPage, doc.pageCount - 1) })
  },

  async addFiles(files) {
    const existing = new Set(get().docs.map((d) => d.path ?? d.name))
    const fresh = files.filter((f) => !existing.has(f.path ?? f.name))
    const added: SigDoc[] = []
    for (const f of fresh) {
      try {
        const pageCount = await getPageCount(f.bytes)
        added.push({
          id: uid(),
          name: f.name,
          path: f.path,
          bytes: f.bytes,
          pageCount,
          rev: 0,
          status: 'ready',
        })
      } catch {
        added.push({
          id: uid(),
          name: f.name,
          path: f.path,
          bytes: f.bytes,
          pageCount: 0,
          rev: 0,
          status: 'error',
          error: i18next.t('error.invalidPdf', { name: f.name }),
        })
      }
    }
    if (!added.length) return
    set((s) => ({
      docs: [...s.docs, ...added],
      selectedDocId: s.selectedDocId ?? added.find((d) => d.status !== 'error')?.id ?? null,
      result: null,
    }))
    const { selectedDocId, docs, mode, placement } = get()
    const sel = docs.find((d) => d.id === selectedDocId)
    if (sel) set({ previewPage: resolvePageIndex(placement, sel.pageCount) })
    if (mode === 'smart') await runDetection(set, get)
  },

  async addFromPaths(paths) {
    const files: IncomingFile[] = []
    for (const p of paths) {
      try {
        const bytes = await window.signer.readFile(p)
        files.push({ name: p.replace(/^.*[\\/]/, ''), bytes: new Uint8Array(bytes), path: p })
      } catch {
        // unreadable path — skip silently, the OS dialog already validated most cases
      }
    }
    if (files.length) await get().addFiles(files)
  },

  async openFileDialog() {
    const paths = await window.signer.openPdfDialog()
    if (paths.length) await get().addFromPaths(paths)
  },

  removeDoc(id) {
    const state = get()
    const index = state.docs.findIndex((d) => d.id === id)
    if (index < 0) return
    const doc = state.docs[index]
    const session = useEdit.getState().sessions[id]
    useEdit.getState().dropSession(id)
    set((s) => {
      const docs = s.docs.filter((d) => d.id !== id)
      const selectedDocId =
        s.selectedDocId === id ? (docs.find((d) => d.status !== 'error')?.id ?? null) : s.selectedDocId
      return {
        docs,
        selectedDocId,
        undoStash: { entries: [{ doc, index }], sessions: session ? { [id]: session } : {} },
      }
    })
  },

  clearDocs() {
    const state = get()
    if (!state.docs.length) return
    const sessions: Record<string, EditSession> = {}
    for (const d of state.docs) {
      const session = useEdit.getState().sessions[d.id]
      if (session) sessions[d.id] = session
      useEdit.getState().dropSession(d.id)
    }
    set((s) => ({
      docs: [],
      selectedDocId: null,
      previewPage: 0,
      result: null,
      extraStamps: [],
      selectedStampId: null,
      primaryRemoved: false,
      undoStash: {
        entries: s.docs.map((doc, index) => ({ doc, index })),
        sessions,
        extraStamps: s.extraStamps,
        primaryRemoved: s.primaryRemoved,
      },
    }))
  },

  restoreRemoved() {
    const stash = get().undoStash
    if (!stash) return
    set((s) => {
      const docs = [...s.docs]
      for (const { doc, index } of [...stash.entries].sort((a, b) => a.index - b.index)) {
        docs.splice(Math.min(index, docs.length), 0, doc)
      }
      return {
        docs,
        undoStash: null,
        selectedDocId: s.selectedDocId ?? stash.entries[0]?.doc.id ?? null,
        ...(stash.extraStamps ? { extraStamps: stash.extraStamps } : {}),
        ...(stash.primaryRemoved !== undefined ? { primaryRemoved: stash.primaryRemoved } : {}),
      }
    })
    for (const [docId, session] of Object.entries(stash.sessions)) {
      useEdit.getState().restoreSession(docId, session)
    }
  },

  dismissUndo() {
    set({ undoStash: null })
  },

  selectDoc(id) {
    const { docs, mode, placement } = get()
    const doc = docs.find((d) => d.id === id)
    if (!doc) return
    const pl = effectivePlacement(doc, mode, placement)
    const page = pl ? resolvePageIndex(pl, doc.pageCount) : 0
    set({ selectedDocId: id, previewPage: page, selectedStampId: null })
  },

  setPreviewPage(page) {
    const doc = selectedDoc(get())
    if (!doc) return
    set({ previewPage: Math.max(0, Math.min(page, doc.pageCount - 1)) })
  },

  setMode(mode) {
    set({ mode })
    const doc = selectedDoc(get())
    if (doc) {
      const pl = effectivePlacement(doc, mode, get().placement)
      if (pl) set({ previewPage: resolvePageIndex(pl, doc.pageCount) })
    }
    if (mode === 'smart') void runDetection(set, get)
  },

  /** Called when the user drags/resizes the signature on the preview. */
  updatePlacementBox(box) {
    const { mode, previewPage } = get()
    const doc = selectedDoc(get())
    if (!doc) return
    const { dropMaxH, ...geom } = box
    if (mode === 'manual') {
      set((s) => {
        const anchor =
          previewPage === doc.pageCount - 1 ? 'last' : previewPage === 0 ? 'first' : 'custom'
        return {
          primaryRemoved: false,
          placement: {
            ...s.placement,
            ...geom,
            ...(dropMaxH ? { maxH: undefined } : {}),
            anchor,
            pageIndex: previewPage,
          },
          docs: s.docs.map((d) => (d.id === doc.id ? { ...d, primaryDisabled: false } : d)),
        }
      })
    } else {
      // Smart mode: correcting one document only.
      set((s) => {
        const current = effectivePlacement(doc, 'smart', s.placement)
        const override: Placement = {
          anchor: 'custom',
          pageIndex: previewPage,
          maxH: dropMaxH ? undefined : current?.maxH,
          ...geom,
        }
        return {
          primaryRemoved: false,
          docs: s.docs.map((d) =>
            d.id === doc.id ? { ...d, override, status: 'ready', primaryDisabled: false } : d,
          ),
        }
      })
    }
  },

  addExtraStamp(box) {
    const { activeSignatureId, previewPage } = get()
    const doc = selectedDoc(get())
    if (!doc || !activeSignatureId) return
    // placing on a document's last/first page means "last/first page" for the
    // whole stack, so documents with other page counts behave sensibly
    const anchor =
      previewPage === doc.pageCount - 1 ? 'last' : previewPage === 0 ? 'first' : 'custom'
    const stamp: ExtraStamp = {
      id: uid(),
      signatureId: activeSignatureId,
      placement: { anchor, pageIndex: previewPage, ...box },
    }
    set((s) => ({
      // deselected on purpose: picking another signature next must not swap this one
      selectedStampId: null,
      extraStamps: [...s.extraStamps, stamp],
      docs: s.docs.map((d) => (d.status === 'no-target' ? { ...d, status: 'ready' } : d)),
    }))
  },

  updateExtraStamp(stampId, box) {
    const { dropMaxH, ...geom } = box
    set((s) => ({
      extraStamps: s.extraStamps.map((st) =>
        st.id === stampId
          ? {
              ...st,
              placement: { ...st.placement, ...geom, ...(dropMaxH ? { maxH: undefined } : {}) },
            }
          : st,
      ),
    }))
  },

  excludeStampForDoc(docId, stampId) {
    set((s) => ({
      selectedStampId: s.selectedStampId === stampId ? null : s.selectedStampId,
      docs: s.docs.map((d) =>
        d.id === docId
          ? { ...d, excludedStamps: [...(d.excludedStamps ?? []), stampId] }
          : d,
      ),
    }))
  },

  removeExtraStampEverywhere(stampId) {
    set((s) => ({
      selectedStampId: s.selectedStampId === stampId ? null : s.selectedStampId,
      extraStamps: s.extraStamps.filter((st) => st.id !== stampId),
      docs: s.docs.map((d) =>
        d.excludedStamps?.includes(stampId)
          ? { ...d, excludedStamps: d.excludedStamps.filter((id) => id !== stampId) }
          : d,
      ),
    }))
  },

  disablePrimary(docId) {
    set((s) => ({
      selectedStampId: s.selectedStampId === 'primary' ? null : s.selectedStampId,
      docs: s.docs.map((d) => (d.id === docId ? { ...d, primaryDisabled: true } : d)),
    }))
  },

  removePrimaryEverywhere() {
    set((s) => ({
      primaryRemoved: true,
      selectedStampId: s.selectedStampId === 'primary' ? null : s.selectedStampId,
      docs: s.docs.map((d) => (d.primaryDisabled ? { ...d, primaryDisabled: false } : d)),
    }))
  },

  setSelectedStamp(id) {
    set({ selectedStampId: id })
  },

  updateExtraStampSignature(stampId, signatureId) {
    set((s) => ({
      extraStamps: s.extraStamps.map((st) => (st.id === stampId ? { ...st, signatureId } : st)),
    }))
  },

  setPageAnchor(anchor, pageIndex) {
    set((s) => ({
      placement: { ...s.placement, anchor, pageIndex: pageIndex ?? s.placement.pageIndex },
    }))
    const doc = selectedDoc(get())
    if (doc && get().mode === 'manual') {
      set({ previewPage: resolvePageIndex(get().placement, doc.pageCount) })
    }
  },

  addSignature(sig) {
    const full: SavedSignature = { ...sig, id: uid(), createdAt: Date.now() }
    set((s) => ({ signatures: [full, ...s.signatures], activeSignatureId: full.id }))
    void window.signer.saveSignatures(get().signatures)
  },

  deleteSignature(id) {
    set((s) => {
      const signatures = s.signatures.filter((x) => x.id !== id)
      return {
        signatures,
        activeSignatureId:
          s.activeSignatureId === id ? (signatures[0]?.id ?? null) : s.activeSignatureId,
      }
    })
    void window.signer.saveSignatures(get().signatures)
  },

  setActiveSignature(id) {
    set({ activeSignatureId: id })
  },

  openStudio() {
    set({ studioOpen: true })
  },
  closeStudio() {
    set({ studioOpen: false })
  },
  dismissResult() {
    set({ result: null })
  },

  async setLanguage(code) {
    await i18next.changeLanguage(code)
    set({ language: code })
    const settings = await window.signer.loadSettings()
    await window.signer.saveSettings({ ...settings, language: code })
  },

  async signAll() {
    const { docs, mode, placement, signatures, activeSignatureId } = get()
    const activeSignature = signatures.find((s) => s.id === activeSignatureId)
    const targets = docs.filter((d) => d.status !== 'error')
    if (!targets.length) return

    const { extraStamps, primaryRemoved } = get()
    const stampsFor = (doc: SigDoc): StampInput[] =>
      buildStampsFor(doc, mode, placement, extraStamps, signatures, activeSignature, primaryRemoved)
    if (!targets.some((d) => stampsFor(d).length)) return

    const dir = await window.signer.chooseOutputDir()
    if (!dir) return

    set({ signing: { done: 0, total: targets.length }, result: null })
    let signed = 0
    let skipped = 0
    let firstPath: string | undefined
    const paths: string[] = []

    for (const doc of targets) {
      const stamps = stampsFor(doc)
      if (!stamps.length) {
        skipped++
        patchDoc(set, doc.id, { status: 'no-target' })
      } else {
        try {
          const out = await applyStamps(doc.bytes, stamps)
          const written = await window.signer.writeSigned(dir, signedName(doc.name), out)
          if (!written) {
            // user dismissed the per-file save dialog (mobile) — not an error
            skipped++
          } else {
            if (!firstPath) firstPath = written
            paths.push(written)
            signed++
            patchDoc(set, doc.id, { status: 'signed', signedPath: written })
          }
        } catch (e) {
          skipped++
          patchDoc(set, doc.id, { status: 'error', error: String(e) })
        }
      }
      set((s) => ({ signing: s.signing && { ...s.signing, done: s.signing.done + 1 } }))
      // Yield so the progress bar actually paints between documents.
      await new Promise((r) => setTimeout(r, 0))
    }

    set({ signing: null, result: { signed, skipped, dir, firstPath, paths } })
  },

  async printAll() {
    const { docs, mode, placement, signatures, activeSignatureId, extraStamps, primaryRemoved } = get()
    const activeSignature = signatures.find((s) => s.id === activeSignatureId)
    const targets = docs.filter((d) => d.status !== 'error')
    if (!targets.length) return

    set({ signing: { done: 0, total: targets.length } })
    try {
      for (const doc of targets) {
        const stamps = buildStampsFor(doc, mode, placement, extraStamps, signatures, activeSignature, primaryRemoved)
        const bytes = stamps.length ? await applyStamps(doc.bytes, stamps) : doc.bytes
        await window.signer.printPdfData(signedName(doc.name), bytes)
        set((s) => ({ signing: s.signing && { ...s.signing, done: s.signing.done + 1 } }))
        await new Promise((r) => setTimeout(r, 0))
      }
    } finally {
      set({ signing: null })
    }
  },
}))

function selectedDoc(s: { docs: SigDoc[]; selectedDocId: string | null }): SigDoc | undefined {
  return s.docs.find((d) => d.id === s.selectedDocId)
}

/** Every stamp a document receives: bulk primary + stack-wide extras, minus per-doc removals. */
function buildStampsFor(
  doc: SigDoc,
  mode: SignMode,
  placement: Placement,
  extraStamps: ExtraStamp[],
  signatures: SavedSignature[],
  activeSignature: SavedSignature | undefined,
  primaryRemoved: boolean,
): StampInput[] {
  const list: StampInput[] = []
  // the auto-detected stamp exists only in smart mode; manual stamps are all explicit
  const pl = mode === 'smart' ? effectivePlacement(doc, mode, placement) : null
  if (pl && !primaryRemoved && !doc.primaryDisabled && activeSignature) {
    list.push({ signature: activeSignature, placement: pl })
  }
  for (const stamp of extraStamps) {
    if (doc.excludedStamps?.includes(stamp.id)) continue
    const sig = signatures.find((s) => s.id === stamp.signatureId)
    if (sig) list.push({ signature: sig, placement: stamp.placement })
  }
  return list
}

function patchDoc(
  set: (fn: (s: AppState) => Partial<AppState>) => void,
  id: string,
  patch: Partial<SigDoc>,
) {
  set((s) => ({ docs: s.docs.map((d) => (d.id === id ? { ...d, ...patch } : d)) }))
}

/** Run smart detection for every document that has not been analysed yet. */
async function runDetection(
  set: (partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
) {
  if (get().detecting) return
  set({ detecting: true })
  try {
    for (;;) {
      const doc = get().docs.find((d) => d.status !== 'error' && d.smart === undefined)
      if (!doc) break
      let smart: Placement | null = null
      try {
        smart = await detectSignatureSpot(doc.bytes)
      } catch {
        smart = null
      }
      patchDoc(set, doc.id, {
        smart,
        status: smart || doc.override ? 'ready' : 'no-target',
      })
      if (doc.id === get().selectedDocId && smart) {
        set({ previewPage: resolvePageIndex(smart, doc.pageCount) })
      }
    }
  } finally {
    set({ detecting: false })
  }
}
