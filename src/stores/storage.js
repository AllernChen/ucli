import { defineStore } from 'pinia'

import { ipc } from '../ipc.js'

function safeError(error, fallback) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'STORAGE_OPERATION_FAILED',
    message: typeof error?.message === 'string' && error.message ? error.message : fallback
  }
}

export const useStorageStore = defineStore('storage', {
  state: () => ({ snapshot: null, loading: false, clearingId: null, error: null }),
  actions: {
    async applyLoad(sequence) {
      try {
        const snapshot = await ipc.getStorageUsage()
        if (sequence !== this._requestSequence) return null
        this.snapshot = snapshot
        this.error = null
        return snapshot
      } catch (error) {
        if (sequence !== this._requestSequence) return null
        this.error = safeError(error, '读取空间占用失败')
        return null
      } finally {
        if (sequence === this._requestSequence) this.loading = false
      }
    },

    load() {
      const sequence = this._nextRequestSequence()
      this.loading = true
      this.error = null
      return this.applyLoad(sequence)
    },

    async clearCategory(categoryId) {
      const operation = this._nextClearSequence()
      const sequence = this._nextRequestSequence()
      this.loading = false
      this.clearingId = categoryId
      this.error = null
      try {
        const result = await ipc.clearStorageCategory(categoryId)
        if (sequence === this._requestSequence) {
          this.loading = true
          await this.applyLoad(sequence)
        }
        return result
      } catch (error) {
        if (operation === this._clearSequence) this.error = safeError(error, '清理应用空间失败')
        throw error
      } finally {
        if (operation === this._clearSequence) this.clearingId = null
      }
    },

    _nextRequestSequence() {
      this._requestSequence = (this._requestSequence || 0) + 1
      return this._requestSequence
    },

    _nextClearSequence() {
      this._clearSequence = (this._clearSequence || 0) + 1
      return this._clearSequence
    }
  }
})
