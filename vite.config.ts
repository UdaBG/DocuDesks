import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Inject a strict CSP only in production builds. In dev, the React fast-refresh
// preamble needs inline scripts, so the CSP would have to be too loose to matter.
function prodCsp(): Plugin {
  return {
    name: 'prod-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const csp = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "worker-src 'self' blob:",
        // ipc: / ipc.localhost are Tauri's IPC transport; inert under Electron.
        "connect-src 'self' data: blob: ipc: http://ipc.localhost",
      ].join('; ')
      return html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`,
      )
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [react(), prodCsp()],
  server: {
    port: 5173,
    strictPort: true, // tauri.conf.json devUrl points here
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 4096,
  },
})
