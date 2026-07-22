import { app, BrowserWindow, Menu, Tray, nativeImage, shell } from 'electron'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { mkdirSync } from 'fs'
import { createOrchestrator } from './orchestrator.js'
import { getDb } from './persistence/db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Development builds must be able to run beside an installed UCLI instance.
// Give them a separate identity and data directory so their single-instance
// lock and test data cannot collide with the user's packaged application.
if (!app.isPackaged) {
  app.setName('UCLI Dev')
  const devUserDataPath = join(app.getPath('appData'), 'ucli-dev')
  mkdirSync(devUserDataPath, { recursive: true })
  app.setPath('userData', devUserDataPath)
}

// Chromium writes cache data under sessionData. On Windows the default
// Electron cache can be left with ACLs/locks that make the next launch fail
// with "Unable to move the cache: Access denied". Keep durable UCLI data in
// userData, but isolate disposable browser cache under the writable temp path.
const sessionDataPath = join(app.getPath('temp'), 'ucli', app.isPackaged ? 'electron-session-data' : 'electron-session-data-dev')
mkdirSync(sessionDataPath, { recursive: true })
app.setPath('sessionData', sessionDataPath)
app.commandLine.appendSwitch('disk-cache-dir', join(sessionDataPath, 'Cache'))

/** @type {BrowserWindow | null} */
let mainWindow = null
let tray = null
let orchestrator = null
let isQuitting = false
let quitReady = false
let shutdownPromise = null

function iconPath(filename) {
  const root = app.isPackaged ? join(process.resourcesPath, 'resources') : join(app.getAppPath(), 'resources')
  return join(root, 'icons', filename)
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray() {
  if (tray) return tray
  const icon = nativeImage.createFromPath(iconPath('ucli-tray.png'))
  if (icon.isEmpty()) throw new Error('UCLI tray icon could not be loaded')
  tray = new Tray(icon)
  tray.setToolTip(app.isPackaged ? 'UCLI' : 'UCLI Dev')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 UCLI', click: showMainWindow },
    { type: 'separator' },
    { label: '退出 UCLI', click: () => app.quit() }
  ]))
  tray.on('click', showMainWindow)
  tray.on('double-click', showMainWindow)
  return tray
}

function createWindow() {
  const windowTitle = app.isPackaged ? 'UCLI' : 'UCLI Dev'
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: windowTitle,
    icon: iconPath('ucli.png'),
    backgroundColor: '#f0f2f5',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', (event) => {
    if (!isQuitting && tray) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })
  mainWindow.on('closed', () => { mainWindow = null })
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault()
    mainWindow?.setTitle(windowTitle)
  })

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
  orchestrator = createOrchestrator()
  try { await orchestrator.initPersistence() } catch (e) { console.error('initPersistence failed:', e) }
  orchestrator.registerIpc()

  try {
    createTray()
  } catch (error) {
    tray = null
    console.error('Failed to create tray:', error)
  }
  createWindow()
  orchestrator.setMainWindow(mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
      orchestrator.setMainWindow(mainWindow)
    } else showMainWindow()
  })
}).catch((error) => console.error('UCLI startup failed:', error))

// Single-instance lock — second launches focus the existing window.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })
}

app.on('before-quit', (event) => {
  isQuitting = true
  if (quitReady) return
  event.preventDefault()
  if (shutdownPromise) return
  shutdownPromise = (async () => {
    try { await orchestrator?.shutdown() }
    catch (error) { console.error('UCLI shutdown failed:', error) }
    try { getDb()?.close() }
    catch (error) { console.error('Database close failed:', error) }
    tray?.destroy()
    tray = null
    quitReady = true
    app.quit()
  })()
})

app.on('window-all-closed', () => {
  if (!tray && process.platform !== 'darwin') app.quit()
})
