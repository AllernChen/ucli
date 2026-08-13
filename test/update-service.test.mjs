import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { createUpdateService } from '../electron/updateService.js'

class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowPrerelease = true
  allowDowngrade = true
  checkCalls = 0
  downloadCalls = 0
  quitArgs = null

  async checkForUpdates() {
    this.checkCalls += 1
    this.emit('update-available', {
      version: '0.10.2',
      releaseDate: '2026-08-13T00:00:00.000Z',
      releaseNotes: '<b>Safe</b> update'
    })
  }

  async downloadUpdate() { this.downloadCalls += 1 }
  quitAndInstall(...args) { this.quitArgs = args }
}

function createTimers() {
  const timers = new Map()
  let nextId = 1
  return {
    timers,
    schedule(callback, delay) {
      const id = nextId++
      timers.set(id, { callback, delay })
      return id
    },
    cancelSchedule(id) { timers.delete(id) },
    take(delay) {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay)
      assert.ok(entry, `missing timer ${delay}`)
      timers.delete(entry[0])
      return entry[1].callback
    }
  }
}

function createInstalledService(updater = new FakeUpdater(), options = {}) {
  return {
    updater,
    service: createUpdateService({
      updater,
      appVersion: '0.10.1',
      isPackaged: true,
      isPortable: false,
      platform: 'win32',
      now: () => 1786554000000,
      ...options
    })
  }
}

test('installed checks advance revision and publish a safe checked snapshot without automatic download', async () => {
  const published = []
  const { updater, service } = createInstalledService(new FakeUpdater(), {
    onStateChange: snapshot => published.push(snapshot)
  })
  const initial = service.getState()

  await service.check()
  const state = service.getState()

  assert.equal(updater.autoDownload, false)
  assert.equal(updater.autoInstallOnAppQuit, false)
  assert.equal(updater.allowPrerelease, false)
  assert.equal(updater.allowDowngrade, false)
  assert.ok(state.revision > initial.revision)
  assert.deepEqual(state, {
    revision: 3,
    checkedAt: 1786554000000,
    status: 'available',
    currentVersion: '0.10.1',
    availableVersion: '0.10.2',
    releaseDate: '2026-08-13T00:00:00.000Z',
    releaseNotes: 'Safe update',
    progressPercent: null,
    transferred: null,
    total: null,
    bytesPerSecond: null,
    error: ''
  })
  assert.equal(published.at(-1).checkedAt, 1786554000000)
  assert.equal(published.at(-1).revision, 3)
})

test('concurrent checks share one updater request', async () => {
  const updater = new FakeUpdater()
  let finish
  updater.checkForUpdates = () => {
    updater.checkCalls += 1
    return new Promise(resolve => { finish = resolve })
  }
  const { service } = createInstalledService(updater)

  const first = service.check()
  const second = service.check()
  assert.equal(updater.checkCalls, 1)
  finish()
  assert.deepEqual(await second, await first)
})

test('portable and development builds never schedule or call the network updater', async () => {
  for (const options of [
    { isPackaged: true, isPortable: true, platform: 'win32' },
    { isPackaged: false, isPortable: false, platform: 'win32' }
  ]) {
    const updater = new FakeUpdater()
    const timers = createTimers()
    const service = createUpdateService({ updater, appVersion: '0.10.1', ...options, ...timers })
    assert.equal(service.getState().status, 'unsupported')
    service.start()
    await service.check()
    assert.equal(updater.checkCalls, 0)
    assert.equal(timers.timers.size, 0)
  }
})

test('start checks after three seconds and rechecks eligible state after six hours', async () => {
  const updater = new FakeUpdater()
  updater.checkForUpdates = async () => {
    updater.checkCalls += 1
    updater.emit('update-not-available')
  }
  const timers = createTimers()
  const { service } = createInstalledService(updater, timers)

  service.start()
  await timers.take(3000)()
  assert.equal(updater.checkCalls, 1)
  await timers.take(21600000)()
  assert.equal(updater.checkCalls, 2)
  assert.deepEqual([...timers.timers.values()].map(timer => timer.delay), [21600000])
})

test('downloaded and installing states do not schedule a periodic check', async () => {
  const timers = createTimers()
  const { updater, service } = createInstalledService(new FakeUpdater(), timers)
  await service.check()
  updater.emit('update-downloaded', { version: '0.10.2' })
  service.start({ initialDelayMs: 0, intervalMs: 20 })
  await timers.take(0)()
  assert.equal([...timers.timers.values()].some(timer => timer.delay === 20), false)

  service.install()
  assert.equal(service.getState().status, 'installing')
  assert.equal([...timers.timers.values()].some(timer => timer.delay === 20), false)
})

test('an already scheduled periodic callback rechecks state before using the network', async () => {
  const updater = new FakeUpdater()
  updater.checkForUpdates = async () => {
    updater.checkCalls += 1
    updater.emit('update-not-available')
  }
  const timers = createTimers()
  const { service } = createInstalledService(updater, timers)
  service.start({ initialDelayMs: 0, intervalMs: 20 })
  await timers.take(0)()
  assert.equal(updater.checkCalls, 1)

  const scheduled = timers.take(20)
  updater.emit('update-downloaded', { version: '0.10.2' })
  await scheduled()

  assert.equal(updater.checkCalls, 1)
  assert.equal(service.getState().status, 'downloaded')
})

