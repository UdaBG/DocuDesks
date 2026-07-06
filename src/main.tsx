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
import { useApp } from './store'
import { createTauriApi, isTauri } from './platform/tauriApi'

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

// Safety net for Android file picks (delivered from MainActivity, which sees
// every activity result even when Tauri's plugin callback was lost to an
// activity recreation behind the picker). Files already added — the normal
// delivery path won the race — are de-duplicated by the store; non-PDF or
// empty targets (a save dialog's freshly created file) are ignored.
;(window as unknown as Record<string, unknown>).__androidPickedFiles = (uris: string[]) => {
  void (async () => {
    for (const uri of uris) {
      try {
        const bytes = new Uint8Array(await window.signer.readFile(uri))
        const isPdf =
          bytes.length > 4 &&
          bytes[0] === 0x25 && // %
          bytes[1] === 0x50 && // P
          bytes[2] === 0x44 && // D
          bytes[3] === 0x46 // F
        if (!isPdf) continue
        const decoded = decodeURIComponent(uri)
        const name = decoded.split(/[\\/:]/).pop()?.trim() || 'document.pdf'
        await useApp.getState().addFiles([{ name, bytes, path: uri }])
      } catch {
        /* unreadable or foreign result — not a pick we can use */
      }
    }
  })()
  return true
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

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
