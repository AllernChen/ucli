const MAX_SAFE = Number.MAX_SAFE_INTEGER
const PERIODIC_STATUSES = new Set(['idle', 'not-available', 'error'])

function safeInteger(value, fallback = 0) {
  if (!Number.isFinite(value) || value < 0) return fallback
  return Math.min(MAX_SAFE, Math.floor(value))
}

function boundedText(value, limit) {
  return String(value || '').slice(0, limit)
}

function initialState(currentVersion, status = 'idle') {
  return {
    revision: 0,
    checkedAt: 0,
    status,
    currentVersion: boundedText(currentVersion, 64),
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

function plainReleaseNotes(value) {
  const source = Array.isArray(value)
    ? value.map(item => typeof item === 'string' ? item : item?.note || '').join('\n')
    : String(value || '')
  return boundedText(source.replace(/<[^>]*>/g, '').trim(), 4000)
}

export function createUpdateService({
  updater,
  appVersion,
  isPackaged,
  isPortable,
  platform,
  onStateChange = () => {},
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
  now = Date.now
}) {
  const supported = Boolean(isPackaged && !isPortable && ['win32', 'darwin'].includes(platform))
  let state = initialState(appVersion, supported ? 'idle' : 'unsupported')
  let checkPromise = null
  let initialTimer = null
  let periodicTimer = null
  let installTimer = null
  let started = false
  let intervalMs = 21600000

  function snapshot() { return { ...state } }

  function emit(next) {
    state = {
      ...state,
      ...next,
      revision: Math.min(MAX_SAFE, state.revision + 1)
    }
    onStateChange(snapshot())
    if (started) {
      if (PERIODIC_STATUSES.has(state.status)) {
        if (initialTimer == null && periodicTimer == null && checkPromise == null) schedulePeriodic()
      } else {
        clearTimer('periodic')
      }
    }
    return snapshot()
  }

  function fail(message) {
    return emit({
      status: 'error',
      availableVersion: null,
      releaseDate: null,
      releaseNotes: '',
      progressPercent: null,
      transferred: null,
      total: null,
      bytesPerSecond: null,
      error: message
    })
  }

  function clearTimer(name) {
    const id = name === 'initial' ? initialTimer : name === 'periodic' ? periodicTimer : installTimer
    if (id != null) cancelSchedule(id)
    if (name === 'initial') initialTimer = null
    else if (name === 'periodic') periodicTimer = null
    else installTimer = null
  }

  function schedulePeriodic() {
    clearTimer('periodic')
    if (!started || !PERIODIC_STATUSES.has(state.status)) return
    periodicTimer = schedule(async () => {
      periodicTimer = null
      if (PERIODIC_STATUSES.has(state.status)) await check()
      schedulePeriodic()
    }, intervalMs)
  }

  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.allowPrerelease = false
  updater.allowDowngrade = false

  updater.on('update-available', (info = {}) => {
    emit({
      status: 'available',
      availableVersion: boundedText(info.version, 64),
      releaseDate: typeof info.releaseDate === 'string' ? boundedText(info.releaseDate, 64) : null,
      releaseNotes: plainReleaseNotes(info.releaseNotes),
      progressPercent: null,
      transferred: null,
      total: null,
      bytesPerSecond: null,
      error: ''
    })
  })
  updater.on('update-not-available', () => {
    emit({
      status: 'not-available',
      availableVersion: null,
      releaseDate: null,
      releaseNotes: '',
      progressPercent: null,
      transferred: null,
      total: null,
      bytesPerSecond: null,
      error: ''
    })
  })
  updater.on('download-progress', ({ percent, transferred, total, bytesPerSecond } = {}) => {
    emit({
      status: 'downloading',
      progressPercent: Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : null,
      transferred: Number.isFinite(transferred) && transferred >= 0 ? safeInteger(transferred) : null,
      total: Number.isFinite(total) && total >= 0 ? safeInteger(total) : null,
      bytesPerSecond: Number.isFinite(bytesPerSecond) && bytesPerSecond >= 0 ? safeInteger(bytesPerSecond) : null,
      error: ''
    })
  })
  updater.on('update-downloaded', (info = {}) => {
    emit({
      status: 'downloaded',
      availableVersion: boundedText(info.version || state.availableVersion, 64),
      progressPercent: 100,
      bytesPerSecond: null,
      error: ''
    })
  })
  updater.on('error', () => fail('更新检查失败'))

  function check() {
    if (!supported) return Promise.resolve(snapshot())
    if (['downloading', 'downloaded', 'installing'].includes(state.status)) {
      return Promise.resolve(snapshot())
    }
    if (checkPromise) return checkPromise
    emit({
      status: 'checking',
      availableVersion: null,
      releaseDate: null,
      releaseNotes: '',
      progressPercent: null,
      transferred: null,
      total: null,
      bytesPerSecond: null,
      error: ''
    })
    checkPromise = (async () => {
      try {
        await updater.checkForUpdates()
      } catch {
        fail('更新检查失败')
      }
      emit({ checkedAt: safeInteger(now()) })
      return snapshot()
    })().finally(() => {
      checkPromise = null
      if (started) {
        if (PERIODIC_STATUSES.has(state.status)) schedulePeriodic()
        else clearTimer('periodic')
      }
    })
    return checkPromise
  }

  async function download() {
    if (!supported || state.status !== 'available') return snapshot()
    emit({
      status: 'downloading', progressPercent: 0,
      transferred: null, total: null, bytesPerSecond: null, error: ''
    })
    try { await updater.downloadUpdate() } catch { fail('更新下载失败') }
    return snapshot()
  }

  function install() {
    if (!supported || state.status !== 'downloaded') return false
    emit({ status: 'installing', error: '' })
    installTimer = schedule(() => {
      installTimer = null
      try { updater.quitAndInstall(false, true) } catch { fail('更新安装失败') }
    }, 200)
    return true
  }

  function start(options = {}) {
    if (!supported) return snapshot()
    const config = typeof options === 'number' ? { initialDelayMs: options } : options
    const initialDelayMs = safeInteger(config.initialDelayMs, 3000)
    intervalMs = safeInteger(config.intervalMs, 21600000)
    started = true
    clearTimer('initial')
    clearTimer('periodic')
    initialTimer = schedule(async () => {
      initialTimer = null
      if (PERIODIC_STATUSES.has(state.status)) await check()
      schedulePeriodic()
    }, initialDelayMs)
    return snapshot()
  }

  function stop() {
    started = false
    clearTimer('initial')
    clearTimer('periodic')
    clearTimer('install')
  }

  return { getState: snapshot, start, stop, check, download, install }
}