test('entering a noneligible state cancels a pending periodic timer', async () => {
  const updater = new FakeUpdater()
  updater.checkForUpdates = async () => {
    updater.checkCalls += 1
    updater.emit('update-not-available')
  }
  const timers = createTimers()
  const { service } = createInstalledService(updater, timers)
  service.start({ initialDelayMs: 0, intervalMs: 20 })
  await timers.take(0)()
  assert.equal([...timers.timers.values()].some(timer => timer.delay === 20), true)

  updater.emit('update-available', { version: '0.10.2' })

  assert.equal([...timers.timers.values()].some(timer => timer.delay === 20), false)
})

test('an eligible error transition schedules a new periodic retry', async () => {
  const updater = new FakeUpdater()
  updater.checkForUpdates = async () => {
    updater.checkCalls += 1
    updater.emit('update-available', { version: '0.10.2' })
  }
  const timers = createTimers()
  const { service } = createInstalledService(updater, timers)
  service.start({ initialDelayMs: 0, intervalMs: 20 })
  await timers.take(0)()
  assert.equal(timers.timers.size, 0)

  updater.emit('error', new Error('private network detail'))

  assert.deepEqual([...timers.timers.values()].map(timer => timer.delay), [20])
})

test('a manual eligible check restores the periodic timer after the request settles', async () => {
  const updater = new FakeUpdater()
  updater.checkForUpdates = async () => {
    updater.checkCalls += 1
    await Promise.resolve()
    updater.emit('update-not-available')
  }
  const timers = createTimers()
  const { service } = createInstalledService(updater, timers)
  service.start({ initialDelayMs: 0, intervalMs: 20 })
  await timers.take(0)()
  assert.deepEqual([...timers.timers.values()].map(timer => timer.delay), [20])

  await service.check()

  assert.equal(updater.checkCalls, 2)
  assert.deepEqual([...timers.timers.values()].map(timer => timer.delay), [20])
})

test('manual checks do not use the network or replace active update states', async () => {
  for (const status of ['downloading', 'downloaded', 'installing']) {
    const updater = new FakeUpdater()
    const { service } = createInstalledService(updater)
    await service.check()
    if (status === 'downloading') await service.download()
    else {
      updater.emit('update-downloaded', { version: '0.10.2' })
      if (status === 'installing') service.install()
    }
    const calls = updater.checkCalls
    const before = service.getState()

    const after = await service.check()

    assert.equal(updater.checkCalls, calls, status)
    assert.deepEqual(after, before, status)
  }
})

test('stop cancels initial, periodic, and install timers', async () => {
  const updater = new FakeUpdater()
  updater.checkForUpdates = async () => {
    updater.checkCalls += 1
    updater.emit('update-not-available')
  }
  const timers = createTimers()
  const { service } = createInstalledService(updater, timers)

  service.start({ initialDelayMs: 5, intervalMs: 10 })
  await timers.take(5)()
  assert.deepEqual([...timers.timers.values()].map(timer => timer.delay), [10])
  service.stop()
  assert.equal(timers.timers.size, 0)
})

test('download progress and installation keep monotonic snapshots', async () => {
  const timers = createTimers()
  const { updater, service } = createInstalledService(new FakeUpdater(), timers)
  await service.check()
  await service.download()
  updater.emit('download-progress', {
    percent: 42.4, transferred: 10, total: 24, bytesPerSecond: 2
  })
  const progress = service.getState()
  assert.equal(progress.status, 'downloading')
  assert.equal(progress.progressPercent, 42)

  updater.emit('update-downloaded', { version: '0.10.2' })
  const downloadedRevision = service.getState().revision
  assert.equal(service.install(), true)
  assert.ok(service.getState().revision > downloadedRevision)
  timers.take(200)()
  assert.deepEqual(updater.quitArgs, [false, true])
})

test('main-facing strings and counters are bounded before state publication', async () => {
  const updater = new FakeUpdater()
  updater.checkForUpdates = async () => {
    updater.checkCalls += 1
    updater.emit('update-available', {
      version: 'v'.repeat(100),
      releaseNotes: `<p>${'n'.repeat(5000)}</p>`
    })
  }
  const { service } = createInstalledService(updater, {
    appVersion: 'c'.repeat(100),
    now: () => Number.MAX_SAFE_INTEGER + 100
  })

  await service.check()
  const state = service.getState()
  assert.equal(state.currentVersion.length, 64)
  assert.equal(state.availableVersion.length, 64)
  assert.equal(state.releaseNotes.length, 4000)
  assert.equal(state.checkedAt, Number.MAX_SAFE_INTEGER)
  assert.ok(Number.isSafeInteger(state.revision))
})

test('update failures expose only a stable Chinese message', async () => {
  const updater = new FakeUpdater()
  updater.checkForUpdates = async () => {
    updater.checkCalls += 1
    throw Object.assign(new Error('https://token.example.invalid C:\\secret'), {
      headers: { authorization: 'Bearer secret' }
    })
  }
  const { service } = createInstalledService(updater)

  await service.check()
  const state = service.getState()
  assert.equal(state.status, 'error')
  assert.equal(state.error, '更新检查失败')
  assert.doesNotMatch(JSON.stringify(state), /token|secret|Bearer|https:/i)
})
