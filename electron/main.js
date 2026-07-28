import { app, BrowserWindow, Menu, Tray, nativeImage, shell, dialog } from 'electron'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createOrchestrator } from './orchestrator.js'
import { getDb } from './persistence/db.js'
import { describeDatabaseRecovery } from './persistence/recoveryMessage.js'
import { applyMacLoginPath } from './macEnvironment.js'
import { installOutputErrorGuards } from './brokenPipeGuard.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

installOutputErrorGuards()
applyMacLoginPath()

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
if (process.platform === 'win32') app.setAppUserModelId('com.ucli.app')

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
  if (process.platform === 'darwin') icon.setTemplateImage(true)
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

function windowStatePath() {
  return join(app.getPath('userData'), 'window-state.json')
}

function loadWindowState() {
  try {
    return JSON.parse(readFileSync(windowStatePath(), 'utf8'))
  } catch { return {} }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    const maximized = mainWindow.isMaximized()
    const bounds = mainWindow.getNormalBounds()
    writeFileSync(windowStatePath(), JSON.stringify({ maximized, ...bounds }))
  } catch {}
}

function createWindow() {
  const windowTitle = app.isPackaged ? 'UCLI' : 'UCLI Dev'
  const saved = loadWindowState()
  mainWindow = new BrowserWindow({
    x: saved.x,
    y: saved.y,
    width: saved.width || 1280,
    height: saved.height || 832,
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

  if (saved.maximized) mainWindow.maximize()

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  // Debounced window state persistence
  let winStateTimer = null
  function persistWinState() {
    if (winStateTimer) clearTimeout(winStateTimer)
    winStateTimer = setTimeout(saveWindowState, 300)
  }
  mainWindow.on('resize', persistWinState)
  mainWindow.on('move', persistWinState)
  mainWindow.on('maximize', saveWindowState)
  mainWindow.on('unmaximize', saveWindowState)
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
  const recoveryInfo = orchestrator.getPersistenceRecovery()
  if (recoveryInfo) {
    const recoveryDialog = describeDatabaseRecovery(recoveryInfo)
    dialog.showMessageBox(mainWindow, recoveryDialog)
      .catch((error) => console.error('Failed to show database recovery message:', error))
  }

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
    try { saveWindowState() }
    catch (error) { console.error('Window state save failed:', error) }
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
