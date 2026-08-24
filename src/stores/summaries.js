import { defineStore } from 'pinia'

import { ipc } from '../ipc.js'

let unsubscribeProgress = null
let initPromise = null
const deletedReportIds = new Set()

function withoutMarkdown(report) {
  if (!report) return report
  const { markdown, ...summary } = report
  return summary
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
      if (!unsubscribeProgress) {
        unsubscribeProgress = ipc.onSummaryProgress(payload => {
          this.applyProgress(payload)
        })
      }
      if (this.initialized) return
      if (initPromise) return initPromise
      this.loading = true
      this.error = null
      initPromise = ipc.listSummaryReports({}).then(reports => {
        this.reports = reports
        this.initialized = true
      }).catch(() => {
        this.error = new Error('无法读取总结报告')
        throw error
      }).finally(() => {
        this.loading = false
        initPromise = null
      })
      return initPromise
    },

    async loadReports(filters = this.filters) {
      const compact = Object.fromEntries(Object.entries(filters || {}).filter(([, value]) => value != null && value !== ''))
      this.filters = { ...this.filters, ...filters }
      this.reports = await ipc.listSummaryReports(compact)
      return this.reports
    },

    applyProgress(payload) {
      if (!payload?.reportId) return
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
      if (['completed', 'failed', 'cancelled', 'interrupted', 'skipped_empty'].includes(progress.phase)) {
        void this.refreshReport(progress.reportId).catch(() => { this.error = new Error('无法刷新总结报告') })
      }
    },

    upsertReport(report) {
      const index = this.reports.findIndex(item => item.id === report.id)
      if (index >= 0) this.reports.splice(index, 1, report)
      else this.reports.unshift(report)
      const versionIndex = this.versions.findIndex(item => item.id === report.id)
      if (versionIndex >= 0) this.versions.splice(versionIndex, 1, withoutMarkdown(report))
    },

    async refreshReport(reportId) {
      if (deletedReportIds.has(reportId)) return null
      const report = await ipc.getSummaryReport(reportId)
      if (deletedReportIds.has(reportId)) return null
      this.upsertReport(report)
      if (this.selectedReportId === reportId) this.selectedReportId = report.id
      const versionIndex = this.versions.findIndex(item => item.id === reportId)
      if (versionIndex >= 0) this.versions.splice(versionIndex, 1, withoutMarkdown(report))
      return report
    },

    async selectReport(reportId) {
      const report = await ipc.getSummaryReport(reportId)
      this.upsertReport(report)
      this.selectedReportId = report.id
      this.versions = await ipc.listSummaryReports({
        periodType: report.periodType,
        periodStart: report.periodStart,
        periodEndExclusive: report.periodEndExclusive,
        timezone: report.timezone
      })
      return report
    },

    async generateInteractive(request) {
      const { report, sessionId } = await ipc.startInteractiveSummary(request)
      const created = { ...report, sessionId: sessionId || report.sessionId || null }
      this.upsertReport(created)
      this.selectedReportId = created.id
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

    async cancel(reportId) {
      return ipc.cancelSummary(reportId)
    },

    async setCurrent(reportId) {
      const report = await ipc.setCurrentSummary(reportId)
      await this.selectReport(reportId)
      return report
    },

    async deleteReport(reportId) {
      const selectedId = this.selectedReport?.id || null
      deletedReportIds.add(reportId)
      let result
      try {
        result = await ipc.deleteSummaryReport(reportId)
      } catch (error) {
        deletedReportIds.delete(reportId)
        throw error
      }
      const progress = { ...this.progress }
      delete progress[reportId]
      this.progress = progress
      this.reports = this.reports.filter(report => report.id !== reportId)
      this.versions = this.versions.filter(report => report.id !== reportId)
      if (selectedId === reportId) this.selectedReportId = null

      await this.loadReports()
      const nextId =
        (selectedId !== reportId && this.reports.some(report => report.id === selectedId) ? selectedId : null) ||
        result.currentReportId ||
        this.reports[0]?.id || null
      if (nextId) await this.selectReport(nextId)
      else {
        this.selectedReportId = null
        this.versions = []
      }
      return result
    },

    exportMarkdown(reportId) {
      return ipc.exportSummaryMarkdown({ reportId })
    },

    exportHtml(reportId, style = { mode: 'theme', themeId: 'executive' }) {
      return ipc.exportSummaryHtml({ reportId, style })
    },

    dispose() {
      unsubscribeProgress?.()
      unsubscribeProgress = null
      initPromise = null
      this.$dispose()
    }
  }
})
