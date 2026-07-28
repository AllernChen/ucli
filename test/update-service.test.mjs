import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
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
      version: '0.4.8',
      releaseDate: '2026-07-29T00:00:00.000Z',
      releaseNotes: '<b>Safe</b> update'
    })
  }

  async downloadUpdate() {
    this.downloadCalls += 1
  }

  quitAndInstall(...args) {
    this.quitArgs = args
  }
}

function createInstalledService(updater = new FakeUpdater()) {
  return {
    updater,
    service: createUpdateService({
      updater,
      appVersion: '0.4.7',
      isPackaged: true,
      isPortable: false,
      platform: 'win32'
    })
  }
}

test('installed builds check without automatic download and publish a safe available state', async () => {
  const { updater, service } = createInstalledService()

  await service.check()

  assert.equal(updater.autoDownload, false)
  assert.equal(updater.autoInstallOnAppQuit, false)
  assert.equal(updater.allowPrerelease, false)
  assert.equal(updater.allowDowngrade, false)
  assert.deepEqual(service.getState(), {
    status: 'available',
    currentVersion: '0.4.7',
    availableVersion: '0.4.8',
    releaseDate: '2026-07-29T00:00:00.000Z',
    releaseNotes: 'Safe update',
    progressPercent: null,
    error: ''
  })
})

test('portable and development builds never call the network updater', async () => {
  const portable = new FakeUpdater()
  const development = new FakeUpdater()
  const portableService = createUpdateService({ updater: portable, appVersion: '0.4.7', isPackaged: true, isPortable: true, platform: 'win32' })
  const developmentService = createUpdateService({ updater: development, appVersion: '0.4.7', isPackaged: false, isPortable: false, platform: 'win32' })

  assert.equal(portableService.getState().status, 'unsupported')
  assert.equal(developmentService.getState().status, 'unsupported')
  await portableService.check()
  await developmentService.check()

  assert.equal(portable.checkCalls, 0)
  assert.equal(development.checkCalls, 0)
})

test('download and install require available then downloaded states', async () => {
  const { updater, service } = createInstalledService()

  assert.equal(service.install(), false)
  await service.download()
  assert.equal(updater.downloadCalls, 0)

  await service.check()
  await service.download()
  assert.equal(updater.downloadCalls, 1)
  updater.emit('download-progress', { percent: 42.4 })
  assert.equal(service.getState().status, 'downloading')
  assert.equal(service.getState().progressPercent, 42)

  updater.emit('update-downloaded', { version: '0.4.8' })
  assert.equal(service.getState().status, 'downloaded')
  assert.equal(service.install(), true)
  assert.deepEqual(updater.quitArgs, [false, true])
})

test('update errors expose a generic status without raw network details', async () => {
  const updater = new FakeUpdater()
  updater.checkForUpdates = async () => {
    throw new Error('request https://token.example.invalid failed')
  }
  const { service } = createInstalledService(updater)

  await service.check()

  assert.deepEqual(service.getState(), {
    status: 'error',
    currentVersion: '0.4.7',
    availableVersion: null,
    releaseDate: null,
    releaseNotes: '',
    progressPercent: null,
    error: '更新检查失败'
  })
})
