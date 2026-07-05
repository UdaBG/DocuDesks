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

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
