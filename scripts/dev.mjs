import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import esbuild from 'esbuild'
import electronPath from 'electron'

// 1. Build electron main + preload (watch mode)
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
}
await esbuild.build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs' })
await esbuild.build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs' })

// 2. Start the Vite dev server
const server = await createServer()
await server.listen()
const address = server.httpServer.address()
const url = `http://localhost:${address.port}`
console.log(`vite dev server: ${url}`)

// 3. Launch Electron pointed at the dev server
const child = spawn(electronPath, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
})
child.on('close', async () => {
  await server.close()
  process.exit(0)
})
