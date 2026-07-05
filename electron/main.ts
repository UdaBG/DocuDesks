import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { execFile } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs/promises'

let win: BrowserWindow | null = null

/** PDF paths passed on the command line, delivered to the renderer once it is ready. */
let pendingFiles: string[] = collectPdfArgs(process.argv)

function collectPdfArgs(argv: string[]): string[] {
  return argv
    .filter((a) => a.toLowerCase().endsWith('.pdf'))
    .map((a) => path.resolve(a))
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    const files = collectPdfArgs(argv).map((f) =>
      path.isAbsolute(f) ? f : path.resolve(workingDirectory, f),
    )
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
      if (files.length) win.webContents.send('files-opened', files)
    } else {
      pendingFiles.push(...files)
    }
  })

  app.whenReady().then(async () => {
    await migrateLegacyData()
    createWindow()
  })
}

/**
 * The app was previously named "Signer"; carry saved signatures and settings
 * over to the new per-user data directory so nothing is lost by the rename.
 */
async function migrateLegacyData() {
  const newDir = app.getPath('userData')
  const oldDir = path.join(path.dirname(newDir), 'Signer')
  for (const file of ['signatures.json', 'settings.json']) {
    try {
      await fs.access(path.join(newDir, file))
    } catch {
      try {
        await fs.mkdir(newDir, { recursive: true })
        await fs.copyFile(path.join(oldDir, file), path.join(newDir, file))
      } catch {
        /* nothing to migrate */
      }
    }
  }
}

function createWindow() {
  const iconPath = path.join(__dirname, 'icon.png')
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#12161f',
    show: false,
    autoHideMenuBar: true,
    title: 'DocuDesk',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })

  // The edit view's font picker uses the Local Font Access API.
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback((permission as string) === 'local-fonts')
  })
  win.webContents.session.setPermissionCheckHandler(
    (_wc, permission) => (permission as string) === 'local-fonts',
  )

  win.once('ready-to-show', () => win?.show())
  win.on('closed', () => (win = null))

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.on('window-all-closed', () => {
  app.quit()
})

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle('dialog:open-pdfs', async () => {
  if (!win) return []
  const result = await dialog.showOpenDialog(win, {
    title: 'Add PDF documents',
    filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
    properties: ['openFile', 'multiSelections'],
  })
  return result.canceled ? [] : result.filePaths
})

ipcMain.handle('dialog:choose-dir', async (_e, defaultPath?: string) => {
  // Automation hook: lets scripts and integrations pre-select the output folder.
  if (process.env.SIGNER_OUTPUT_DIR) return process.env.SIGNER_OUTPUT_DIR
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose output folder',
    defaultPath,
    properties: ['openDirectory', 'createDirectory'],
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('fs:read-file', async (_e, filePath: string) => {
  const buf = await fs.readFile(filePath)
  return buf // serialized to Uint8Array in the renderer
})

ipcMain.handle('fs:exists', async (_e, filePath: string) => {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
})

/**
 * Write bytes into `dir` under `name`, de-duplicating the file name if it
 * already exists ("report_signed.pdf" -> "report_signed (2).pdf").
 * Returns the full path written.
 */
ipcMain.handle('fs:write-signed', async (_e, dir: string, name: string, data: Uint8Array) => {
  const parsed = path.parse(name)
  let candidate = path.join(dir, name)
  for (let i = 2; ; i++) {
    try {
      await fs.access(candidate)
      candidate = path.join(dir, `${parsed.name} (${i})${parsed.ext}`)
    } catch {
      break
    }
  }
  await fs.writeFile(candidate, Buffer.from(data))
  return candidate
})

ipcMain.handle('shell:show-item', (_e, fullPath: string) => {
  shell.showItemInFolder(fullPath)
})

function printFile(p: string) {
  if (process.env.SIGNER_PRINT_DRYRUN) return // test hook: build files, skip the spooler
  if (process.platform === 'win32') {
    // shell "print" verb: the default PDF handler prints the file
    execFile('powershell.exe', [
      '-NoProfile',
      '-WindowStyle',
      'Hidden',
      '-Command',
      `Start-Process -FilePath '${p.replace(/'/g, "''")}' -Verb Print`,
    ])
  } else {
    execFile('lp', [p])
  }
}

ipcMain.handle('shell:print-files', (_e, paths: string[]) => {
  for (const p of paths) printFile(p)
})

ipcMain.handle('shell:print-data', async (_e, name: string, data: Uint8Array) => {
  const dir = path.join(app.getPath('temp'), 'signer-print')
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${Date.now()}-${name.replace(/[\\/:*?"<>|]/g, '_')}`)
  await fs.writeFile(file, Buffer.from(data))
  printFile(file)
})

ipcMain.handle('app:get-locale', () => app.getLocale())

ipcMain.handle('app:get-pending-files', () => {
  const files = pendingFiles
  pendingFiles = []
  return files
})

// -- Signature store: JSON file in the per-user app data directory -----------

function storePath() {
  return path.join(app.getPath('userData'), 'signatures.json')
}

ipcMain.handle('store:load-signatures', async () => {
  try {
    const raw = await fs.readFile(storePath(), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return []
  }
})

ipcMain.handle('store:save-signatures', async (_e, signatures: unknown) => {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(storePath(), JSON.stringify(signatures), 'utf-8')
})

// -- Settings store (language, preferences) ----------------------------------

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

ipcMain.handle('store:load-settings', async () => {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf-8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
})

ipcMain.handle('store:save-settings', async (_e, settings: unknown) => {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(settingsPath(), JSON.stringify(settings), 'utf-8')
})
