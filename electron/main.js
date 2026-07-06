import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { createOrchestrator } from './orchestrator.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** @type {BrowserWindow | null} */
let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'UCLI',
    backgroundColor: '#f0f2f5',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Dev: load the electron-vite renderer dev server. Prod: load the built file.
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  // The orchestrator owns everything: permission engine, the localhost hook
  // server (that the bundled Claude PreToolUse runner calls back into), the
  // adapter registry, sessions, stats, and all IPC handlers.
  const orchestrator = createOrchestrator()
  await orchestrator.initPersistence() // opens sql.js DB + migrates old JSON
  orchestrator.registerIpc()

  createWindow()
  orchestrator.setMainWindow(mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
      orchestrator.setMainWindow(mainWindow)
    }
  })
})

// Single-instance lock — second launches focus the existing window.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    mainWindow?.restore()
    mainWindow?.focus()
  })
}

app.on('before-quit', () => {
  // Flush sql.js DB to disk before exiting.
  const { getDb } = require('./persistence/db.js')
  getDb()?.close()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
