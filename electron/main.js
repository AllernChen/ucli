import { app, BrowserWindow, Menu, Tray, nativeImage, shell, dialog, screen, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createOrchestrator } from './orchestrator.js'
import { getDb } from './persistence/db.js'
import { describeDatabaseRecovery } from './persistence/recoveryMessage.js'
import { applyMacLoginPath } from './macEnvironment.js'
import { installOutputErrorGuards } from './brokenPipeGuard.js'
import { resolveWindowBounds } from './windowState.js'
import {
  isAllowedApplicationNavigation,
  openAllowedExternalUrl
} from './externalLinks.js'
import { createUpdateService } from './updateService.js'
import { safeStartupFailure, startMainWindowLifecycle } from './startupLifecycle.js'
import { resolveUcliStorageRoots } from './storage/storageCatalog.js'
import { runScheduledStorageCleanupSync } from './storage/startupCleanup.js'
import { runPrimaryInstanceGate } from './primaryInstanceGate.js'
import { createDeepLinkReceiver } from './serverConnection/deepLink.js'

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

/** @type {BrowserWindow | null} */
let mainWindow = null
/** @type {BrowserWindow | null} */
let previewWindow = null
let tray = null
let orchestrator = null
let isQuitting = false
let quitReady = false
let shutdownPromise = null
let updateService = null
const deepLinks = createDeepLinkReceiver({
  acceptConnection: async (connection) => {
    const attempt = await orchestrator?.submitServerConnection(connection)
    if (attempt) openServerConnectionSettings()
  }
})

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function openServerConnectionSettings() {
  showMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return
  const hash = '/settings?section=server'
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#${hash}`)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash })
  }
}

if (process.platform === 'darwin') {
  app.on('open-url', (event, url) => {
    event.preventDefault()
    deepLinks.acceptOpenUrl(url)
  })
}

const isPrimaryInstance = runPrimaryInstanceGate({
  acquireLock: () => app.requestSingleInstanceLock(),
  quit: () => app.quit(),
  bootstrap: bootstrapPrimaryInstance,
  onSecondInstance: (handler) => app.on('second-instance', (_event, argv, workingDirectory) => {
    showMainWindow()
    handler({ argv, workingDirectory })
  }),
  handleSecondInstance: ({ argv }) => deepLinks.acceptArgv(argv)
})
if (isPrimaryInstance) deepLinks.acceptArgv(process.argv)

