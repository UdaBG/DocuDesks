import React from 'react'
import { createRoot } from 'react-dom/client'
import './i18n'
import '@fontsource-variable/inter'
import '@fontsource/schibsted-grotesk/500.css'
import '@fontsource/schibsted-grotesk/600.css'
import '@fontsource/schibsted-grotesk/700.css'
import '@fontsource/great-vibes'
import '@fontsource/dancing-script'
import '@fontsource/sacramento'
import '@fontsource/caveat'
import '@fontsource/homemade-apple'
import './styles.css'
import App from './App'
import { useApp, sessionHasEdits } from './store'
import { useEdit } from './editor/editStore'
import { createTauriApi, isTauri, type SaveGuard } from './platform/tauriApi'
import { displayNameFromPath } from './lib/fileName'

// Under Tauri there is no Electron preload — install the equivalent API.
if (isTauri()) {
  window.signer = createTauriApi()
}

void useApp.getState().init()

// Automation/integration hook (used by scripts/e2e.mjs and external drivers).
;(window as unknown as { __signerStore: typeof useApp }).__signerStore = useApp
void import('./editor/editStore').then((m) => {
  ;(window as unknown as { __editStore: typeof m.useEdit }).__editStore = m.useEdit
})

void import('./lib/ocr').then((m) => {
  ;(window as unknown as Record<string, unknown>).__ocrSelfTest = m.ocrSelfTest
})

// Test helper: extract the text layer of a PDF (used to verify that edits are
// merged into signed/printed output).
;(window as unknown as Record<string, unknown>).__pdfText = async (bytes: ArrayLike<number>) => {
  const { openPdf } = await import('./lib/pdf')
  const { doc, close } = await openPdf(new Uint8Array(bytes))
  let out = ''
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const tc = await page.getTextContent()
    out += tc.items.map((i) => ('str' in i ? i.str : '')).join(' ') + '\n'
  }
  await close()
  return out
}

// Test helper: text items with their placement matrices (used to verify that
// rotated text — e.g. vertical retype — lands at the right spot and angle).
;(window as unknown as Record<string, unknown>).__pdfTextGeom = async (bytes: ArrayLike<number>) => {
  const { openPdf } = await import('./lib/pdf')
  const { doc, close } = await openPdf(new Uint8Array(bytes))
  const out: { page: number; str: string; transform: number[]; width: number; height: number }[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const tc = await page.getTextContent()
    for (const i of tc.items) {
      if ('str' in i && i.str.trim()) {
        out.push({ page: p, str: i.str, transform: [...i.transform], width: i.width, height: i.height })
      }
    }
  }
  await close()
  return out
}

