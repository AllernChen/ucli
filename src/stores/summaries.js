import { defineStore } from 'pinia'

import { ipc } from '../ipc.js'

function withoutMarkdown(report) {
  if (!report) return report
  const { markdown, ...summary } = report
  return summary
}

function samePeriod(report) {
  return {
    periodType: report.periodType,
    periodStart: report.periodStart,
    periodEndExclusive: report.periodEndExclusive,
    timezone: report.timezone
  }
}

const storeMetadata = new WeakMap()

function metadata(store) {
  const state = store.$state
  let value = storeMetadata.get(state)
  if (!value) {
    value = { unsubscribe: null, initPromise: null, selectionEpoch: 0, terminalReports: new Set(), deletedReports: new Set() }
    storeMetadata.set(state, value)
  }
  return value
}

function isTerminal(phase) {
  return ['completed', 'failed', 'cancelled', 'interrupted', 'skipped_empty'].includes(phase)
}

export const useSummariesStore = defineStore('summaries', {
  state: () => ({
    reports: [],
    selectedReportId: null,
    versions: [],
    progress: {},
    filters: { periodType: null, status: null, generatedBy: null },
    loading: false,
    error: null,
    initialized: false
  }),
  getters: {
    selectedReport: state => state.reports.find(report => report.id === state.selectedReportId) || null
  },
  actions: {
    async init() {
      const meta = metadata(this)
      if (!meta.unsubscribe) meta.unsubscribe = ipc.onSummaryProgress(payload => this.applyProgress(payload))
      if (this.initialized) return this.reports
      if (meta.initPromise) return meta.initPromise
      this.loading = true
      this.error = null
      meta.initPromise = ipc.listSummaryReports({}).then(reports => {
        this.reports = reports
        this.initialized = true
        return reports
      }).catch(error => {
        this.error = new Error('无法读取总结报告')
        throw error
      }).finally(() => {
        this.loading = false
        meta.initPromise = null
      })
      return meta.initPromise
    },

    async loadReports(filters = this.filters) {
      const compact = Object.fromEntries(Object.entries(filters || {}).filter(([, value]) => value != null && value !== ''))
      this.filters = { ...this.filters, ...filters }
      this.reports = await ipc.listSummaryReports(compact)
      return this.reports
    },

    applyProgress(payload) {
      if (!payload?.reportId) return
      const meta = metadata(this)
      if (meta.terminalReports.has(payload.reportId) && !isTerminal(payload.phase)) return
      const progress = {
        reportId: payload.reportId,
        status: payload.status,
        phase: payload.phase,
        completed: payload.completed,
        total: payload.total,
        text: payload.text
      }
      this.progress = { ...this.progress, [progress.reportId]: progress }
      const report = this.reports.find(item => item.id === progress.reportId)
      if (report) Object.assign(report, {
        status: progress.status,
        runPhase: progress.phase,
        progressText: progress.text
      })
      if (isTerminal(progress.phase)) {
        meta.terminalReports.add(progress.reportId)
        void this.refreshReport(progress.reportId).catch(error => {
          if (error?.code !== 'SUMMARY_REPORT_NOT_FOUND') this.error = new Error('无法刷新总结报告')
        })
      }
    },

    upsertReport(report) {
      const index = this.reports.findIndex(item => item.id === report.id)
      if (index >= 0) this.reports.splice(index, 1, report)
      else this.reports.unshift(report)
      const versionIndex = this.versions.findIndex(item => item.id === report.id)
      if (versionIndex >= 0) this.versions.splice(versionIndex, 1, withoutMarkdown(report))
    },

    removeProjection(reportId) {
      this.reports = this.reports.filter(report => report.id !== reportId)
      this.versions = this.versions.filter(report => report.id !== reportId)
      const progress = { ...this.progress }
      delete progress[reportId]
      this.progress = progress
      if (this.selectedReportId === reportId) this.selectedReportId = null
    },

    async refreshReport(reportId) {
      const meta = metadata(this)
      if (meta.deletedReports.has(reportId)) return null
      let report
      try {
        report = await ipc.getSummaryReport(reportId)
      } catch (error) {
        if (error?.code === 'SUMMARY_REPORT_NOT_FOUND') {
          this.removeProjection(reportId)
          return null
        }
        throw error
      }
      if (meta.deletedReports.has(reportId)) return null
      this.upsertReport(report)
      const versionIndex = this.versions.findIndex(item => item.id === reportId)
      if (versionIndex >= 0) this.versions.splice(versionIndex, 1, withoutMarkdown(report))
      return report
    },

    async selectReport(reportId) {
      const meta = metadata(this)
      const epoch = ++meta.selectionEpoch
      const report = await ipc.getSummaryReport(reportId)
      if (epoch !== meta.selectionEpoch) return this.selectedReport
      this.upsertReport(report)
      this.selectedReportId = report.id
      const versions = await ipc.listSummaryReports(samePeriod(report))
      if (epoch !== meta.selectionEpoch) return this.selectedReport
      this.versions = versions
      return report
    },

    async generateInteractive(request) {
      const meta = metadata(this)
      const epoch = ++meta.selectionEpoch
      const { report, sessionId } = await ipc.startInteractiveSummary(request)
      const created = { ...report, sessionId: sessionId || report.sessionId || null }
      if (epoch !== meta.selectionEpoch) return created
      this.upsertReport(created)
      this.selectedReportId = created.id
      const listed = await ipc.listSummaryReports(samePeriod(created))
      if (epoch !== meta.selectionEpoch) return created
      this.versions = listed.some(item => item.id === created.id)
        ? listed
        : [withoutMarkdown(created), ...listed]
      return created
    },

    retry(report) {
      return this.generateInteractive({
        periodType: report.periodType,
        start: report.periodStart,
        endExclusive: report.periodEndExclusive,
        timezone: report.timezone,
        partial: report.partial === true,
        executorId: report.executorId,
        profileId: report.profileId || null,
        model: report.model || null
      })
    },

    cancel(reportId) {
      return ipc.cancelSummary(reportId)
    },

    async setCurrent(reportId) {
      await ipc.setCurrentSummary(reportId)
      return this.selectReport(reportId)
    },

    async deleteReport(reportId) {
      const meta = metadata(this)
      const selectedId = this.selectedReportId
      meta.deletedReports.add(reportId)
      let result
      try {
        result = await ipc.deleteSummaryReport(reportId)
      } catch (error) {
        meta.deletedReports.delete(reportId)
        throw error
      }
      this.removeProjection(reportId)
      await this.loadReports()
      const nextId =
        (selectedId !== reportId && this.reports.some(report => report.id === selectedId) ? selectedId : null) ||
        result.currentReportId ||
        this.reports[0]?.id || null
      if (nextId) await this.selectReport(nextId)
      else this.versions = []
      return result
    },

    exportMarkdown(reportId) {
      return ipc.exportSummaryMarkdown({ reportId })
    },

    exportHtml(reportId, style = { mode: 'theme', themeId: 'executive' }) {
      return ipc.exportSummaryHtml({ reportId, style })
    },

    dispose() {
      const meta = metadata(this)
      meta.unsubscribe?.()
      meta.unsubscribe = null
      meta.initPromise = null
      storeMetadata.delete(this.$state)
      this.$dispose()
    }
  }
})
