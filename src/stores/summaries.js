import { defineStore } from 'pinia'

import { ipc } from '../ipc.js'

let unsubscribeProgress = null
let initPromise = null

function terminalPhase(phase) {
  return ['completed', 'failed', 'cancelled', 'interrupted', 'skipped_empty'].includes(phase)
}

function withoutMarkdown(report) {
  if (!report) return report
  const { markdown, ...summary } = report
  return summary
}

export const useSummariesStore = defineStore('summaries', {
  state: () => ({
    settings: null,
    reports: [],
    selectedReport: null,
    versions: [],
    activeJobs: {},
    progress: {},
    filters: { periodType: null, status: null, generatedBy: null },
    loading: false,
    error: null,
    initialized: false
  }),
  actions: {
    async init() {
      if (!unsubscribeProgress) {
        unsubscribeProgress = ipc.onSummaryProgress(payload => {
          if (!payload?.reportId) return
          this.progress = { ...this.progress, [payload.reportId]: payload }
          if (terminalPhase(payload.phase)) {
            const jobs = { ...this.activeJobs }
            delete jobs[payload.reportId]
            this.activeJobs = jobs
            void this.refreshReport(payload.reportId).catch(error => { this.error = error })
          }
        })
      }
      if (this.initialized) return
      if (initPromise) return initPromise
      this.loading = true
      this.error = null
      initPromise = Promise.all([
        ipc.getSummarySettings(),
        ipc.listSummaryReports({})
      ]).then(([settings, reports]) => {
        this.settings = settings
        this.reports = reports
        this.initialized = true
      }).catch(error => {
        this.error = error
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

    async refreshReport(reportId) {
      const report = await ipc.getSummaryReport(reportId)
      const index = this.reports.findIndex(item => item.id === reportId)
      const summary = withoutMarkdown(report)
      if (index >= 0) this.reports.splice(index, 1, summary)
      else this.reports.unshift(summary)
      if (this.selectedReport?.id === reportId) this.selectedReport = report
      const versionIndex = this.versions.findIndex(item => item.id === reportId)
      if (versionIndex >= 0) this.versions.splice(versionIndex, 1, summary)
      return report
    },

    async selectReport(reportId) {
      const report = await ipc.getSummaryReport(reportId)
      this.selectedReport = report
      this.versions = await ipc.listSummaryReports({
        periodType: report.periodType,
        periodStart: report.periodStart,
        periodEndExclusive: report.periodEndExclusive,
        timezone: report.timezone
      })
      return report
    },

    async generate(request) {
      const result = await ipc.generateSummary(request)
      this.activeJobs = { ...this.activeJobs, [result.reportId]: true }
      this.progress = {
        ...this.progress,
        [result.reportId]: {
          reportId: result.reportId, phase: 'queued', completed: 0, total: 1, text: '等待生成'
        }
      }
      return result
    },

    retry(report) {
      return this.generate({
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

    async confirm(reportId) {
      const confirmationCallLimit = this.progress[reportId]?.total
      if (!Number.isInteger(confirmationCallLimit) || confirmationCallLimit < 1) {
        throw Object.assign(new Error('确认调用数不可用'), { code: 'INVALID_SUMMARY_CONFIRMATION' })
      }
      const result = await ipc.confirmSummary(reportId, confirmationCallLimit)
      this.activeJobs = { ...this.activeJobs, [reportId]: true }
      return result
    },

    async setCurrent(reportId) {
      const report = await ipc.setCurrentSummary(reportId)
      await this.selectReport(reportId)
      return report
    },

    exportMarkdown(reportId) {
      return ipc.exportSummaryMarkdown({ reportId })
    },

    exportHtml(reportId, style = { mode: 'light' }) {
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