// Safety net for Android file picks (delivered from MainActivity, which sees
// every activity result even when Tauri's plugin callback was lost to an
// activity recreation behind the picker). Files already added — the normal
// delivery path won the race — are de-duplicated by the store.
//
// The catch: the *save* dialog also produces an activity result, and once we
// write into its target the file is a valid PDF — so without a guard the net
// re-imports our own signed/edited output as a phantom new document. The
// mobile save path (tauriApi.writeSigned) marks a suppression window and the
// exact saved URI; we skip both here. We still return true so MainActivity
// stops retrying the delivery.
// Android back button (forwarded from MainActivity). Standard "innermost
// first" ladder — each press peels one layer, so back never silently kills
// the app: 1) close an open overlay, 2) commit the text box being typed
// (drops the keyboard), 3) put an active drawing tool back to select,
// 4) deselect, 5) unsaved work -> Stay/Leave prompt, 6) nothing to lose ->
// double-press-to-exit. Returns 'handled' or 'exit' — MainActivity backgrounds
// the app only on 'exit'; the prompt's Leave button quits via exitApp().
let lastBackAt = 0
;(window as unknown as Record<string, unknown>).__handleBackButton = (): string => {
  const app = useApp.getState()
  const edit = useEdit.getState()
  // 1. overlays, most specific first (the exit prompt itself dismisses = Stay)
  if (app.exitPrompt) {
    app.dismissExitPrompt()
    return 'handled'
  }
  if (app.studioOpen) {
    app.closeStudio()
    return 'handled'
  }
  if (app.result) {
    app.dismissResult()
    return 'handled'
  }
  const veil = document.querySelector('.modal-veil')
  if (veil) {
    // dialogs with an explicit cancel (unlock's "Not now", merge) take it;
    // veil-dismissable ones (licenses) just close
    const cancel = veil.querySelector<HTMLElement>('.dialog-actions .ghost-btn')
    if (cancel) cancel.click()
    else (veil as HTMLElement).click()
    return 'handled'
  }
  // the edit-tools drawer (phone) closes like any overlay
  const drawer = document.querySelector<HTMLElement>('.drawer-veil')
  if (drawer) {
    drawer.click()
    return 'handled'
  }
  const doc = app.docs.find((d) => d.id === app.selectedDocId)
  const session = doc ? edit.sessions[doc.id] : undefined
  // 2. typing: close the box (blur commits it) and drop the keyboard
  if (app.view === 'edit' && doc && session?.editingId) {
    const ta = document.querySelector<HTMLTextAreaElement>('.eo-textarea')
    if (ta) ta.blur()
    else edit.setEditing(doc.id, null)
    return 'handled'
  }
  // 3. an active drawing tool goes back to the move tool
  if (app.view === 'edit' && edit.tool !== 'select') {
    edit.setTool('select')
    return 'handled'
  }
  // 4. a selected object is deselected
  if (app.view === 'edit' && doc && session?.selectedId) {
    edit.select(doc.id, null)
    return 'handled'
  }
  // 5. unsaved work guards the exit
  const hasUnsaved =
    app.docs.some((d) => sessionHasEdits(edit.sessions[d.id], d)) ||
    app.extraStamps.length > 0 ||
    app.dateStamps.length > 0
  if (hasUnsaved) {
    app.requestExit()
    return 'handled'
  }
  // 6. nothing to lose: double-press to leave
  const now = Date.now()
  if (now - lastBackAt < 2000) return 'exit'
  lastBackAt = now
  app.showBackToast()
  return 'handled'
}

// MainActivity forwards either bare URI strings or {uri, name} objects, where
// name is the real DISPLAY_NAME it resolved from Android's ContentResolver
// (the URI alone only yields a meaningless document id).
type PickedItem = string | { uri: string; name?: string }
;(window as unknown as Record<string, unknown>).__androidPickedFiles = (items: PickedItem[]) => {
  const guard = window as unknown as SaveGuard
  const saving = Date.now() < (guard.__signerSavingUntil ?? 0)
  void (async () => {
    for (const item of items) {
      const uri = typeof item === 'string' ? item : item?.uri
      if (!uri) continue
      if (saving || guard.__signerSavedUris?.has(uri)) continue // our own save output — not a pick
      const realName = (typeof item === 'string' ? '' : (item.name ?? '')).trim()
      // some providers report a different URI to the net than to the save
      // dialog — the saved NAME is the identity of last resort
      if (realName && guard.__signerSavedNames?.has(realName)) continue
      // if the normal open path already added it, just correct the name
      const existing = useApp.getState().docs.find((d) => d.path === uri)
      if (existing) {
        if (realName) useApp.getState().renameByPath(uri, realName)
        continue
      }
      try {
        const bytes = new Uint8Array(await window.signer.readFile(uri))
        const isPdf =
          bytes.length > 4 &&
          bytes[0] === 0x25 && // %
          bytes[1] === 0x50 && // P
          bytes[2] === 0x44 && // D
          bytes[3] === 0x46 // F
        if (!isPdf) continue
        await useApp.getState().addFiles([{ name: realName || displayNameFromPath(uri), bytes, path: uri }])
      } catch {
        /* unreadable or foreign result — not a pick we can use */
      }
    }
  })()
  return true
}

