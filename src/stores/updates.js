import { defineStore } from 'pinia'

import { ipc } from '../ipc.js'

const INITIAL = Object.freeze({
  revision: 0,
  checkedAt: 0,
  status: 'idle',
  currentVersion: '',
  availableVersion: null,
  releaseDate: null,
  releaseNotes: '',
  progressPercent: null,
  transferred: null,
  total: null,
  bytesPerSecond: null,
  error: ''
})

export const useUpdatesStore = defineStore('updates', {
  state: () => ({ ...INITIAL, initialized: false }),
  actions: {
    applySnapshot(snapshot) {
      if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < this.revision) return false
      Object.assign(this, snapshot)
      return true
    },

    initialize() {
      if (this.initialized) return Promise.resolve(this.$state)
      if (this._initializePromise) return this._initializePromise
      if (!this._unsubscribe) this._unsubscribe = ipc.onUpdateState(snapshot => this.applySnapshot(snapshot))
      this._initializePromise = ipc.getUpdateState()
        .then(snapshot => {
          this.applySnapshot(snapshot)
          this.initialized = true
          return this.$state
        })
        .finally(() => { this._initializePromise = null })
      return this._initializePromise
    },

    async check() {
      const snapshot = await ipc.checkForUpdates()
      this.applySnapshot(snapshot)
      return snapshot
    },

    async download() {
      const snapshot = await ipc.downloadUpdate()
      this.applySnapshot(snapshot)
      return snapshot
    },

    install() { return ipc.installUpdate() },

    dispose() {
      this._unsubscribe?.()
      this._unsubscribe = null
      this._initializePromise = null
      this.$dispose()
    }
  }
})
