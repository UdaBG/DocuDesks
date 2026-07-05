import esbuild from 'esbuild'
import { copyFile } from 'node:fs/promises'

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  sourcemap: false,
  minify: false,
}

await esbuild.build({
  ...common,
  entryPoints: ['electron/main.ts'],
  outfile: 'dist-electron/main.cjs',
})

await esbuild.build({
  ...common,
  entryPoints: ['electron/preload.ts'],
  outfile: 'dist-electron/preload.cjs',
})

// window/taskbar icon shipped alongside the main bundle
await copyFile('build/icon.png', 'dist-electron/icon.png').catch(() => {})

console.log('electron main + preload built -> dist-electron/')