// Test helper: decrypt a PDF (by path) with the bundled qpdf and report its
// page count — proves a protected output opens with the right password.
;(window as unknown as Record<string, unknown>).__unlockProbe = async (
  path: string,
  password: string,
) => {
  const { unlockPdf } = await import('./lib/unlockPdf')
  const { getPageCount } = await import('./lib/pdf')
  const bytes = new Uint8Array(await window.signer.readFile(path))
  const clear = await unlockPdf(bytes, password)
  return { pages: await getPageCount(clear) }
}

// Test helper: render a page of a PDF (by path) through the app's exact
// render pipeline and report how much ink landed on the canvas — used to
// verify PDFs that once rendered blank (shared-image/CCITT regressions).
;(window as unknown as Record<string, unknown>).__renderProbe = async (
  path: string,
  pageIndex = 0,
  extra?: Record<string, unknown>,
) => {
  const { openPdf, renderPage } = await import('./lib/pdf')
  const bytes = new Uint8Array(await window.signer.readFile(path))
  const { doc, close } = await openPdf(bytes, extra)
  try {
    const { canvas } = await renderPage(doc, pageIndex, 800, 1100, 2)
    const g = canvas.getContext('2d')!
    const d = g.getImageData(0, 0, canvas.width, canvas.height).data
    let ink = 0
    let total = 0
    for (let i = 0; i < d.length; i += 40) {
      total++
      if (d[i] < 240) ink++
    }
    return { w: canvas.width, h: canvas.height, inkPct: Math.round((ink / total) * 1000) / 10 }
  } finally {
    await close()
  }
}

// Debug helper: operator-level look at a page that renders blank — which
// image ops exist, whether their objects ever resolve, and what a print-intent
// render does differently.
;(window as unknown as Record<string, unknown>).__pdfDebugProbe = async (path: string, pageIndex = 0) => {
  const pdfjs = await import('pdfjs-dist')
  const { openPdf } = await import('./lib/pdf')
  const bytes = new Uint8Array(await window.signer.readFile(path))
  const { doc, close } = await openPdf(bytes)
  try {
    const page = await doc.getPage(pageIndex + 1)
    const ops = await page.getOperatorList()
    const hist: Record<string, number> = {}
    const opName = (fn: number) =>
      Object.entries(pdfjs.OPS).find(([, v]) => v === fn)?.[0] ?? String(fn)
    const images: { op: string; objId: string; resolved: boolean }[] = []
    for (let i = 0; i < ops.fnArray.length; i++) {
      const name = opName(ops.fnArray[i])
      hist[name] = (hist[name] ?? 0) + 1
      if (name.startsWith('paintImage') || name === 'dependency') {
        const arg = ops.argsArray[i]
        const objId = Array.isArray(arg) ? String(arg[0]) : String(arg)
        let resolved = false
        try {
          resolved = (page.objs as unknown as { has(id: string): boolean }).has(objId)
        } catch {
          resolved = false
        }
        images.push({ op: name, objId, resolved })
      }
    }
    // a print-intent render for comparison
    const vp = page.getViewport({ scale: 0.5 })
    const canvas = document.createElement('canvas')
    canvas.width = vp.width
    canvas.height = vp.height
    const g = canvas.getContext('2d')!
    await page.render({ canvas, canvasContext: g, viewport: vp, intent: 'print' }).promise
    const d = g.getImageData(0, 0, canvas.width, canvas.height).data
    let ink = 0
    let total = 0
    for (let i = 0; i < d.length; i += 40) {
      total++
      if (d[i] < 240) ink++
    }
    return { hist, images: images.slice(0, 10), printInkPct: Math.round((ink / total) * 1000) / 10 }
  } finally {
    await close()
  }
}

