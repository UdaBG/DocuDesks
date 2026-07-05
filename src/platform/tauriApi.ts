import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { appDataDir, join, tempDir } from '@tauri-apps/api/path'
import { open, save } from '@tauri-apps/plugin-dialog'
import { exists, mkdir, readFile, readTextFile, writeFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { locale, platform } from '@tauri-apps/plugin-os'
import type { SignerApi } from '../../electron/preload'

/** chooseOutputDir result on mobile: files are placed per-file via the system
 *  save dialog rather than into a directory. */
const PER_FILE_OUTPUT = 'per-file'

export function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in window
}

function isMobilePlatform(): boolean {
  const p = platform()
  return p === 'android' || p === 'ios'
}

async function storeFile(name: string): Promise<string> {
  const dir = await appDataDir()
  if (!(await exists(dir))) await mkdir(dir, { recursive: true })
  return join(dir, name)
}

async function loadJson(name: string): Promise<unknown> {
  try {
    return JSON.parse(await readTextFile(await storeFile(name)))
  } catch {
    return null
  }
}

async function saveJson(name: string, value: unknown): Promise<void> {
  await writeTextFile(await storeFile(name), JSON.stringify(value))
}

/** The same platform surface the Electron preload exposes, on Tauri plugins. */
export function createTauriApi(): SignerApi {
  const mobile = isMobilePlatform()
  return {
    canRevealFiles: !mobile,
    canPrint: !mobile,

    async openPdfDialog() {
      const res = await open({
        multiple: true,
        filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
      })
      return res ?? []
    },

    async chooseOutputDir(defaultPath) {
      const override = await invoke<string | null>('get_output_dir_override')
      if (override) return override
      if (mobile) {
        // No folder picker on mobile: each file goes through the system
        // save dialog instead, so it lands somewhere the user can find
        // (Downloads by default) and other apps can open.
        return PER_FILE_OUTPUT
      }
      const res = await open({ directory: true, defaultPath })
      return (res as string | null) ?? null
    },

    readFile: (path) => readFile(path),

    exists: (path) => exists(path).catch(() => false),

    async writeSigned(dir, name, data) {
      if (dir === PER_FILE_OUTPUT) {
        // Android/iOS: the system "create document" dialog picks the spot and
        // hands back a content URI the fs plugin can write to.
        const target = await save({
          defaultPath: name,
          filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
        })
        if (!target) return ''
        await writeFile(target, data)
        return target
      }
      const dot = name.lastIndexOf('.')
      const stem = dot > 0 ? name.slice(0, dot) : name
      const ext = dot > 0 ? name.slice(dot) : ''
      let candidate = await join(dir, name)
      for (let i = 2; await exists(candidate); i++) {
        candidate = await join(dir, `${stem} (${i})${ext}`)
      }
      await writeFile(candidate, data)
      return candidate
    },

    showItemInFolder(path) {
      if (!mobile) void revealItemInDir(path)
    },

    printFiles: (paths) => invoke('print_files', { paths }),

    async printPdfData(name, data) {
      const dir = await join(await tempDir(), 'signer-print')
      if (!(await exists(dir))) await mkdir(dir, { recursive: true })
      const file = await join(dir, `${Math.random().toString(36).slice(2, 8)}-${name.replace(/[\\/:*?"<>|]/g, '_')}`)
      await writeFile(file, data)
      await invoke('print_files', { paths: [file] })
    },

    getLocale: async () => (await locale()) ?? 'en',

    getPendingFiles: () => invoke<string[]>('get_pending_files'),

    onFilesOpened(cb) {
      const unlisten = listen<string[]>('files-opened', (e) => cb(e.payload))
      return () => void unlisten.then((f) => f())
    },

    // HTML5 drops already deliver the bytes; the path is only cosmetic.
    getPathForFile: () => '',

    loadSignatures: async () => (await loadJson('signatures.json')) ?? [],
    saveSignatures: (signatures) => saveJson('signatures.json', signatures),
    loadSettings: async () =>
      ((await loadJson('settings.json')) as Record<string, unknown>) ?? {},
    saveSettings: (settings) => saveJson('settings.json', settings),
  }
}
