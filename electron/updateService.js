function initialState(currentVersion, status = 'idle') {
  return {
    status,
    currentVersion,
    availableVersion: null,
    releaseDate: null,
    releaseNotes: '',
    progressPercent: null,
    error: ''
  }
}

function plainReleaseNotes(value) {
  const source = Array.isArray(value)
    ? value.map((item) => typeof item === 'string' ? item : item?.note || '').join('\n')
    : String(value || '')
  return source.replace(/<[^>]*>/g, '').trim()
}

export function createUpdateService({
  updater,
  appVersion,
  isPackaged,
  isPortable,
  platform,
  onStateChange = () => {},
  schedule = setTimeout
}) {
  const supported = Boolean(isPackaged && !isPortable && ['win32', 'darwin'].includes(platform))
  let state = initialState(appVersion, supported ? 'idle' : 'unsupported')

  function emit(next) {
    state = { ...state, ...next }
    onStateChange({ ...state })
    return { ...state }
  }

  function fail(message) {
    return emit({
      status: 'error',
      availableVersion: null,
      releaseDate: null,
      releaseNotes: '',
      progressPercent: null,
      error: message
    })
  }

  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.allowPrerelease = false
  updater.allowDowngrade = false

  updater.on('update-available', (info = {}) => {
    emit({
      status: 'available',
      availableVersion: String(info.version || ''),
      releaseDate: info.releaseDate || null,
      releaseNotes: plainReleaseNotes(info.releaseNotes),
      progressPercent: null,
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
      error: ''
    })
  })
  updater.on('download-progress', ({ percent } = {}) => {
    const progressPercent = Number.isFinite(percent)
      ? Math.max(0, Math.min(100, Math.round(percent)))
      : null
    emit({ status: 'downloading', progressPercent, error: '' })
  })
  updater.on('update-downloaded', (info = {}) => {
    emit({
      status: 'downloaded',
      availableVersion: String(info.version || state.availableVersion || ''),
      progressPercent: 100,
      error: ''
    })
  })
  updater.on('error', () => fail('更新检查失败'))

  async function check() {
    if (!supported) return { ...state }
    emit({
      status: 'checking',
      availableVersion: null,
      releaseDate: null,
      releaseNotes: '',
      progressPercent: null,
      error: ''
    })
    try {
      await updater.checkForUpdates()
    } catch {
      fail('更新检查失败')
    }
    return { ...state }
  }

  async function download() {
    if (!supported || state.status !== 'available') return { ...state }
    emit({ status: 'downloading', progressPercent: 0, error: '' })
    try {
      await updater.downloadUpdate()
    } catch {
      fail('更新下载失败')
    }
    return { ...state }
  }

  function install() {
    if (!supported || state.status !== 'downloaded') return false
    try {
      updater.quitAndInstall(false, true)
      return true
    } catch {
      fail('更新安装失败')
      return false
    }
  }

  function start(delayMs = 3000) {
    if (supported) schedule(() => { void check() }, delayMs)
    return { ...state }
  }

  return { getState: () => ({ ...state }), start, check, download, install }
}