// Test helper: build a PDF with a vertically-rotated label (like a table
// header) so the vertical-retype regression has a deterministic input.
;(window as unknown as Record<string, unknown>).__makeVerticalPdf = async (label: string) => {
  const { PDFDocument, StandardFonts, degrees } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const page = doc.addPage([595, 842])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText('Course Code Listing', { x: 60, y: 780, size: 12, font })
  // reads bottom-to-top, the common table-header orientation
  page.drawText(label, { x: 300, y: 400, size: 10, font, rotate: degrees(90) })
  return doc.save()
}

// Test helper: build a long "contract" PDF — the REAL signature label lives on
// an early page while the last page only carries a plain ruled line, so smart
// detection must not let a last-page bonus outweigh strong early evidence.
;(window as unknown as Record<string, unknown>).__makeContractPdf = async (pages: number, labelPage: number) => {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage([595, 842])
    page.drawText(`Service Contract — clause page ${p + 1}`, { x: 60, y: 780, size: 12, font })
    for (let i = 0; i < 8; i++) {
      page.drawText(`${p + 1}.${i + 1} The parties agree to the terms described herein.`, { x: 60, y: 700 - i * 40, size: 10, font })
    }
    if (p === labelPage) {
      page.drawText('Signature: ____________________', { x: 60, y: 180, size: 12, font })
    }
    if (p === pages - 1) {
      // a bare ruled line, the weak evidence that used to win on long docs
      page.drawLine({ start: { x: 60, y: 120 }, end: { x: 260, y: 120 }, thickness: 1 })
    }
  }
  return doc.save()
}

// Test helper: build a "scanned" PDF (text rasterized to an image, no text
// layer) so the OCR regressions have a deterministic input.
;(window as unknown as Record<string, unknown>).__makeScannedPdf = async (
  linesOfText: string[],
  ruleAfter?: number,
) => {
  const canvas = document.createElement('canvas')
  canvas.width = 1190
  canvas.height = 1684
  const g = canvas.getContext('2d')!
  g.fillStyle = '#f4f1e8' // scanner off-white
  g.fillRect(0, 0, canvas.width, canvas.height)
  g.fillStyle = '#232323'
  g.font = '28px Arial'
  linesOfText.forEach((line, i) => {
    const y = 160 + i * 64
    g.fillText(line, 120, y)
    if (ruleAfter === i) {
      g.fillRect(120, y + 34, 380, 3) // a ruled signing line under this row
    }
  })
  const { PDFDocument } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const png = await doc.embedPng(
    Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), (c) => c.charCodeAt(0)),
  )
  const page = doc.addPage([595, 842])
  page.drawImage(png, { x: 0, y: 0, width: 595, height: 842 })
  return doc.save()
}

// Test helper: a multi-page "scanned" PDF (every page is one big image, no
// text layer). sigPage gets a signature label + ruled line; -1 = none at all.
// Exercises the OCR budget in smart detection (scan pages are expensive).
;(window as unknown as Record<string, unknown>).__makeScannedPdfPages = async (
  pages: number,
  sigPage: number,
) => {
  const { PDFDocument } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  for (let p = 0; p < pages; p++) {
    const canvas = document.createElement('canvas')
    canvas.width = 1190
    canvas.height = 1684
    const g = canvas.getContext('2d')!
    g.fillStyle = '#f4f1e8'
    g.fillRect(0, 0, canvas.width, canvas.height)
    g.fillStyle = '#232323'
    g.font = '28px Arial'
    for (let i = 0; i < 10; i++) {
      g.fillText(`Result sheet page ${p + 1} row ${i + 1} of the examination`, 120, 160 + i * 64)
    }
    if (p === sigPage) {
      g.fillText('Authorized Signature', 120, 1100)
      g.fillRect(120, 1134, 380, 3)
    }
    const png = await doc.embedPng(
      Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), (c) => c.charCodeAt(0)),
    )
    const page = doc.addPage([595, 842])
    page.drawImage(png, { x: 0, y: 0, width: 595, height: 842 })
  }
  return doc.save()
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