function bootstrapPrimaryInstance() {
// Chromium writes cache data under sessionData. On Windows the default
// Electron cache can be left with ACLs/locks that make the next launch fail
// with "Unable to move the cache: Access denied". Keep durable UCLI data in
// userData, but isolate disposable browser cache under the writable temp path.
const sessionDataPath = join(app.getPath('temp'), 'ucli', app.isPackaged ? 'electron-session-data' : 'electron-session-data-dev')
const storageRoots = resolveUcliStorageRoots({
  platform: process.platform,
  env: process.env,
  homeDirectory: app.getPath('home'),
  userDataPath: app.getPath('userData'),
  sessionDataPath
})
try {
  runScheduledStorageCleanupSync({
    markerPath: join(storageRoots.userData, 'storage-cleanup.json'),
    roots: { ...storageRoots, browserCacheParent: dirname(sessionDataPath) }
  })
} catch (error) {
  console.error('UCLI storage cleanup failed:', error?.code || 'STORAGE_CLEANUP_FAILED')
}
mkdirSync(sessionDataPath, { recursive: true })
app.setPath('sessionData', sessionDataPath)
app.commandLine.appendSwitch('disk-cache-dir', join(sessionDataPath, 'Cache'))
if (process.platform === 'win32') app.setAppUserModelId('com.ucli.app')

function iconPath(filename) {
  const root = app.isPackaged ? join(process.resourcesPath, 'resources') : join(app.getAppPath(), 'resources')
  return join(root, 'icons', filename)
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
  const bounds = resolveWindowBounds(saved, screen.getAllDisplays())
  mainWindow = new BrowserWindow({
    ...bounds,
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
    openAllowedExternalUrl(url, (allowedUrl) => shell.openExternal(allowedUrl)).catch(() => {})
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow?.webContents.getURL() || ''
    if (!isAllowedApplicationNavigation(currentUrl, url)) event.preventDefault()
  })

  // Dev: load the electron-vite renderer dev server. Prod: load the built file.
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function openArtifactWindow(sessionId) {
  const hash = `/preview?session=${encodeURIComponent(String(sessionId || ''))}`
  if (previewWindow && !previewWindow.isDestroyed()) {
    if (previewWindow.isMinimized()) previewWindow.restore()
    previewWindow.show()
    previewWindow.focus()
    if (process.env['ELECTRON_RENDERER_URL']) {
      previewWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#${hash}`)
    } else {
      previewWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash })
    }
    return
  }
  const win = new BrowserWindow({
    width: 980, height: 720, minWidth: 480, minHeight: 360,
    title: 'UCLI 产物预览', autoHideMenuBar: true,
    icon: iconPath('ucli.png'),
    backgroundColor: '#f0f2f5',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false, contextIsolation: true, nodeIntegration: false
    }
  })
  previewWindow = win
  // External http(s) links inside rendered artifacts are opened via shell by
  // openSafeLink in the renderer; deny window.open to keep preview sandboxed.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    const currentUrl = win.webContents.getURL() || ''
    if (!isAllowedApplicationNavigation(currentUrl, url)) event.preventDefault()
  })
  win.webContents.on('page-title-updated', (event) => {
    event.preventDefault()
    win.setTitle('UCLI 产物预览')
  })
  win.on('closed', () => { if (previewWindow === win) previewWindow = null })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#${hash}`)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
  }
}
ipcMain.handle('artifact:open-window', (_event, sessionId) => openArtifactWindow(String(sessionId || '')))

function fallbackUpdateState() {
  return {
    revision: 0,
    checkedAt: 0,
    status: 'unsupported',
    currentVersion: app.getVersion(),
    availableVersion: null,
    releaseDate: null,
    releaseNotes: '',
    progressPercent: null,
    transferred: null,
    total: null,
    bytesPerSecond: null,
    error: ''
  }
}

function registerUpdateIpc() {
  ipcMain.handle('update:get-state', () => updateService?.getState() || fallbackUpdateState())
  ipcMain.handle('update:check', () => updateService?.check() || fallbackUpdateState())
  ipcMain.handle('update:download', () => updateService?.download() || fallbackUpdateState())
  ipcMain.handle('update:install', () => updateService?.install() || false)
}

app.whenReady().then(async () => {
  // The orchestrator owns everything: permission engine, the localhost hook
  // server (that the bundled Claude PreToolUse runner calls back into), the
  // adapter registry, sessions, stats, and all IPC handlers.
  orchestrator = createOrchestrator()
  await startMainWindowLifecycle({
    orchestrator,
    beforeWindow: createTray,
    openWindow: createWindow,
    onError: ({ phase, code }) => {
      if (phase === 'before-window') tray = null
      console.error(`UCLI ${phase} startup failed:`, code)
    }
  })
  updateService = createUpdateService({
    updater: autoUpdater,
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    isPortable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE),
    platform: process.platform,
    onStateChange: (state) => mainWindow?.webContents.send('update:state', state)
  })
  registerUpdateIpc()
  updateService.start()
  orchestrator.setMainWindow(mainWindow)
  await deepLinks.setReady()
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
}).catch((error) => {
  const failure = safeStartupFailure('application', error)
  console.error('UCLI startup failed:', failure.code)
})

// Single-instance lock — second launches focus the existing window.
}

app.on('before-quit', (event) => {
  isQuitting = true
  if (quitReady) return
  event.preventDefault()
  if (shutdownPromise) return
  shutdownPromise = (async () => {
    updateService?.stop()
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
