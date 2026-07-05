import { contextBridge, ipcRenderer, webUtils } from 'electron'

export interface SignerApi {
  /** false on mobile platforms where a file cannot be revealed in a file manager */
  canRevealFiles: boolean
  openPdfDialog(): Promise<string[]>
  chooseOutputDir(defaultPath?: string): Promise<string | null>
  readFile(path: string): Promise<Uint8Array>
  exists(path: string): Promise<boolean>
  writeSigned(dir: string, name: string, data: Uint8Array): Promise<string>
  showItemInFolder(path: string): void
  /** send PDFs to the OS print pipeline (default PDF handler) */
  printFiles(paths: string[]): Promise<void>
  /** print in-memory PDF bytes via a temp file — no save step */
  printPdfData(name: string, data: Uint8Array): Promise<void>
  getLocale(): Promise<string>
  getPendingFiles(): Promise<string[]>
  onFilesOpened(cb: (paths: string[]) => void): () => void
  getPathForFile(file: File): string
  loadSignatures(): Promise<unknown>
  saveSignatures(signatures: unknown): Promise<void>
  loadSettings(): Promise<Record<string, unknown>>
  saveSettings(settings: Record<string, unknown>): Promise<void>
}

const api: SignerApi = {
  canRevealFiles: true,
  openPdfDialog: () => ipcRenderer.invoke('dialog:open-pdfs'),
  chooseOutputDir: (defaultPath) => ipcRenderer.invoke('dialog:choose-dir', defaultPath),
  readFile: (path) => ipcRenderer.invoke('fs:read-file', path),
  exists: (path) => ipcRenderer.invoke('fs:exists', path),
  writeSigned: (dir, name, data) => ipcRenderer.invoke('fs:write-signed', dir, name, data),
  showItemInFolder: (path) => void ipcRenderer.invoke('shell:show-item', path),
  printFiles: (paths) => ipcRenderer.invoke('shell:print-files', paths),
  printPdfData: (name, data) => ipcRenderer.invoke('shell:print-data', name, data),
  getLocale: () => ipcRenderer.invoke('app:get-locale'),
  getPendingFiles: () => ipcRenderer.invoke('app:get-pending-files'),
  onFilesOpened: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, paths: string[]) => cb(paths)
    ipcRenderer.on('files-opened', listener)
    return () => ipcRenderer.removeListener('files-opened', listener)
  },
  getPathForFile: (file) => webUtils.getPathForFile(file),
  loadSignatures: () => ipcRenderer.invoke('store:load-signatures'),
  saveSignatures: (signatures) => ipcRenderer.invoke('store:save-signatures', signatures),
  loadSettings: () => ipcRenderer.invoke('store:load-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('store:save-settings', settings),
}

contextBridge.exposeInMainWorld('signer', api)
