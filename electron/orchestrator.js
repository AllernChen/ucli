import { app, ipcMain, dialog, shell, Notification, safeStorage } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync, existsSync, unlinkSync, statSync, writeFileSync } from 'fs'
import { createHash, randomUUID } from 'crypto'
import { openAllowedExternalUrl } from './externalLinks.js'
import { PermissionEngine } from './permission/engine.js'
import { startHookServer } from './permission/hookServer.js'
import { describeBlacklist } from './permission/blacklist.js'
import { classify, toClassifierInput, parsePattern } from './permission/classifier.js'
import { DEFAULT_RULESET, upgradeDefaultRuleset } from './permission/defaultRules.js'
import { createAdapterMap } from './adapterRegistry.js'
import { TIER } from './adapters/cliAdapter.js'
import {
  normalizeAdapterCapabilities,
  resolveAdapterCapabilities
} from './adapters/adapterCapabilities.js'
import {
  normalizePersistedSessionConfig,
  normalizeSessionConfig
} from './adapters/adapterSessionConfig.js'
import { openDb, getDb } from './persistence/db.js'
import { initLogger, log, truncateLog } from './logger.js'
import { inspectCliTools, runCliToolAction } from './cliTools.js'
import {
  SUPPORTED_DSH_VERSION,
  inspectDshRuntime,
  launchDshWebSurface,
  normalizeDshWebSurfaceState,
  resolveDshHome,
  runResolvedProcess
} from './adapters/deepSeekHarnessRuntime.js'
import { parseDshHistory } from './sessionHistory.js'
import { createDshProfileManager, registerDshProfileIpc } from './adapters/dshProfileManager.js'
import { createDshRuntimeManager } from './adapters/dshRuntimeManager.js'
import { createDshStatsPoller } from './adapters/dshStatsPoller.js'
import { createDshWebClient } from './adapters/dshWebClient.js'
import { createDshHistoryExporter } from './adapters/dshHistoryExporter.js'
import { createDiagnosticsService } from './diagnosticsService.js'
import { createSessionDiagnosticsService, registerSessionDiagnosticsIpc } from './sessionDiagnosticsService.js'
import { annotateImportedSessions, isSafeNativeSessionId, isSafeProviderName, listClaudeTranscriptFiles, resolveCodexResumeProvider, resolveCodexTranscriptSessionInHome } from './sessionDiscovery.js'
import { readCodexRuntimeSnapshot, resolveCodexHome } from './codexRuntimeConfig.js'
import { readClaudeRuntimeSnapshot } from './claudeRuntimeConfig.js'
import { normaliseCodexProviderPolicy, reconcileCodexRuntimeProvider, requiresCodexProcessRestart, resolveCodexProviderPolicy } from './codexProviderPolicy.js'
import { createCodexConfigWatcher } from './codexConfigWatcher.js'
import * as codexProfileFiles from './aiCliProfiles/codexProfileFile.js'
import { ProfileSecretStore } from './aiCliProfiles/profileSecretStore.js'
import { createProfileService } from './aiCliProfiles/profileService.js'
import { reconcileActiveProfile } from './aiCliProfiles/profileResolver.js'
import {
  describeClaudeModelSelection,
  isSafeClaudeModel,
  normalizeClaudeHistoryModel,
  prepareClaudeProfileSession
} from './aiCliProfiles/claudeProfileAdapter.js'
import {
  armClaudeProfileLaunch,
  claudeProfileLaunchStamp
} from './aiCliProfiles/claudeLaunchCoordinator.js'
import { registerAiCliProfileIpc } from './aiCliProfiles/ipc.js'
import { createSkillSourceLoader } from './skills/sourceLoader.js'
import { createSkillsService } from './skills/service.js'
import { registerSkillsIpc } from './skills/ipc.js'
import { listUCodeSkills } from './skills/ucodeDiscovery.js'
import { exportOpenCodeSession } from './openCodeStats.js'
import { createSessionHistoryService, registerSessionHistoryIpc } from './sessionHistoryService.js'
import { createSessionArtifactsService, registerSessionArtifactsIpc } from './sessionArtifactsService.js'
import { createUsageRecorder, normalizeAdapterStatsEvent } from './usage/usageRecorder.js'
import { aggregateOwnedModelStats, sessionUsesUcliStats } from './usage/statsOwnership.js'
import { assertUsageQuery } from './usage/contracts.js'
import { createUsageQueryService } from './usage/usageQueryService.js'
import { completedPeriod, manualPeriod } from './usage/periods.js'
import { createEvidenceCollector } from './summaries/evidenceCollector.js'
import { createSummaryPipeline } from './summaries/chunkPlanner.js'
import { createReportRepository } from './summaries/reportRepository.js'
import { normalizeSummaryTaskMetadata } from '../shared/summaryTaskContracts.js'
import { createReportExportService } from './summaries/reportExportService.js'
import { createSummaryJobService } from './summaries/summaryJobService.js'
import { createSummaryRunner } from './summaries/summaryRunner.js'
import { createSummaryCacheService } from './summaries/summaryCacheService.js'
import { resolveSummaryStorageRoot, resolveSummaryChild, resolveSummaryWorkLogsRoot } from './summaries/summaryStoragePaths.js'
import { createSummaryWorkspaceService } from './summaries/summaryWorkspaceService.js'
import { createSummaryPreparationService } from './summaries/summaryPreparationService.js'
import { createInteractiveSummarySessionRuntime } from './summaries/interactiveSummarySessionRuntime.js'
import { createInteractiveSummaryJobService } from './summaries/interactiveSummaryJobService.js'
import { createLegacyWorkLogsImporter } from './summaries/legacyWorkLogsImporter.js'
import { runSummaryMaintenance, runSummaryStartupLifecycle, safeStartupFailure } from './startupLifecycle.js'
import { SUMMARY_THEME_IDS } from './summaries/summaryThemeCatalog.js'
import {
  createSummaryOperationalLogEntry,
  safeSummaryErrorCode
} from './summaries/operationalLog.js'
import {
  DEFAULT_SUMMARY_SETTINGS,
  createSummaryScheduler,
  normalizeSummarySettings,
  profileAvailableForSummary,
  profileProvidesSummaryAuthentication,
  updateSummarySettings
} from './summaries/summaryScheduler.js'
import { registerGatewayIpc } from './gateway/ipc.js'
import { ServerCredentialStore } from './serverConnection/credentialStore.js'
import { RegistrationAttemptStore } from './serverConnection/registrationAttempts.js'
import { createDeviceGrantClient } from './serverConnection/deviceGrantClient.js'
import { ConnectionManager } from './serverConnection/connectionManager.js'
import { registerServerConnectionIpc } from './serverConnection/ipc.js'
import { resolveUcliStorageRoots, STORAGE_CATEGORY_IDS } from './storage/storageCatalog.js'
import { scanStorageCategories } from './storage/storageScanner.js'
import { createStorageManagementService } from './storage/storageManagementService.js'
import { GatewayManager } from './gateway/manager.js'
import {
  createGatewayPort,
  createGatewaySessionOperations,
  describeGatewaySessionEligibility,
  sendAdapterTurn
} from './gateway/orchestratorPort.js'
import { SessionSignalBus } from './gateway/sessionSignalBus.js'
import {
  advanceSessionNotification,
  advanceTaskCompletion,
  describeApprovalNotification,
  describeSessionAttentionNotification,
  describeTaskCompletionNotification,
  operationTypeForTool,
  shouldShowApprovalNotification
} from './approvalNotification.js'

const DEFAULT_SETTINGS = {
  defaultTier: TIER.SAFETY_RULES,
  defaultAdapter: 'claude',
  defaultCwd: '',
  codexConfigDir: '',
  language: 'zh-CN',
  theme: 'light'
}

const SUMMARY_SETTINGS_FIELDS = new Set([
  'autoEnabled', 'autoPeriods', 'defaultExecutorId', 'defaultProfileId',
  'defaultModel', 'firstEnableDisclosureAcceptedAt', 'automaticCallLimit',
  'cacheEnabled', 'cacheMaxBytes', 'failedWorkspaceRetentionDays', 'mapConcurrency'
])
const SUMMARY_CACHE_CLEAR_FIELDS = new Set(['includeFailedWorkspaces'])
const SUMMARY_REPORT_FILTER_FIELDS = new Set([
  'periodType', 'status', 'generatedBy', 'timezone', 'periodStart',
  'periodEndExclusive', 'isCurrent'
])
const SUMMARY_GENERATE_FIELDS = new Set([
  'periodType', 'start', 'endExclusive', 'timezone', 'partial',
  'executorId', 'profileId', 'model'
])
const SUMMARY_INTERACTIVE_FIELDS = new Set([
  'periodType', 'start', 'endExclusive', 'timezone', 'partial',
  'executorId', 'profileId', 'model'
])
const SUMMARY_CONFIRM_FIELDS = new Set(['reportId', 'confirm', 'confirmationCallLimit'])
const SUMMARY_EXPORT_FIELDS = new Set(['reportId', 'style'])
const SUMMARY_STYLE_FIELDS = new Set(['mode', 'themeId', 'requirement'])
const SUMMARY_HTML_THEME_IDS = new Set(SUMMARY_THEME_IDS)
const SUMMARY_PERIODS = new Set(['day', 'week', 'month', 'quarter', 'year'])
const SUMMARY_EXECUTORS = new Set(['claude', 'codex', 'opencode', 'ucode'])
const SUMMARY_MIN_EPOCH_MS = Date.UTC(2000, 0, 1)
const SUMMARY_MAX_FUTURE_MS = 2 * 24 * 60 * 60 * 1000
const SUMMARY_MAX_SPAN_MS = 367 * 24 * 60 * 60 * 1000
const SUMMARY_ERROR_MESSAGES = Object.freeze({
  INVALID_SUMMARY_IPC: 'Invalid summary request',
  SUMMARY_SERVICE_UNAVAILABLE: 'Summary service is unavailable',
  SUMMARY_EXPORT_UNAVAILABLE: 'Summary export is unavailable',
  SUMMARY_HTML_GENERATION_FAILED: 'AI CLI failed while generating HTML',
  SUMMARY_HTML_INVALID: 'Generated HTML failed safety validation',
  INVALID_SUMMARY_EXPORT_STYLE: 'Invalid HTML export style',
  SUMMARY_REPORT_NOT_FOUND: 'Summary report was not found',
  SUMMARY_REPORT_ACTIVE: 'Cancel the active summary before deleting it',
  SUMMARY_REPORT_NOT_COMPLETED: 'Only a completed report can be current',
  SUMMARY_CONFIRMATION_IN_PROGRESS: 'Summary confirmation is already in progress',
  SUMMARY_AUTOMATION_UNAVAILABLE: 'Automatic summaries require local persistence',
  SUMMARY_EXECUTOR_UNAVAILABLE: 'Select an available default AI CLI',
  SUMMARY_EXECUTOR_AUTH_UNAVAILABLE: 'Selected AI CLI requires an isolated summary credential',
  SUMMARY_EXECUTOR_UNSAFE: 'Selected AI CLI cannot guarantee tool-free summary execution',
  SUMMARY_PROFILE_UNAVAILABLE: 'Select an available default AI CLI profile',
  SUMMARY_DISCLOSURE_REQUIRED: 'Automatic summaries require disclosure acceptance',
  SUMMARY_JOB_NOT_ACTIVE: 'Summary job is not active',
  SUMMARY_DELETE_DRAIN_FAILED: 'Summary task could not be stopped for deletion',
  SUMMARY_READY_TIMEOUT: 'AI CLI startup timed out',
  SUMMARY_TURN_NOT_CONFIRMED: 'Summary instruction delivery was not confirmed',
  SUMMARY_RUN_TIMEOUT: 'Interactive summary generation timed out',
  SUMMARY_ARTIFACT_MISSING: 'Summary Markdown report was not generated',
  SUMMARY_ARTIFACT_INVALID: 'Summary Markdown report is invalid',
  SUMMARY_APP_SHUTDOWN: 'Interactive summary was interrupted by application shutdown',
  SUMMARY_RUN_FAILED: 'Interactive summary generation failed'
})

const STORAGE_CATEGORY_ID_SET = new Set(STORAGE_CATEGORY_IDS)
const STORAGE_STATUSES = new Set(['ready', 'partial', 'unavailable', 'busy', 'scheduled'])
const STORAGE_CLEAR_MODES = new Set(['none', 'immediate', 'restart'])

function invalidStorageRequest() {
  return Object.assign(new Error('Invalid storage request'), { code: 'INVALID_STORAGE_REQUEST' })
}

function storageSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

export function validateStorageClear(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).length !== 1 || typeof value.categoryId !== 'string' ||
    !STORAGE_CATEGORY_ID_SET.has(value.categoryId)) throw invalidStorageRequest()
  return { categoryId: value.categoryId }
}

function safeStorageCategory(value = {}) {
  return {
    id: STORAGE_CATEGORY_ID_SET.has(value.id) ? value.id : '',
    bytes: storageSafeInteger(value.bytes),
    itemCount: storageSafeInteger(value.itemCount),
    reclaimableBytes: storageSafeInteger(value.reclaimableBytes),
    status: STORAGE_STATUSES.has(value.status) ? value.status : 'unavailable',
    clearMode: STORAGE_CLEAR_MODES.has(value.clearMode) ? value.clearMode : 'none'
  }
}

function safeStorageSnapshot(value = {}) {
  return {
    revision: storageSafeInteger(value.revision),
    scannedAt: storageSafeInteger(value.scannedAt),
    totalBytes: storageSafeInteger(value.totalBytes),
    reclaimableBytes: storageSafeInteger(value.reclaimableBytes),
    pendingRestart: Array.isArray(value.pendingRestart)
      ? value.pendingRestart.filter(id => STORAGE_CATEGORY_ID_SET.has(id))
      : [],
    categories: Array.isArray(value.categories) ? value.categories.map(safeStorageCategory) : []
  }
}

function safeStorageClearResult(value = {}) {
  return {
    categoryId: STORAGE_CATEGORY_ID_SET.has(value.categoryId) ? value.categoryId : '',
    pendingRestart: value.pendingRestart === true,
    removed: storageSafeInteger(value.removed),
    bytes: storageSafeInteger(value.bytes),
    remainingBytes: storageSafeInteger(value.remainingBytes),
    partial: value.partial === true
  }
}

function storageOperationError(error) {
  if (error?.code === 'INVALID_STORAGE_REQUEST' ||
    error?.code === 'STORAGE_CATEGORY_PROTECTED' ||
    error?.code === 'STORAGE_CATEGORY_UNKNOWN') return error
  return Object.assign(new Error('Storage operation failed'), { code: 'STORAGE_OPERATION_FAILED' })
}

export function registerStorageIpc({ ipcMain, service }) {
  ipcMain.handle('storage:get-usage', async (_event, ...args) => {
    try {
      if (args.length !== 0) throw invalidStorageRequest()
      return safeStorageSnapshot(await service.getUsage())
    } catch (error) {
      throw storageOperationError(error)
    }
  })
  ipcMain.handle('storage:clear', async (_event, value) => {
    try {
      return safeStorageClearResult(await service.clear(validateStorageClear(value)))
    } catch (error) {
      throw storageOperationError(error)
    }
  })
}

function splitSettingsPatch(value = {}) {
  const appSettings = {}
  const summary = {}
  for (const [key, item] of Object.entries(value && typeof value === 'object' ? value : {})) {
    if (SUMMARY_SETTINGS_FIELDS.has(key)) summary[key] = item
    else appSettings[key] = item
  }
  return { appSettings, summary }
}

function invalidSummaryIpc() {
  return Object.assign(new Error('Invalid summary request'), { code: 'INVALID_SUMMARY_IPC' })
}

function summaryObject(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !fields.has(key))) throw invalidSummaryIpc()
  return value
}

function validateSummaryId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw invalidSummaryIpc()
  }
  return value
}

function validateSummaryTimezone(value) {
  if (typeof value !== 'string' || !value || value.length > 100) throw invalidSummaryIpc()
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0) } catch { throw invalidSummaryIpc() }
  return value
}

function validateSummarySettings(value) {
  const result = { ...summaryObject(value, SUMMARY_SETTINGS_FIELDS) }
  if (result.autoEnabled !== undefined && typeof result.autoEnabled !== 'boolean') throw invalidSummaryIpc()
  if (result.autoPeriods !== undefined) {
    summaryObject(result.autoPeriods, SUMMARY_PERIODS)
    if (Object.values(result.autoPeriods).some(item => typeof item !== 'boolean')) throw invalidSummaryIpc()
    result.autoPeriods = { ...result.autoPeriods }
  }
  if (result.defaultExecutorId !== undefined && result.defaultExecutorId !== null &&
    !SUMMARY_EXECUTORS.has(result.defaultExecutorId)) throw invalidSummaryIpc()
  for (const field of ['defaultProfileId', 'defaultModel']) {
    if (result[field] !== undefined && result[field] !== null &&
      (typeof result[field] !== 'string' || !result[field] || result[field].length > 200 || result[field].includes('\0'))) {
      throw invalidSummaryIpc()
    }
  }
  if (result.firstEnableDisclosureAcceptedAt !== undefined &&
    result.firstEnableDisclosureAcceptedAt !== null &&
    (!Number.isInteger(result.firstEnableDisclosureAcceptedAt) || result.firstEnableDisclosureAcceptedAt <= 0)) {
    throw invalidSummaryIpc()
  }
  if (result.automaticCallLimit !== undefined &&
    (!Number.isInteger(result.automaticCallLimit) || result.automaticCallLimit < 1 || result.automaticCallLimit > 100)) {
    throw invalidSummaryIpc()
  }
  if (result.cacheEnabled !== undefined && typeof result.cacheEnabled !== 'boolean') {
    throw invalidSummaryIpc()
  }
  if (result.cacheMaxBytes !== undefined && ![
    268435456, 536870912, 1073741824, 2147483648, 5368709120
  ].includes(result.cacheMaxBytes)) throw invalidSummaryIpc()
  if (result.failedWorkspaceRetentionDays !== undefined &&
    ![1, 3, 7, 14, 30].includes(result.failedWorkspaceRetentionDays)) throw invalidSummaryIpc()
  if (result.mapConcurrency !== undefined && ![1, 2, 3].includes(result.mapConcurrency)) {
    throw invalidSummaryIpc()
  }
  return result
}

function validateSummaryCacheClear(value) {
  const result = { ...summaryObject(value, SUMMARY_CACHE_CLEAR_FIELDS) }
  if (typeof result.includeFailedWorkspaces !== 'boolean') throw invalidSummaryIpc()
  return result
}

function validateSummaryFilters(value = {}) {
  const result = { ...summaryObject(value, SUMMARY_REPORT_FILTER_FIELDS) }
  if (result.periodType !== undefined && !SUMMARY_PERIODS.has(result.periodType)) throw invalidSummaryIpc()
  if (result.status !== undefined && ![
    'queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted',
    'awaiting_confirmation', 'skipped_empty'
  ].includes(result.status)) throw invalidSummaryIpc()
  if (result.generatedBy !== undefined && !['manual', 'automatic'].includes(result.generatedBy)) throw invalidSummaryIpc()
  if (result.timezone !== undefined) result.timezone = validateSummaryTimezone(result.timezone)
  for (const field of ['periodStart', 'periodEndExclusive']) {
    if (result[field] !== undefined && !Number.isInteger(result[field])) throw invalidSummaryIpc()
  }
  if (result.isCurrent !== undefined && typeof result.isCurrent !== 'boolean') throw invalidSummaryIpc()
  return result
}

function validateSummaryGenerate(value) {
  if (value?.confirm === true || value?.reportId !== undefined) {
    const confirmation = { ...summaryObject(value, SUMMARY_CONFIRM_FIELDS) }
    if (confirmation.confirm !== true || !Number.isInteger(confirmation.confirmationCallLimit) ||
      confirmation.confirmationCallLimit < 1 || confirmation.confirmationCallLimit > 1000) {
      throw invalidSummaryIpc()
    }
    return {
      action: 'confirm',
      reportId: validateSummaryId(confirmation.reportId),
      confirmationCallLimit: confirmation.confirmationCallLimit
    }
  }
  const result = { ...summaryObject(value, SUMMARY_GENERATE_FIELDS) }
  if (!SUMMARY_PERIODS.has(result.periodType) || !Number.isInteger(result.start) ||
    !Number.isInteger(result.endExclusive) || result.start >= result.endExclusive ||
    typeof result.partial !== 'boolean' || !SUMMARY_EXECUTORS.has(result.executorId)) {
    throw invalidSummaryIpc()
  }
  result.timezone = validateSummaryTimezone(result.timezone)
  for (const field of ['profileId', 'model']) {
    if (result[field] !== null && result[field] !== undefined &&
      (typeof result[field] !== 'string' || !result[field] || result[field].length > 200 || result[field].includes('\0'))) {
      throw invalidSummaryIpc()
    }
    result[field] = result[field] || null
  }
  return { action: 'generate', ...result }
}

function validateInteractiveSummaryRequest(value) {
  const result = { ...summaryObject(value, SUMMARY_INTERACTIVE_FIELDS) }
  if (!SUMMARY_PERIODS.has(result.periodType) || !Number.isSafeInteger(result.start) ||
    !Number.isSafeInteger(result.endExclusive) || result.start < SUMMARY_MIN_EPOCH_MS ||
    result.endExclusive > Date.now() + SUMMARY_MAX_FUTURE_MS ||
    result.endExclusive - result.start > SUMMARY_MAX_SPAN_MS ||
    result.start >= result.endExclusive ||
    typeof result.partial !== 'boolean' || !SUMMARY_EXECUTORS.has(result.executorId)) {
    throw invalidSummaryIpc()
  }
  result.timezone = validateSummaryTimezone(result.timezone)
  for (const field of ['profileId', 'model']) {
    if (result[field] !== null && result[field] !== undefined &&
      (typeof result[field] !== 'string' || !result[field] ||
        result[field].length > 200 || result[field].includes('\0'))) {
      throw invalidSummaryIpc()
    }
    result[field] = result[field] || null
  }
  return result
}

function validateSummaryExport(value, { html = false } = {}) {
  const fields = html ? SUMMARY_EXPORT_FIELDS : new Set(['reportId'])
  const result = { ...summaryObject(value, fields), reportId: validateSummaryId(value.reportId) }
  if (html) {
    const style = { ...summaryObject(result.style, SUMMARY_STYLE_FIELDS) }
    const styleKeys = Object.keys(style)
    if (style.mode === 'theme') {
      if (styleKeys.length !== 2 || !styleKeys.includes('themeId') || !SUMMARY_HTML_THEME_IDS.has(style.themeId)) {
        throw invalidSummaryIpc()
      }
    } else if (style.mode === 'custom' || style.mode === 'ai-custom') {
      if (styleKeys.length !== 2 || !styleKeys.includes('requirement')) throw invalidSummaryIpc()
      if (typeof style.requirement !== 'string' || !style.requirement.trim() ||
        style.requirement.length > 1000 || style.requirement.includes('\0')) throw invalidSummaryIpc()
    } else if (style.mode === 'light' || style.mode === 'dark') {
      if (styleKeys.length !== 1) throw invalidSummaryIpc()
    } else {
      throw invalidSummaryIpc()
    }
    result.style = style
  }
  return result
}

function validateManualSummaryRequest(input, {
  now = Date.now(),
  availableExecutors = [],
  availableProfiles = []
} = {}) {
  const expected = input.partial
    ? manualPeriod(input.periodType, now, { now, timeZone: input.timezone })
    : completedPeriod(input.periodType, now, { timeZone: input.timezone })
  if (input.start !== expected.start ||
    (!input.partial && input.endExclusive !== expected.endExclusive) ||
    (input.partial && (input.endExclusive > now || input.endExclusive < now - 5 * 60 * 1000))) {
    throw invalidSummaryIpc()
  }

  const executor = availableExecutors.find(tool =>
    tool?.id === input.executorId && tool?.installed === true)
  if (!executor) {
    throw Object.assign(new Error(), { code: 'SUMMARY_EXECUTOR_UNAVAILABLE' })
  }
  if (executor.safeForSummary === false) {
    throw Object.assign(new Error(), { code: 'SUMMARY_EXECUTOR_UNSAFE' })
  }
  const profile = input.profileId
    ? availableProfiles.find(item => item?.id === input.profileId)
    : null
  if (input.profileId) {
    if (!profileAvailableForSummary(
      profile,
      input.executorId,
      executor.summaryExecutorAvailable === true
    )) {
      throw Object.assign(new Error(), { code: 'SUMMARY_PROFILE_UNAVAILABLE' })
    }
  }
  if (executor.summaryExecutorAvailable !== true &&
    !profileProvidesSummaryAuthentication(profile, input.executorId)) {
    throw Object.assign(new Error(), { code: 'SUMMARY_EXECUTOR_AUTH_UNAVAILABLE' })
  }
  return {
    ...input,
    start: expected.start,
    endExclusive: input.partial ? now : expected.endExclusive
  }
}

function safeSummaryError(error) {
  const sourceCode = typeof error?.code === 'string' ? error.code : ''
  const code = SUMMARY_ERROR_MESSAGES[sourceCode]
    ? sourceCode
    : 'SUMMARY_SERVICE_UNAVAILABLE'
  const safe = { code, message: SUMMARY_ERROR_MESSAGES[code] }
  if (code === 'SUMMARY_HTML_INVALID' && Array.isArray(error?.validationErrors)) {
    safe.validationErrors = error.validationErrors
      .filter(item => item && typeof item.code === 'string' && /^[A-Z][A-Z0-9_]{2,80}$/.test(item.code))
      .slice(0, 50)
      .map(item => ({ code: item.code }))
  }
  return safe
}

function safeSummaryEnvelope(operation) {
  return async (...args) => {
    try { return { ok: true, value: await operation(...args) } }
    catch (error) { return { ok: false, error: safeSummaryError(error) } }
  }
}

function storageCounter(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

export function normalizeSummaryStorageStats(value = {}) {
  const cacheBytes = storageCounter(value.cacheBytes)
  const workspaceBytes = storageCounter(value.workspaceBytes)
  return {
    totalBytes: Math.min(Number.MAX_SAFE_INTEGER, cacheBytes + workspaceBytes),
    quotaBytes: storageCounter(value.quotaBytes),
    cacheBytes,
    workspaceBytes,
    entries: storageCounter(value.entries),
    failedWorkspaces: storageCounter(value.failedWorkspaces),
    lastPrunedAt: storageCounter(value.lastPrunedAt) || null
  }
}

export function summaryProgressPayload(report, confirmationCallLimit = null, pipelineProgress = null) {
  const phaseByStatus = {
    queued: 'queued', running: 'collecting', awaiting_confirmation: 'awaiting_confirmation',
    completed: 'completed', failed: 'failed', cancelled: 'cancelled',
    interrupted: 'interrupted', skipped_empty: 'skipped_empty'
  }
  const textByStatus = {
    queued: '等待生成', running: '正在生成总结',
    awaiting_confirmation: Number.isInteger(confirmationCallLimit)
      ? `预计调用 ${confirmationCallLimit} 次，等待确认`
      : '等待确认',
    completed: '总结已生成', failed: '生成失败', cancelled: '已取消',
    interrupted: '生成已中断', skipped_empty: '周期内没有可总结内容'
  }
  const interactiveText = {
    preparing: '正在准备工作总结', starting: '正在启动 AI CLI',
    'awaiting-delivery': '正在投递生成指令', running: '正在生成总结',
    validating: '正在验证 Markdown 报告', completed: '总结已生成',
    failed: '生成失败', cancelled: '已取消', interrupted: '生成已中断'
  }
  const status = [
    'queued', 'running', 'awaiting_confirmation', 'completed', 'failed',
    'cancelled', 'interrupted', 'skipped_empty'
  ].includes(report?.status) ? report.status : 'running'
  const terminal = ['completed', 'failed', 'cancelled', 'interrupted', 'skipped_empty'].includes(report?.status)
  if (pipelineProgress) {
    const progressText = {
      'cache-check': '正在检查缓存', collecting: '正在收集材料', mapping: '正在分析材料',
      reducing: '正在汇总项目', rendering: '正在生成报告'
    }
    const phase = Object.hasOwn(progressText, pipelineProgress.phase)
      ? pipelineProgress.phase
      : 'running'
    return {
      reportId: validateSummaryId(report?.id),
      status,
      phase,
      completed: storageCounter(pipelineProgress.completed),
      total: storageCounter(pipelineProgress.total),
      text: progressText[phase] || '正在处理'
    }
  }
  const interactivePhase = Object.hasOwn(interactiveText, report?.runPhase)
    ? report.runPhase
    : null
  return {
    reportId: validateSummaryId(report?.id),
    status,
    phase: interactivePhase || phaseByStatus[report?.status] || 'running',
    completed: terminal ? 1 : 0,
    total: report?.status === 'awaiting_confirmation' && Number.isInteger(confirmationCallLimit)
      ? confirmationCallLimit
      : 1,
    text: interactiveText[interactivePhase] || textByStatus[report?.status] || '正在处理'
  }
}

export async function cancelActiveSummary(reportId, {
  interactiveJobService,
  headlessJobService,
  requireDrained = false
} = {}) {
  if (interactiveJobService?.isActive(reportId)) {
    const cancel = requireDrained && typeof interactiveJobService.cancelForDeletion === 'function'
      ? interactiveJobService.cancelForDeletion.bind(interactiveJobService)
      : interactiveJobService.cancel.bind(interactiveJobService)
    if (await cancel(reportId) === true) return true
  }
  if (await headlessJobService?.cancel(reportId) === true) return true
  throw Object.assign(new Error('Summary job is not active'), {
    code: 'SUMMARY_JOB_NOT_ACTIVE'
  })
}

export function registerSummaryIpc({ ipcMain, service }) {
  ipcMain.handle('summary:get-settings', safeSummaryEnvelope(() => service.getSettings()))
  ipcMain.handle('summary:set-settings', safeSummaryEnvelope((_event, value) => service.setSettings(validateSummarySettings(value))))
  ipcMain.handle('summary:list-reports', safeSummaryEnvelope((_event, value = {}) => service.listReports(validateSummaryFilters(value))))
  ipcMain.handle('summary:get-report', safeSummaryEnvelope((_event, value) => service.getReport(validateSummaryId(value))))
  ipcMain.handle('summary:update-task', safeSummaryEnvelope((_event, value) => {
    const keys = Object.keys(value || {})
    if (keys.length !== 3 || !keys.every(key => ['reportId', 'title', 'taskNote'].includes(key))) {
      throw invalidSummaryIpc()
    }
    const reportId = validateSummaryId(value.reportId)
    let metadata
    try { metadata = normalizeSummaryTaskMetadata(value) } catch { throw invalidSummaryIpc() }
    return service.updateTask({ reportId, ...metadata })
  }))
  ipcMain.handle('summary:generate', safeSummaryEnvelope((_event, value) => service.generate(validateSummaryGenerate(value))))
  ipcMain.handle('summary:start-interactive', safeSummaryEnvelope(async (_event, value) => {
    const run = await service.startInteractive(validateInteractiveSummaryRequest(value))
    return { report: run.report, sessionId: run.sessionId }
  }))
  ipcMain.handle('summary:cancel', safeSummaryEnvelope((_event, value) => service.cancel(validateSummaryId(value))))
  ipcMain.handle('summary:set-current', safeSummaryEnvelope((_event, value) => service.setCurrent(validateSummaryId(value))))
  ipcMain.handle('summary:delete', safeSummaryEnvelope((_event, value) => service.deleteReport(validateSummaryId(value))))
  ipcMain.handle('summary:export-markdown', safeSummaryEnvelope((_event, value) => service.exportMarkdown(validateSummaryExport(value))))
  ipcMain.handle('summary:export-html', safeSummaryEnvelope((_event, value) => service.exportHtml(validateSummaryExport(value, { html: true }))))
  ipcMain.handle('summary:cache-stats', safeSummaryEnvelope((_event, ...args) => {
    if (args.length > 0) throw invalidSummaryIpc()
    return service.getCacheStats()
  }))
  ipcMain.handle('summary:cache-clear', safeSummaryEnvelope((_event, value) =>
    service.clearCache(validateSummaryCacheClear(value))))
}

export async function deleteSummaryReportAndWorkspace(reportId, deps = {}) {
  deps.repository.get(reportId)
  const onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : () => {}
  const active = deps.interactiveJobService?.isActive(reportId) ||
    deps.headlessJobService?.isActive?.(reportId)
  if (active) {
    await cancelActiveSummary(reportId, {
      interactiveJobService: deps.interactiveJobService,
      headlessJobService: deps.headlessJobService,
      requireDrained: true
    })
    if (deps.interactiveJobService?.isActive(reportId) ||
      deps.headlessJobService?.isActive?.(reportId)) {
      throw Object.assign(new Error('Summary task did not drain'), {
        code: 'SUMMARY_DELETE_DRAIN_FAILED'
      })
    }
  }
  const result = await deps.repository.delete(reportId)
  if (result.removedSessionId) {
    try {
      await deps.removeSessionProjection?.(result.removedSessionId)
    } catch {
      try { onEvent({ phase: 'session-delete', code: 'SUMMARY_SESSION_DELETE_FAILED' }) } catch { /* logging isolation */ }
    }
  }
  try {
    await deps.workspaceService?.remove(reportId)
  } catch {
    try { onEvent({ phase: 'workspace-delete', code: 'SUMMARY_WORKSPACE_DELETE_FAILED' }) } catch { /* logging isolation */ }
  }
  return result
}

function summaryUsageGranularity(periodType) {
  if (periodType === 'day') return 'hour'
  if (periodType === 'week' || periodType === 'month') return 'day'
  return 'month'
}

const USAGE_QUERY_FIELDS = new Set([
  'granularity',
  'start',
  'endExclusive',
  'timeZone',
  'projectPaths',
  'adapterIds',
  'models'
])

function invalidUsageQuery() {
  return Object.assign(new Error('Invalid usage query'), { code: 'INVALID_USAGE_QUERY' })
}

export function validateUsageQueryInput(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidUsageQuery()
    if (Object.keys(value).some(field => !USAGE_QUERY_FIELDS.has(field))) throw invalidUsageQuery()

    const hasStart = Object.prototype.hasOwnProperty.call(value, 'start')
    const hasEnd = Object.prototype.hasOwnProperty.call(value, 'endExclusive')
    if (hasStart !== hasEnd) throw invalidUsageQuery()

    const normalized = assertUsageQuery({
      ...value,
      start: hasStart ? value.start : 0,
      endExclusive: hasEnd ? value.endExclusive : 1
    })
    if (!hasStart) {
      delete normalized.start
      delete normalized.endExclusive
    }
    return normalized
  } catch {
    throw invalidUsageQuery()
  }
}

function serializeUsageQueryError(error) {
  if (error?.code === 'INVALID_USAGE_QUERY') {
    return { code: 'INVALID_USAGE_QUERY', message: 'Invalid usage query' }
  }
  if (error?.code === 'USAGE_QUERY_UNAVAILABLE') {
    return { code: 'USAGE_QUERY_UNAVAILABLE', message: 'Usage statistics are unavailable' }
  }
  if (error?.code !== 'TOO_MANY_BUCKETS') {
    return { code: 'USAGE_QUERY_FAILED', message: 'Unable to query usage' }
  }
  const result = {
    code: 'TOO_MANY_BUCKETS',
    message: typeof error.message === 'string' && error.message
      ? error.message
      : 'Unable to query usage'
  }
  if (['day', 'week', 'month'].includes(error.suggestedGranularity)) {
    result.suggestedGranularity = error.suggestedGranularity
  }
  return result
}

export function createStatsQueryHandler(getUsageQueryService) {
  if (typeof getUsageQueryService !== 'function') {
    throw new TypeError('getUsageQueryService is required')
  }
  return async (_event, input) => {
    try {
      const service = getUsageQueryService()
      if (!service) {
        throw Object.assign(new Error('Usage statistics are unavailable'), {
          code: 'USAGE_QUERY_UNAVAILABLE'
        })
      }
      const query = validateUsageQueryInput(input)
      return { ok: true, value: await service.queryUsage(query) }
    } catch (error) {
      return { ok: false, error: serializeUsageQueryError(error) }
    }
  }
}

function assertDshSessionStartable(session) {
  if (
    session?.adapterId === 'deepseek-harness' &&
    session.adapterConfig?.surfacePreference !== 'web'
  ) {
    throw Object.assign(new Error('DSH_TUI_UNAVAILABLE'), {
      code: 'DSH_TUI_UNAVAILABLE'
    })
  }
}

export async function assertDshQuiescent(entries) {
  const ownedWebEntries = [...entries.values()].filter(entry => (
    entry?.adapter &&
    entry.session?.adapterId === 'deepseek-harness' &&
    (
      entry.session?.capabilities?.surface === 'web' ||
      entry.session?.adapterConfig?.surfacePreference === 'web'
    )
  ))
  for (const entry of ownedWebEntries) entry.adapter._accepting = false
  for (const entry of ownedWebEntries) {
    const adapter = entry.adapter
    try {
      await adapter.dispose()
    } catch {
      throw Object.assign(new Error('DSH_RUNTIME_BUSY'), { code: 'DSH_RUNTIME_BUSY' })
    }
    if (entry.adapter === adapter) entry.adapter = null
    entry.status = 'offline'
    entry.surfaceState = normalizeDshWebSurfaceState({
      status: 'stopped', url: null, errorCode: null
    })
  }
  return true
}

export function createOrchestrator({ summaryStartup = {}, hookReady: hookReadyOverride = null } = {}) {
  initLogger()
  log('createOrchestrator() — starting')
  const adapters = createAdapterMap()
  const sessions = new Map() // sessionId -> { adapter?, session, status, stats, lastActivity, createdAt, _dirtyStats, _lastCumTokens }
  let mainWindow = null
  let rulesets = { default: structuredClone(DEFAULT_RULESET) }
  let settings = { ...DEFAULT_SETTINGS }
  let codexConfigWatcher = null
  let profileService = null
  let skillsService = null
  let usageRecorder = null
  let usageQueryService = null
  let summarySettings = normalizeSummarySettings(DEFAULT_SUMMARY_SETTINGS)
  let summaryRepository = null
  let summaryJobService = null
  let interactiveSummaryJobService = null
  let summaryScheduler = null
  let summaryStorageMaintenance = null
  let summaryExportService = null
  let summaryWorkspaceService = null
  let summaryCacheService = null
  let storageService = null
  let dshProfileManager = null
  let dshRuntimeManager = null
  let dshWebClient = null
  let summaryCacheLastPrunedAt = null
  let summaryAutomationReady = false
  let persistenceRecovery = null
  const storageRoots = resolveUcliStorageRoots({
    platform: process.platform,
    env: process.env,
    homeDirectory: app.getPath('home'),
    userDataPath: app.getPath('userData'),
    sessionDataPath: app.getPath('sessionData')
  })
  if (storageRoots) {
    storageService = createStorageManagementService({
      scanner: scanStorageCategories,
      roots: storageRoots,
      summaryCache: {
        clear: (...args) => summaryCacheService?.clear(...args) || Promise.reject(
          Object.assign(new Error(), { code: 'STORAGE_SERVICE_UNAVAILABLE' })
        )
      },
      summaryWorkspaces: {
        clearDerived: (...args) => summaryWorkspaceService?.clearDerived(...args) || Promise.reject(
          Object.assign(new Error(), { code: 'STORAGE_SERVICE_UNAVAILABLE' })
        )
      },
      isWorkspaceProtected: reportId => summaryJobService?.isActive(reportId) === true,
      logger: { truncate: () => truncateLog() }
    })
  }
  const gatewaySignals = new SessionSignalBus()
  let gatewayManager = null
  let serverConnectionManager = null
  const approvalNotifications = new Map()
  const completionNotifications = new Set()
  const diagnostics = createDiagnosticsService({
    getRuntime: () => ({
      generatedAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node
    }),
    inspectCliTools,
    getPersistence: () => ({ available: Boolean(getDb()), recoveryInfo: persistenceRecovery }),
    getGateway: () => gatewayManager?.getDiagnostics() || null,
    getAiCliProfiles: () => {
      const summary = profileService?.getDiagnosticSummary() || {
        total: 0, ready: 0, drifted: 0, missing: 0,
        codexHomeWritable: false, lastReconcileAt: null,
        claude: {
          total: 0,
          connectionModes: { subscription: 0, apiKey: 0, bearer: 0 },
          missingSecret: 0,
          modelSubstitutions: 0
        }
      }
      return {
        ...summary,
        claude: {
          ...summary.claude,
          modelSubstitutions: Array.from(sessions.values()).filter((entry) =>
            entry.session?.adapterId === 'claude' && entry.session?.profileWarning === 'model_substituted'
          ).length
        }
      }
    },
    showSaveDialog: (options) => dialog.showSaveDialog(mainWindow, options),
    writeFile: writeFileSync
  })
  const sessionDiagnostics = createSessionDiagnosticsService({
    resolveSession: (sessionId) => sessions.get(sessionId) || null,
    getCodexHome,
    persistBinding: async (sessionId, nativeSessionId) => {
      const db = getDb()
      if (!db) throw new Error('本地数据当前不可用，无法保存会话绑定')
      db.updateSession(sessionId, { native_session_id: nativeSessionId })
      db.flush()
    },
    publishBinding: (sessionId, nativeSessionId) => {
      send('session:event', {
        sessionId,
        type: 'init',
        cliSessionId: nativeSessionId
      })
    }
  })
  // DSH 历史导出：优先复用运行中的 web surface；否则临时拉起再导出后关闭。
  // session.list 读 DSH_HOME 全局持久化，临时拉起无需注册 workspace 即可导出历史会话。
  const exportDshHistory = createDshHistoryExporter({
    getSessionUrl: (id) => sessions.get(id)?.surfaceState?.url ?? null,
    dshClient: {
      listSessions: (u) => getDshWebClient().listSessions(u),
      exportSession: (u, id) => getDshWebClient().exportSession(u, id)
    },
    selectLaunch: () => getDshRuntimeManager().selectLaunch(),
    launchWeb: (runtime, cwd) => launchDshWebSurface({ runtime, cwd, env: process.env, platform: process.platform }),
    parseHistory: (text) => parseDshHistory(text)
  })
  const historyService = createSessionHistoryService({
    resolveSession: (sessionId) => {
      const entry = sessions.get(sessionId)
      return entry
        ? {
            ...entry.session,
            historyRevision: entry._lastCompletedTurns
          }
        : null
    },
    exportOpenCode: (nativeSessionId, adapterId = 'opencode') => {
      const resolveLaunch = adapters.get(adapterId)?.resolveLaunch
      if (!resolveLaunch) throw new Error('history provider unsupported')
      const launch = resolveLaunch()
      return exportOpenCodeSession(nativeSessionId, {
        executable: launch.file,
        prefixArgs: launch.prefixArgs,
        sanitize: false
      })
    },
    exportDshHistory
  })
  const artifactsService = createSessionArtifactsService({
    resolveSession: (sessionId) => {
      const entry = sessions.get(sessionId)
      return entry ? entry.session : null
    },
    exportOpenCode: (nativeSessionId, adapterId = 'opencode') => {
      const resolveLaunch = adapters.get(adapterId)?.resolveLaunch
      if (!resolveLaunch) throw new Error('history provider unsupported')
      const launch = resolveLaunch()
      return exportOpenCodeSession(nativeSessionId, {
        executable: launch.file,
        prefixArgs: launch.prefixArgs,
        sanitize: false
      })
    }
  })

  // ---- DB init (async — callers must await) ----
  const dbPath = join(app.getPath('userData'), 'ucli.db')
  let flushTimer = null

  function scheduleFlush() {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(() => getDb()?.flush(), 5000)
  }

  function getCodexHome() {
    return resolveCodexHome({ configuredDir: settings.codexConfigDir })
  }

  async function initSummaryAutomation(db) {
    summarySettings = db.getSummarySettings()
    summaryRepository = createReportRepository({ db })
    const summaryRoot = resolveSummaryStorageRoot({
      platform: process.platform,
      env: process.env,
      homeDirectory: homedir()
    })
    const normalizedWorkspace = candidate => process.platform === 'win32'
      ? candidate.toLowerCase()
      : candidate
    const validateWorkspaceDirectory = candidate => {
      const parent = join(candidate, '..')
      const reportId = parent.split(/[\\/]/).at(-1)
      try {
        return normalizedWorkspace(candidate) === normalizedWorkspace(
          join(resolveSummaryChild(summaryRoot, 'workspaces', reportId), 'work')
        )
      } catch {
        return false
      }
    }
    const workspaceForSettings = () => createSummaryWorkspaceService({
      root: summaryRoot,
      failedRetentionMs: summarySettings.failedWorkspaceRetentionDays * 24 * 60 * 60 * 1000
    })
    summaryWorkspaceService = Object.fromEntries(
      ['create', 'writeArtifact', 'markStage', 'complete', 'fail', 'recover', 'remove', 'usage', 'clearFailed', 'clearDerived', 'pruneExpired', 'pruneOrphans', 'pruneCompleted']
        .map(method => [method, (...args) => workspaceForSettings()[method](...args)])
    )
    const cacheForSettings = () => createSummaryCacheService({
      root: summaryRoot,
      repository: db,
      quotaBytes: summarySettings.cacheMaxBytes
    })
    const cache = Object.fromEntries(
      ['get', 'put', 'evict', 'prune', 'stats', 'clear', 'verify']
        .map(method => [method, (...args) => cacheForSettings()[method](...args)])
    )
    summaryCacheService = cache
    const runner = createSummaryRunner({ profileService, validateWorkspaceDirectory })
    summaryExportService = createReportExportService({
      repository: summaryRepository,
      runner,
      showSaveDialog: options => mainWindow && !mainWindow.isDestroyed?.()
        ? dialog.showSaveDialog(mainWindow, options)
        : dialog.showSaveDialog(options)
    })
    const pipeline = {
      run(options) {
        const profile = options.profileId
          ? profileService?.listProfiles({ adapterId: options.executorId })
            .find(candidate => candidate.id === options.profileId)
          : null
        const profileFingerprint = `sha256:${createHash('sha256').update(JSON.stringify({
          executorId: options.executorId || null,
          profileId: options.profileId || null,
          runtimeRevision: profile?.updatedAt || profile?.runtimeRevision || null
        })).digest('hex')}`
        return createSummaryPipeline({
          runner,
          automaticCallLimit: summarySettings.automaticCallLimit,
          cache: summarySettings.cacheEnabled ? cache : null,
          promptVersion: options.promptVersion || 'summary-v1',
          profileFingerprint,
          mapConcurrency: summarySettings.mapConcurrency
        }).run(options)
      }
    }
    const snapshotSummaryUsage = ({ periodType, start, endExclusive, timezone }) =>
      usageQueryService.queryUsage({
        granularity: summaryUsageGranularity(periodType),
        start,
        endExclusive,
        timeZone: timezone
      })
    summaryJobService = createSummaryJobService({
      repository: summaryRepository,
      evidenceCollector: createEvidenceCollector({ historyService }),
      snapshotUsage: snapshotSummaryUsage,
      pipeline,
      workspaceService: summaryWorkspaceService,
      listSessions,
      defaultTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    })
    const summaryPreparationService = createSummaryPreparationService({
      historyService,
      listSessions,
      snapshotUsage: snapshotSummaryUsage,
      workspaceService: summaryWorkspaceService
    })
    const interactiveSessionRuntime = createInteractiveSummarySessionRuntime({
      createSession: createInteractiveSummarySession,
      startAdapter: startAdapterSession,
      stopSession,
      removeSession: sessionId => removeSessionProjection(sessionId),
      getEntry: interactiveSummarySessionEntry
    })
    interactiveSummaryJobService = createInteractiveSummaryJobService({
      repository: summaryRepository,
      workspaceService: summaryWorkspaceService,
      preparationService: summaryPreparationService,
      sessionRuntime: interactiveSessionRuntime,
      onOperationalEvent: event => log('summary-operation', event)
    })
    const workLogsRoot = resolveSummaryWorkLogsRoot({
      platform: process.platform,
      env: process.env,
      homeDirectory: homedir()
    })
    const legacyWorkLogsImporter = createLegacyWorkLogsImporter({
      workLogsRoot,
      repository: summaryRepository,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      onEvent: event => log('summary-startup', event)
    })
    summaryJobService.subscribe((report, pipelineProgress) => {
      log('summary-operation', createSummaryOperationalLogEntry(report, pipelineProgress))
      if (!pipelineProgress) scheduleFlush()
      if (mainWindow && !mainWindow.isDestroyed?.()) {
        mainWindow.webContents.send(
          'summary:progress',
          summaryProgressPayload(
            report,
            summaryJobService.getConfirmationCallLimit(report.id),
            pipelineProgress
          )
        )
      }
    })
    interactiveSummaryJobService.subscribe(progress => {
      if (!progress?.phase || !progress?.status) return
      scheduleFlush()
      if (mainWindow && !mainWindow.isDestroyed?.()) {
        mainWindow.webContents.send('summary:progress', summaryProgressPayload({
          id: progress.reportId,
          status: progress.status,
          runPhase: progress.phase
        }))
      }
    })
    scheduleFlush()
    summaryStorageMaintenance = async () => {
      const result = await runSummaryMaintenance({
        quotaBytes: summarySettings.cacheMaxBytes,
        pruneExpiredWorkspaces: () => summaryWorkspaceService.pruneExpired(),
        pruneOrphanWorkspaces: () => summaryWorkspaceService.pruneOrphans({
          isProtected: reportId => summaryJobService.isActive(reportId) ||
            interactiveSummaryJobService.isActive(reportId),
          isRetained: reportId => Boolean(summaryRepository.get(reportId))
        }),
        getWorkspaceUsage: () => summaryWorkspaceService.usage(),
        pruneCache: maxBytes => summaryCacheService.prune(maxBytes),
        getCacheUsage: () => summaryCacheService.stats(),
        pruneCompletedWorkspaces: maxBytes => summaryWorkspaceService.pruneCompleted({
          maxBytes,
          isProtected: reportId => summaryJobService.isActive(reportId) ||
            interactiveSummaryJobService.isActive(reportId)
        }),
        onEvent: event => log('summary-maintenance', event)
      })
      summaryCacheLastPrunedAt = Date.now()
      log('summary-maintenance', {
        phase: 'daily-maintenance',
        failedWorkspacesRemoved: result.workspaces?.removed || 0,
        workspaceBytesRemoved: result.workspaces?.bytes || 0,
        orphanWorkspacesChecked: result.orphans?.checked || 0,
        orphanWorkspacesRemoved: result.orphans?.removed || 0,
        orphanBytesRemoved: result.orphans?.bytes || 0,
        cacheEntriesRemoved: result.cache?.removed || 0,
        cacheBytes: result.cache?.bytes || 0,
        completedWorkspacesRemoved: result.completed?.removed || 0,
        totalBytes: result.total?.bytes || 0,
        overQuotaBytes: result.total?.overQuotaBytes || 0
      })
      return result
    }
    summaryScheduler = createSummaryScheduler({
      getSettings: () => summarySettings,
      listReports: filters => summaryRepository.list(filters),
      onReminder: reminder => notifySummaryDue(reminder),
      maintain: () => summaryStorageMaintenance(),
      onMaintenanceError: event => log('summary-maintenance', event)
    })
    const startup = await runSummaryStartupLifecycle({
      interruptStaleJobs: typeof summaryStartup.interruptStaleJobs === 'function'
        ? summaryStartup.interruptStaleJobs
        : () => summaryRepository.interruptStale(),
      recoverWorkspaces: typeof summaryStartup.recoverWorkspaces === 'function'
        ? summaryStartup.recoverWorkspaces
        : () => summaryWorkspaceService.recover(),
      importLegacyWorkLogs: typeof summaryStartup.importLegacyWorkLogs === 'function'
        ? summaryStartup.importLegacyWorkLogs
        : () => legacyWorkLogsImporter.run(),
      maintainCache: async () => {
        const verified = summarySettings.cacheEnabled ? await cache.verify() : null
        const maintained = await summaryStorageMaintenance()
        return { verified, maintained }
      },
      startScheduler: typeof summaryStartup.startScheduler === 'function'
        ? summaryStartup.startScheduler
        : () => summaryScheduler.start(),
      onEvent: event => log('summary-startup', event)
    })
    summaryAutomationReady = startup.ready === true
  }

  function applyCodexProviderPolicy(session, { imported = false } = {}) {
    const providerPolicy = normaliseCodexProviderPolicy(session.providerPolicy, { imported })
    const sourceProvider = session.sourceProvider || (providerPolicy === 'source' ? session.provider : null)
    const explicitProvider = session.explicitProvider || null
    const runtime = readCodexRuntimeSnapshot(getCodexHome())
    const resolved = resolveCodexProviderPolicy({
      policy: providerPolicy,
      sourceProvider,
      explicitProvider,
      runtime
    })
    return {
      ...session,
      providerPolicy,
      sourceProvider,
      explicitProvider,
      provider: resolved.effectiveProvider,
      providerOverride: resolved.providerOverride,
      providerWarning: resolved.warning,
      runtimeRevision: `${runtime.configPath || runtime.codexHome || ''}|${runtime.mtimeMs || 0}`,
      canStart: resolved.canStart !== false
    }
  }

  function prepareCodexSessionRuntime(session, { imported = false, explicitProfileId, forceSystem = false } = {}) {
    const selection = forceSystem
      ? { profileId: null, canStart: true, selectionSource: 'system' }
      : profileService?.resolveSessionProfile({
          adapterId: 'codex',
          cwd: session.cwd,
          imported,
          explicitProfileId: explicitProfileId || session.profileId || null
        })
    if (selection?.canStart === false) {
      throw new Error('The selected Codex profile is no longer available. Choose another profile before starting.')
    }
    if (selection?.profileId) {
      const launch = profileService.resolveCodexLaunchProfile(selection.profileId)
      return {
        session: {
          ...session,
          profileId: selection.profileId,
          nativeProfileName: launch.artifact.nativeProfileName,
          model: launch.artifact.model,
          provider: launch.artifact.providerId,
          sourceProvider: null,
          providerPolicy: null,
          explicitProvider: null,
          providerOverride: null,
          providerWarning: null,
          profileStatus: 'ready',
          profileRuntimeRevision: launch.runtimeRevision || null,
          pendingProfileRuntimeRevision: null,
          pendingProfileId: null,
          restartRequired: false,
          canStart: true
        },
        profileEnvironment: launch.env
      }
    }
    return {
      session: applyCodexProviderPolicy({
        ...session,
        profileId: null,
        nativeProfileName: null,
        profileStatus: null,
        pendingProfileId: null
      }, { imported: forceSystem ? false : imported }),
      profileEnvironment: {}
    }
  }

  function prepareClaudeSessionRuntime(session, { imported = false, explicitProfileId, forceSystem = false } = {}) {
    const selection = forceSystem
      ? { profileId: null, canStart: true, selectionSource: 'system' }
      : profileService?.resolveSessionProfile({
          adapterId: 'claude',
          cwd: session.cwd,
          imported,
          explicitProfileId: explicitProfileId || session.profileId || null
        })
    const launch = selection?.profileId
      ? profileService.resolveLaunchProfile({
          profileId: selection.profileId,
          session,
          baseEnv: process.env
        })
      : null
    return prepareClaudeProfileSession({ session, selection, launch })
  }

  function interactiveProfileSnapshot(adapterId, prepared) {
    const session = prepared.session
    if (!session.profileId) return null
    return Object.freeze({
      adapterId,
      profileId: session.profileId,
      runtimeRevision: session.profileRuntimeRevision || null,
      session: Object.freeze({
        profileId: session.profileId,
        nativeProfileName: session.nativeProfileName || null,
        model: session.model || null,
        provider: session.provider || null,
        sourceProvider: session.sourceProvider || null,
        providerPolicy: session.providerPolicy || null,
        explicitProvider: session.explicitProvider || null,
        providerOverride: session.providerOverride || null,
        providerWarning: session.providerWarning || null,
        profileStatus: session.profileStatus || null,
        profileRuntimeRevision: session.profileRuntimeRevision || null,
        pendingProfileRuntimeRevision: session.pendingProfileRuntimeRevision || null,
        pendingProfileId: session.pendingProfileId || null,
        restartRequired: Boolean(session.restartRequired),
        canStart: session.canStart !== false,
        actualModel: session.actualModel || null,
        profileWarning: session.profileWarning || null
      }),
      profileEnvironment: Object.freeze({ ...(prepared.profileEnvironment || {}) }),
      profileLaunch: prepared.profileLaunch
        ? Object.freeze({
            args: Object.freeze([...(prepared.profileLaunch.args || [])]),
            env: Object.freeze({ ...(prepared.profileLaunch.env || {}) }),
            ...(Array.isArray(prepared.profileLaunch.settingSources)
              ? { settingSources: Object.freeze([...prepared.profileLaunch.settingSources]) }
              : {})
          })
        : null
    })
  }

  function isInteractiveProfileSnapshotCurrent(snapshot) {
    if (!snapshot?.profileId) return true
    const current = profileService.resolveProfileRuntime(snapshot.profileId)
    return current?.canStart !== false &&
      current?.profileId === snapshot.profileId &&
      (current?.runtimeRevision || null) === snapshot.runtimeRevision
  }

  function assertInteractiveProfileSnapshotCurrent(snapshot) {
    if (isInteractiveProfileSnapshotCurrent(snapshot)) return
    throw Object.assign(new Error(), { code: 'SUMMARY_PROFILE_UNAVAILABLE' })
  }

  function interactiveProfileReadiness(snapshot) {
    if (!snapshot?.profileId) return null
    return Object.freeze({
      profileId: snapshot.profileId,
      runtimeRevision: snapshot.runtimeRevision || null
    })
  }

  function clearInteractiveProfileCapability(entry) {
    if (!entry) return
    entry._interactiveProfileSnapshot = null
    entry._interactiveProfileReadiness = null
    entry._interactiveProfileToken = null
  }

  function resolveInteractiveSummarySelection(input) {
    if (input.model && !isSafeClaudeModel(input.model)) throw invalidSummaryIpc()
    if (['opencode', 'ucode'].includes(input.executorId)) {
      if (input.profileId) {
        throw Object.assign(new Error(), { code: 'SUMMARY_PROFILE_UNAVAILABLE' })
      }
      return { ...input, profileId: null, model: input.model || null }
    }

    const preview = {
      adapterId: input.executorId,
      cwd: process.cwd(),
      model: input.model || null,
      systemModel: input.model || null
    }
    try {
      const prepared = input.executorId === 'codex'
        ? prepareCodexSessionRuntime(preview, {
            explicitProfileId: input.profileId || null,
            forceSystem: !input.profileId
          })
        : prepareClaudeSessionRuntime(preview, {
            explicitProfileId: input.profileId || null,
            forceSystem: !input.profileId
          })
      if (input.executorId === 'codex') assertCodexSessionCanStart(prepared.session)
      const model = prepared.session.model || null
      if (model && !isSafeClaudeModel(model)) {
        throw Object.assign(new Error(), { code: 'SUMMARY_PROFILE_UNAVAILABLE' })
      }
      return {
        ...input,
        profileId: prepared.session.profileId || null,
        model,
        ...(prepared.session.profileId
          ? { interactiveProfileSnapshot: interactiveProfileSnapshot(input.executorId, prepared) }
          : {})
      }
    } catch {
      throw Object.assign(new Error(), {
        code: input.profileId ? 'SUMMARY_PROFILE_UNAVAILABLE' : 'SUMMARY_EXECUTOR_UNAVAILABLE'
      })
    }
  }

  function armClaudeSessionLaunch(entry) {
    if (entry._interactiveProfileReadiness) {
      assertInteractiveProfileSnapshotCurrent(entry._interactiveProfileReadiness)
      Object.assign(entry.session, {
        activeProfileId: entry.session.profileId || null,
        pendingProfileId: null,
        pendingProfileRuntimeRevision: null,
        restartRequired: false
      })
      entry.status = 'launching'
      return false
    }
    const desiredStamp = profileService.getClaudeProfileLaunchStamp(entry.session.profileId || null)
    return armClaudeProfileLaunch({
      entry,
      desiredStamp,
      prepareRuntime: () => prepareClaudeSessionRuntime(entry.session, {
        imported: Boolean(entry.session.cliSessionId),
        explicitProfileId: entry.session.profileId || null,
        forceSystem: !entry.session.profileId
      })
    })
  }

  function hasActiveCodexProcess(entry) {
    return Boolean(entry.adapter && entry.status !== 'offline' && entry.status !== 'starting')
  }

  function refreshCodexProviderRuntime(entry, { imported = false, isActive = hasActiveCodexProcess(entry) } = {}) {
    const resolved = applyCodexProviderPolicy(entry.session, { imported })
    const runtime = reconcileCodexRuntimeProvider({
      session: entry.session,
      resolved,
      isActive
    })
    Object.assign(entry.session, resolved, runtime)
    return entry.session
  }

  function assertCodexSessionCanStart(session) {
    if (session.canStart === false) {
      throw new Error('The selected Codex provider is no longer available. Choose another provider before starting.')
    }
  }

  function profileRuntimeView(session) {
    return {
      profileId: session.profileId || null,
      activeProfileId: session.activeProfileId || null,
      pendingProfileId: session.pendingProfileId || null,
      profileStatus: session.profileStatus || null,
      actualModel: session.actualModel || null,
      profileWarning: session.profileWarning || null,
      restartRequired: Boolean(session.restartRequired),
      canStart: session.canStart !== false
    }
  }

  function publishProfileRuntime(sessionId, session) {
    const result = profileRuntimeView(session)
    send('session:event', { sessionId, type: 'profile-runtime', ...result })
    return result
  }

  function publishCodexRuntime(snapshot) {
    for (const [sessionId, entry] of sessions) {
      if (entry.session.adapterId !== 'codex') continue
      if (entry.session.profileId) {
        const resolved = profileService?.resolveCodexProfileRuntime(entry.session.profileId) || {
          profileId: entry.session.profileId,
          status: 'missing_profile',
          canStart: false,
          runtimeRevision: null
        }
        Object.assign(entry.session, reconcileActiveProfile({
          session: entry.session,
          resolved,
          isActive: hasActiveCodexProcess(entry)
        }))
        publishProfileRuntime(sessionId, entry.session)
        continue
      }
      const next = refreshCodexProviderRuntime(entry, { imported: Boolean(entry.session.cliSessionId) })
      const db = getDb()
      if (db && !next.restartRequired) {
        db.updateSession(sessionId, {
          provider: next.provider,
          source_provider: next.sourceProvider,
          provider_policy: next.providerPolicy,
          explicit_provider: next.explicitProvider
        })
        scheduleFlush()
      }
      send('session:event', {
        sessionId,
        type: 'codex-runtime',
        provider: next.provider,
        providerPolicy: next.providerPolicy,
        explicitProvider: next.explicitProvider,
        providerWarning: next.providerWarning,
        pendingProvider: next.pendingProvider,
        pendingProviderWarning: next.pendingProviderWarning,
        restartRequired: next.restartRequired,
        canStart: next.canStart
      })
    }
    send('codex:runtime', snapshot)
  }

  function startCodexConfigWatcher() {
    codexConfigWatcher?.stop()
    codexConfigWatcher = createCodexConfigWatcher({
      readSnapshot: () => readCodexRuntimeSnapshot(getCodexHome()),
      onChange: publishCodexRuntime
    })
    const snapshot = codexConfigWatcher.start(getCodexHome())
    send('codex:runtime', snapshot)
    return snapshot
  }

  async function initPersistence() {
    const db = await openDb(dbPath, { deferUsageLedgerInitialization: true })
    log('initPersistence — openDb returned:', !!db, 'path:', dbPath)
    if (!db) {
      console.error('Persistence not available — running without saving data')
      log('initPersistence — DB is null, persistence disabled')
      return // app continues without DB (stats work from in-memory sessions)
    }
    persistenceRecovery = db.recoveryInfo || null
    usageRecorder = createUsageRecorder({ db })
    usageQueryService = createUsageQueryService({ db })

    // Migrate old JSON files if they exist
    const configPath = join(app.getPath('userData'), 'ucli-config.json')
    const sessionsPath = join(app.getPath('userData'), 'ucli-sessions.json')
    let oldCfg = null, oldSessions = null
    try {
      if (existsSync(configPath)) {
        oldCfg = JSON.parse(readFileSync(configPath, 'utf8'))
      }
    } catch { /* ignore */ }
    try {
      if (existsSync(sessionsPath)) {
        oldSessions = JSON.parse(readFileSync(sessionsPath, 'utf8'))
      }
    } catch { /* ignore */ }

    const existingSessionCount = db.countSessions()
    const shouldMigrateLegacyJson = existingSessionCount === 0 && oldCfg
    if (shouldMigrateLegacyJson) {
      db.migrateFromJson(
        oldCfg.rulesets || null,
        oldCfg.settings || null,
        oldSessions || null
      )
    }
    db.initializeUsageLedgerAfterLegacyImport()
    if (shouldMigrateLegacyJson) {
      db.flush()
      // Remove old files after successful migration
      try { if (existsSync(configPath)) unlinkSync(configPath) } catch { /* ok */ }
      try { if (existsSync(sessionsPath)) unlinkSync(sessionsPath) } catch { /* ok */ }
    }

    // Load from DB
    const dbRules = db.getRules()
    if (Object.keys(dbRules).length) {
      rulesets = dbRules
      const upgradedDefault = upgradeDefaultRuleset(rulesets.default)
      if (upgradedDefault !== rulesets.default) {
        rulesets = { ...rulesets, default: upgradedDefault }
        db.saveRules(rulesets)
      }
    } else {
      db.saveRules(rulesets)
    }
    const dbSettings = db.getSettings()
    if (Object.keys(dbSettings).length) {
      settings = { ...DEFAULT_SETTINGS, ...dbSettings }
    } else {
      db.saveSettings(settings)
    }

    profileService = createProfileService({
      db,
      secretStore: new ProfileSecretStore({ db, safeStorage }),
      resolveCodexHome: getCodexHome,
      readCodexRuntime: () => readCodexRuntimeSnapshot(getCodexHome()),
      readClaudeRuntime: () => readClaudeRuntimeSnapshot({ env: process.env }),
      fileOps: codexProfileFiles,
      flush: () => db.flush()
    })
    skillsService = createSkillsService({
      db,
      userDataPath: app.getPath('userData'),
      sourceLoader: createSkillSourceLoader({
        stagingRoot: join(app.getPath('userData'), 'skills', '.source-staging')
      }),
      flush: () => db.flush(),
      listSessions,
      restartSession: restartSessionForSkills,
      discoverUCodeSkills: listUCodeSkills
    })
    serverConnectionManager = new ConnectionManager({
      attempts: new RegistrationAttemptStore(),
      credentials: new ServerCredentialStore({ db, safeStorage }),
      client: createDeviceGrantClient(),
      platform: ({ win32: 'windows', darwin: 'macos', linux: 'linux' })[process.platform],
      deviceName: app.getName()
    })
    try {
      await profileService.reconcileCodexProfiles()
    } catch (error) {
      log('AI CLI profile reconcile deferred:', error?.code || 'PROFILE_RECONCILE_FAILED')
    }

    // Restore session entries (metadata only — no running adapters)
    const dbSessions = db.listSessions()
    for (const s of dbSessions) {
      // Recover/enrich native metadata using the matching adapter only.
      let cliSessionId = s.cliSessionId || s.nativeSessionId || null
      let sessionName = s.name || null
      let provider = s.provider || null
      let sourceProvider = s.sourceProvider || null
      let providerPolicy = s.providerPolicy || null
      let explicitProvider = s.explicitProvider || null
      if (cliSessionId && s.adapterId === 'codex') {
        const latest = resolveCodexTranscriptSessionInHome(getCodexHome(), cliSessionId)
        if (latest?.sessionId && latest.sessionId !== cliSessionId) {
          cliSessionId = latest.sessionId
          db.updateSession(s.id, { native_session_id: cliSessionId })
        }
      }
      if (!cliSessionId && s.cwd && s.adapterId === 'claude') {
        const found = findClaudeSessionIndex(s.cwd, s.createdAt)
        if (found) {
          cliSessionId = found.sessionId
          sessionName = sessionName || found.name
          db.updateSession(s.id, { native_session_id: cliSessionId, name: sessionName })
        }
      }
      if (!cliSessionId && s.cwd && adapters.get(s.adapterId)?.listNativeSessions) {
        const found = await findCompatibleSessionIndex(s.adapterId, s.cwd, s.createdAt)
        if (found) {
          cliSessionId = found.sessionId
          sessionName = sessionName || found.name
          db.updateSession(s.id, { native_session_id: cliSessionId, name: sessionName })
        }
      }
      if (cliSessionId && s.cwd && s.adapterId === 'codex' && !provider) {
        const found = listCodexSessions(s.cwd).find((item) => item.sessionId === cliSessionId)
        if (found) {
          provider = found.resumeProvider || null
          sourceProvider = found.sourceProvider || null
          providerPolicy = 'source'
        }
      }
      const persistedSystemModel = s.adapterId === 'claude' && cliSessionId
        ? normalizeClaudeHistoryModel(s.systemModel ?? s.model)
        : s.systemModel ?? null
      const storedProfile = s.profileId
        ? profileService.listProfiles({ adapterId: s.adapterId }).find((profile) => profile.id === s.profileId) || null
        : null
      const restoredSession = s.adapterId === 'codex' && s.profileId
        ? {
            profileId: s.profileId,
            nativeProfileName: storedProfile?.nativeProfileName || null,
            provider: storedProfile?.providerId || provider,
            sourceProvider: null,
            providerPolicy: null,
            explicitProvider: null,
            providerOverride: null,
            providerWarning: null,
            profileStatus: storedProfile?.status || 'missing_profile',
            canStart: storedProfile?.canStart === true
          }
        : s.adapterId === 'claude' && s.profileId
          ? {
              profileId: s.profileId,
              model: storedProfile?.model ?? persistedSystemModel,
              profileStatus: storedProfile?.status || 'missing_profile',
              canStart: storedProfile?.canStart === true,
              provider,
              sourceProvider,
              providerPolicy: null,
              explicitProvider: null,
              providerOverride: null,
              providerWarning: null
            }
          : s.adapterId === 'codex'
          ? applyCodexProviderPolicy({ provider, sourceProvider, providerPolicy, explicitProvider }, { imported: Boolean(cliSessionId) })
        : { provider, sourceProvider, providerPolicy: null, explicitProvider: null, providerOverride: null, providerWarning: null }
      provider = restoredSession.provider
      sourceProvider = restoredSession.sourceProvider
      providerPolicy = restoredSession.providerPolicy
      explicitProvider = restoredSession.explicitProvider
      if (s.adapterId === 'codex') {
        db.updateSession(s.id, {
          provider,
          source_provider: sourceProvider,
          provider_policy: providerPolicy,
          explicit_provider: explicitProvider
        })
      }
      const descriptor = adapters.get(s.adapterId) || {}
      const adapterConfig = normalizePersistedSessionConfig(descriptor, s.adapterConfig)
      const canStart = s.adapterId === 'deepseek-harness' && adapterConfig.surfacePreference !== 'web'
        ? false
        : restoredSession.canStart
      const entry = {
        adapter: null, // offline — CLI process not running
        session: {
          id: s.id, adapterId: s.adapterId,
          cwd: s.cwd || s.projectPath,
          model: restoredSession.model ?? persistedSystemModel,
          systemModel: persistedSystemModel,
          tier: s.tier, rulesetId: 'default',
          provider,
          sourceProvider,
          providerPolicy,
          explicitProvider,
          providerOverride: restoredSession.providerOverride,
          providerWarning: restoredSession.providerWarning,
          pendingProvider: null,
          pendingProviderOverride: null,
          pendingProviderWarning: null,
          pendingRuntimeRevision: null,
          profileId: restoredSession.profileId || null,
          activeProfileId: null,
          pendingProfileId: null,
          profileStatus: restoredSession.profileStatus || null,
          actualModel: null,
          profileWarning: null,
          nativeProfileName: restoredSession.nativeProfileName || null,
          profileRuntimeRevision: null,
          pendingProfileRuntimeRevision: null,
          restartRequired: false,
          canStart,
          cliSessionId,
          name: sessionName,
          taskNote: s.taskNote || '',
          adapterConfig,
          capabilities: resolveAdapterCapabilities(descriptor, adapterConfig)
        },
        status: 'offline',
        surfaceState: adapterConfig.surfacePreference === 'web'
          ? normalizeDshWebSurfaceState({ status: 'stopped', url: null, errorCode: null })
          : null,
        stats: s.stats,
        lastActivity: '已离线',
        createdAt: s.createdAt || Date.now(),
        updatedAt: s.updatedAt || s.createdAt || Date.now(),
        _dirtyStats: null,
        _lastCumTokens: null,
        _lastCompletedTurns: null,
        _lastNotification: null
      }
      sessions.set(s.id, entry)
      engine.setSession(s.id, { tier: s.tier, rulesetId: 'default', ruleset: rulesets['default'] })
    }
    db.flush()
    startCodexConfigWatcher()
    try {
      await initSummaryAutomation(db)
    } catch (error) {
      await summaryScheduler?.stop()
      summaryScheduler = null
      log(
        'Summary scheduler startup deferred:',
        safeSummaryErrorCode(error?.code, 'SUMMARY_SCHEDULER_START_FAILED')
      )
    }
  }

  // ---- hook runner path (dev vs packaged) ----
  const hookRunnerPath = app.isPackaged
    ? join(process.resourcesPath, 'resources', 'claudeHook.runner.mjs')
    : join(app.getAppPath(), 'resources', 'claudeHook.runner.mjs')

  // ---- permission engine ----
  const engine = new PermissionEngine({
    onApprovalRequest(req) {
      send('session:approval-request', req)
      showApprovalNotification(req)
      gatewaySignals.publish({
        type: 'decision_required',
        sessionId: req.sessionId,
        turnId: `permission:${req.requestId}`,
        occurredAt: Date.now(),
        decision: {
          decisionId: req.requestId,
          kind: 'permission',
          title: '需要确认操作',
          summary: req.summary || req.tool || '',
          options: [
            { id: 'allow_once', label: '允许一次' },
            { id: 'deny', label: '拒绝' }
          ],
          responseMode: 'single'
        }
      })
    },
    onApprovalResolved(req) {
      dismissApprovalNotification(req.requestId)
      send('session:approval-resolved', req)
      const entry = sessions.get(req.sessionId)
      if (entry && usageRecorder) {
        void usageRecorder.recordApproval({
          approvalId: req.requestId,
          sessionId: req.sessionId,
          projectPath: entry.session.cwd,
          adapterId: entry.session.adapterId,
          model: entry.session.actualModel || entry.session.model,
          observedAt: Date.now()
        }).catch((error) => log('Failed to record approval usage:', error))
      }
    },
    onDecision(d) {
      const s = sessions.get(d.sessionId)
      if (!s) return
      const key = d.asked
        ? (d.verdict === 'allow' ? 'confirmed' : 'denied')
        : (d.verdict === 'allow' ? 'autoAllowed' : 'denied')
      s.stats.approvals[key] = (s.stats.approvals[key] || 0) + 1
      scheduleFlush()
    }
  })

  // ---- hook HTTP server ----
  let hookPort = null
  let hookServer = null
  const hookReady = hookReadyOverride || startHookServer().then((srv) => {
    hookServer = srv
    hookPort = srv.port
    srv.setHandler(async (payload) => {
      const result = await engine.decide(payload.sessionId, {
        tool: payload.tool, input: payload.input, cwd: payload.cwd
      })
      if (
        result.verdict === 'allow' &&
        ['AskUserQuestion', 'ExitPlanMode'].includes(payload.tool)
      ) {
        showSessionAttentionNotification(payload.sessionId, {
          kind: 'approval',
          operation: operationTypeForTool(payload.tool)
        })
      }
      return { verdict: result.verdict, reason: result.reason }
    })
    return srv
  })

  function send(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
  }
  function setMainWindow(win) { mainWindow = win }

  function focusMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    mainWindow.flashFrame(false)
  }

  function showApprovalNotification(request) {
    if (!shouldShowApprovalNotification(mainWindow)) return
    mainWindow.flashFrame(true)
    if (!Notification.isSupported()) return

    const entry = sessions.get(request.sessionId)
    const notification = new Notification(
      describeApprovalNotification(request, entry?.session)
    )
    approvalNotifications.set(request.requestId, notification)
    notification.on('click', () => {
      focusMainWindow()
      send('session:focus-session', { sessionId: request.sessionId })
      notification.close()
    })
    notification.on('close', () => {
      approvalNotifications.delete(request.requestId)
    })
    notification.show()
  }

  function dismissApprovalNotification(requestId) {
    const notification = approvalNotifications.get(requestId)
    if (notification) notification.close()
    approvalNotifications.delete(requestId)
    if (!approvalNotifications.size && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.flashFrame(false)
    }
  }

  function showTaskCompletionNotification(sessionId, session) {
    showSessionAttentionNotification(sessionId, {
      kind: 'complete',
      operation: '任务完成'
    }, describeTaskCompletionNotification(session))
  }

  function showSessionAttentionNotification(sessionId, attention, description = null) {
    const entry = sessions.get(sessionId)
    if (!entry) return
    const key = `${attention.kind}:${attention.operation}`
    const next = advanceSessionNotification(entry._lastNotification, key)
    entry._lastNotification = next.state
    if (!next.deliver || !shouldShowApprovalNotification(mainWindow)) return
    mainWindow.flashFrame(true)
    if (!Notification.isSupported()) return

    const notification = new Notification(
      description || describeSessionAttentionNotification(attention, entry.session)
    )
    completionNotifications.add(notification)
    notification.on('click', () => {
      focusMainWindow()
      send('session:focus-session', { sessionId })
      notification.close()
    })
    notification.on('close', () => completionNotifications.delete(notification))
    notification.show()
  }

  function notifySummaryDue(reminder) {
    if (!Notification.isSupported()) return
    const labels = { day: '每日', week: '每周', month: '每月', quarter: '每季度', year: '每年' }
    const label = labels[reminder.periodType] || reminder.periodType
    const notification = new Notification({
      title: '该生成工作总结了',
      body: `${label}总结已到期，点击去生成`
    })
    notification.on('click', () => {
      focusMainWindow()
      send('summary:open', { periodType: reminder.periodType })
      notification.close()
    })
    notification.show()
  }

  // ---- session lifecycle ----
  function wireAdapterGateway(sessionId, adapter) {
    adapter.on('gateway-event', (event) => {
      const entry = sessions.get(sessionId)
      if (entry) {
        if (event.type === 'turn_started') entry._gatewayTurnActive = true
        if (
          event.type === 'turn_completed' ||
          event.type === 'turn_failed' ||
          event.type === 'turn_interrupted' ||
          event.type === 'session_stopped'
        ) {
          entry._gatewayTurnActive = false
        }
      }
      gatewaySignals.publish(event)
    })
  }

  function assertPublicSessionConfig(config) {
    if (config && typeof config === 'object' && (
      Object.hasOwn(config, 'interactiveProfileSnapshot') ||
      Object.hasOwn(config, 'interactiveProfileToken')
    )) {
      throw new Error('interactive profile capability is reserved for main-process session creation')
    }
  }

  async function rejectInteractiveProfileConstruction(adapter, sessionId, error) {
    try {
      await adapter.dispose?.()
    } catch (cleanupError) {
      log('interactive-profile-construction-cleanup-failed',
        safeSummaryErrorCode(cleanupError?.code, 'SUMMARY_PROFILE_CLEANUP_FAILED'))
    }
    engine.removeSession(sessionId)
    throw error
  }

  function createSession(config, { interactiveProfileSnapshot = null } = {}) {
    if (config.cliSessionId && !isSafeNativeSessionId(config.cliSessionId)) {
      throw new Error('invalid native session id')
    }
    const sessionId = randomUUID()
    const tier = config.tier || settings.defaultTier
    const rulesetId = config.rulesetId || 'default'
    const adapterId = config.adapterId || settings.defaultAdapter
    const descriptor = adapters.get(adapterId)
    if (!descriptor) throw new Error('unknown adapter: ' + adapterId)
    const cwd = config.cwd || settings.defaultCwd || process.cwd()
    const adapterConfig = normalizeSessionConfig(descriptor, config.adapterConfig)
    const capabilities = resolveAdapterCapabilities(descriptor, adapterConfig)

    let session = {
      id: sessionId, adapterId, cwd,
      model: config.model || null,
      systemModel: config.model || null,
      tier, rulesetId,
      provider: config.provider || null,
      sourceProvider: config.sourceProvider || null,
      providerPolicy: config.providerPolicy || null,
      explicitProvider: config.explicitProvider || null,
      cliSessionId: config.cliSessionId || null,
      name: config.name || null,
      taskNote: '',
      adapterConfig,
      capabilities
    }
    let profileEnvironment = {}
    let profileLaunch = null
    const pinnedProfile = interactiveProfileSnapshot
    if (pinnedProfile) {
      if (pinnedProfile.adapterId !== adapterId ||
        pinnedProfile.profileId !== config.profileId ||
        !isInteractiveProfileSnapshotCurrent(pinnedProfile)) {
        throw Object.assign(new Error(), { code: 'SUMMARY_PROFILE_UNAVAILABLE' })
      }
      session = { ...session, ...pinnedProfile.session }
      profileEnvironment = { ...pinnedProfile.profileEnvironment }
      profileLaunch = pinnedProfile.profileLaunch && {
        ...pinnedProfile.profileLaunch,
        args: [...pinnedProfile.profileLaunch.args],
        env: { ...pinnedProfile.profileLaunch.env },
        ...(Array.isArray(pinnedProfile.profileLaunch.settingSources)
          ? { settingSources: [...pinnedProfile.profileLaunch.settingSources] }
          : {})
      }
    } else if (adapterId === 'codex') {
      const prepared = prepareCodexSessionRuntime(session, {
        imported: Boolean(session.cliSessionId),
        explicitProfileId: config.profileId || null,
        forceSystem: config.profileSelection === 'system'
      })
      session = prepared.session
      profileEnvironment = prepared.profileEnvironment
      assertCodexSessionCanStart(session)
    } else if (adapterId === 'claude') {
      const prepared = prepareClaudeSessionRuntime(session, {
        imported: Boolean(session.cliSessionId),
        explicitProfileId: config.profileId || null,
        forceSystem: config.profileSelection === 'system'
      })
      session = prepared.session
      profileLaunch = prepared.profileLaunch
    }
    engine.setSession(sessionId, { tier, rulesetId, ruleset: rulesets[rulesetId] })
    const adapter = descriptor.create({
      session,
      engine,
      settings: {
        hookRunnerPath,
        hookPort: null,
        ruleset: rulesets[rulesetId],
        codexHome: adapterId === 'codex' ? getCodexHome() : null,
        profileEnvironment,
        profileLaunch,
        profileManager: adapterId === 'deepseek-harness' ? getDshProfileManager() : null,
        initialStats: {
          tokens: { input: 0, output: 0 },
          turns: 0,
          completedTurns: 0
        }
      }
    })
    try {
      assertInteractiveProfileSnapshotCurrent(pinnedProfile)
    } catch (error) {
      return rejectInteractiveProfileConstruction(adapter, sessionId, error)
    }
    const pinnedProfileReadiness = interactiveProfileReadiness(pinnedProfile)
    const costAvailable = descriptor.costAvailable !== false
    const entry = {
      adapter, session,
      surfaceState: adapterConfig.surfacePreference === 'web'
        ? normalizeDshWebSurfaceState({ status: 'starting', url: null, errorCode: null })
        : null,
      status: 'starting', // not yet started — renderer calls start-adapter when pane is ready
      stats: {
        tokens: { input: 0, output: 0 },
        costUsd: costAvailable ? 0 : null,
        costAvailable,
        turns: 0,
        approvals: { autoAllowed: 0, confirmed: 0, denied: 0 }
      },
      lastActivity: '启动中…',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      _dirtyStats: null,
      _lastCumTokens: null,
      _lastCompletedTurns: session.cliSessionId ? null : 0,
      _lastNotification: null,
      _gatewayTurnActive: false,
      _claudeProfileLaunchStamp: adapterId === 'claude'
        ? claudeProfileLaunchStamp(session)
        : null,
      _interactiveProfileSnapshot: null,
      _interactiveProfileReadiness: pinnedProfileReadiness,
      _interactiveProfileToken: null
    }
    sessions.set(sessionId, entry)
    adapter.on('event', (evt) => handleAdapterEvent(sessionId, evt))
    wireAdapterGateway(sessionId, adapter)

    // Persist to SQLite
    const db = getDb()
    if (db) {
      db.touchProject(cwd, session.name || cwd.split(/[\\/]/).pop() || cwd)
      db.insertSession({
        id: sessionId, project_path: cwd, adapter_id: adapterId,
        native_session_id: session.cliSessionId, name: session.name, task_note: '', tier, model: session.model,
        system_model: session.systemModel,
        provider: session.provider, source_provider: session.sourceProvider,
        provider_policy: session.providerPolicy,
        explicit_provider: session.explicitProvider,
        profile_id: session.profileId || null,
        adapter_config_json: JSON.stringify(session.adapterConfig),
        status: 'starting', created_at: entry.createdAt
      })
      db.flush()
    }
    return {
      sessionId,
      adapterConfig: normalizePersistedSessionConfig(
        adapters.get(entry.session.adapterId) || {},
        entry.session.adapterConfig
      ),
      capabilities: normalizeAdapterCapabilities(entry.session.capabilities),
      surfaceState: entry.surfaceState || null
    }
  }

  function createInteractiveSummarySession(config) {
    const { interactiveProfileSnapshot = null, ...sessionConfig } = config || {}
    return createSession(sessionConfig, { interactiveProfileSnapshot })
  }

  async function handleAdapterEvent(sessionId, evt) {
    const entry = sessions.get(sessionId)
    if (!entry) return
    if (evt?.type === 'stats_update' && !sessionUsesUcliStats(entry.session)) return
    entry.updatedAt = evt.ts || Date.now()
    switch (evt.type) {
      case 'ready':
        entry.status = 'idle'
        entry.lastActivity = '已就绪'
        await gatewayManager?.resyncSession(sessionId)
        break
      case 'init':
        // cliSessionId discovered from PTY output (new session) or from transcript
        if (evt.cliSessionId) {
          entry.session.cliSessionId = evt.cliSessionId
          const db = getDb()
          if (db) { db.updateSession(sessionId, { native_session_id: evt.cliSessionId }); db.flush() }
          await gatewayManager?.resyncSession(sessionId)
        }
        break
      case 'exit':
        entry.status = 'exited'
        entry.lastActivity = `进程退出 (${evt.code})`
        break
      case 'error':
        entry.status = 'error'
        entry.lastActivity = `错误: ${evt.message}`
        break
      case 'status':
        entry.status = evt.status
        entry.lastActivity = evt.status === 'running' ? '运行中' : '已就绪'
        break
      case 'surface_state': {
        const surfaceState = normalizeDshWebSurfaceState(evt)
        if (!surfaceState) return
        entry.surfaceState = surfaceState
        send('session:event', {
          sessionId,
          type: 'surface_state',
          surfaceState,
          status: entry.status,
          ts: evt.ts
        })
        return
      }
      case 'terminal':
        send('session:terminal-output', { sessionId, data: evt.data })
        entry.status = 'running'
        break
      case 'attention':
        showSessionAttentionNotification(sessionId, {
          kind: evt.kind,
          operation: evt.operation
        })
        if (evt.kind === 'approval') {
          entry.status = 'waiting'
          entry.lastActivity = `等待用户操作：${evt.operation}`
        }
        break
      case 'stats_update':
        if (evt.synthetic === true) {
          evt = {
            ...evt,
            usage: {
              ...evt.usage,
              inputTokens: entry.stats.tokens.input,
              outputTokens: entry.stats.tokens.output
            },
            costUsd: entry.stats.costUsd,
            costAvailable: entry.stats.costAvailable,
            turns: entry.stats.turns,
            model: entry.session.model || evt.model || null
          }
          break
        }
        evt = normalizeAdapterStatsEvent(evt, entry.stats)
        entry.stats.tokens = { input: evt.usage.inputTokens, output: evt.usage.outputTokens }
        if (evt.costAvailable === false) {
          entry.stats.costAvailable = false
          entry.stats.costUsd = null
        } else if (evt.costUsd != null) {
          entry.stats.costAvailable = true
          entry.stats.costUsd = evt.costUsd
        }
        if (evt.turns != null) entry.stats.turns = evt.turns
        if (evt.completedTurns != null) {
          const completion = advanceTaskCompletion(entry._lastCompletedTurns, evt.completedTurns)
          entry._lastCompletedTurns = completion.turns
          if (completion.completed) {
            showTaskCompletionNotification(sessionId, entry.session)
          }
        }
        if (evt.contextWindow) entry.session.contextWindow = evt.contextWindow
        if (evt.model && entry.session.adapterId === 'claude' && entry.session.profileId) {
          const modelState = describeClaudeModelSelection({
            requestedModel: entry.session.model,
            actualModel: evt.model
          })
          Object.assign(entry.session, modelState)
          evt = { ...evt, ...modelState }
        } else if (evt.model && evt.model !== entry.session.model) {
          entry.session.model = evt.model
          const db = getDb()
          if (db) db.updateSession(sessionId, { model: evt.model })
        }
        const cumulativeStats = {
          inputTokens: entry.stats.tokens.input,
          outputTokens: entry.stats.tokens.output,
          costUsd: entry.stats.costUsd,
          costAvailable: entry.stats.costAvailable,
          turnsDelta: entry.stats.turns,
          autoAllowed: entry.stats.approvals.autoAllowed,
          confirmed: entry.stats.approvals.confirmed,
          denied: entry.stats.approvals.denied
        }
        if (usageRecorder) {
          try {
            await usageRecorder.observe({
              sessionId,
              projectPath: entry.session.cwd,
              adapterId: entry.session.adapterId,
              synthetic: evt.synthetic,
              totals: cumulativeStats,
              models: evt.models,
              modelBreakdown: evt.modelBreakdown,
              model: evt.model
            })
          } catch (error) {
            log('Failed to record usage observation:', error)
          }
        }
        {
          const db = getDb()
          if (db) {
            db.upsertStats(sessionId, cumulativeStats)
          }
        }
        // Persist per-model breakdown to model_stats table
        if (evt.modelBreakdown && evt.modelBreakdown.length) {
          const db = getDb()
          if (db) {
            for (const mb of evt.modelBreakdown) {
              db.upsertModelStats(sessionId, mb.model, {
                inputTokens: mb.inputTokens,
                outputTokens: mb.outputTokens,
                costUsd: mb.costUsd,
                costAvailable: mb.costAvailable
              })
            }
          }
        } else if (evt.model) {
          const db = getDb()
          if (db) {
            db.upsertModelStats(sessionId, evt.model, {
              inputTokens: entry.stats.tokens.input,
              outputTokens: entry.stats.tokens.output,
              costUsd: entry.stats.costUsd,
              costAvailable: entry.stats.costAvailable
            })
          }
        }
        scheduleFlush()
        break
      case 'profile-model': {
        const modelState = describeClaudeModelSelection({
          requestedModel: entry.session.model,
          actualModel: evt.actualModel
        })
        Object.assign(entry.session, modelState)
        evt = { ...evt, ...modelState }
        break
      }
    }
    send('session:event', { sessionId, ...evt, status: entry.status })
  }


  // ---- session discovery helpers ----
  const home = process.env.HOME || process.env.USERPROFILE || '~'

  /** Read the last ~16 KB of a transcript file and extract the last text-bearing
   *  message (user or assistant). Returns a short preview string or null. */
  /** Read only the first `maxBytes` of a file without loading the whole file.
   *  Transcripts can be many MB; metadata extraction only needs the head. */
  function _readFileHead(path, maxBytes = 64 * 1024) {
    let fd = null
    try {
      fd = openSync(path, 'r')
      const buffer = Buffer.allocUnsafe(maxBytes)
      const bytesRead = readSync(fd, buffer, 0, maxBytes, 0)
      return buffer.toString('utf8', 0, bytesRead)
    } catch {
      return ''
    } finally {
      if (fd != null) { try { closeSync(fd) } catch { /* ignore */ } }
    }
  }

  /** Read only the last `maxBytes` of a file without loading the whole file. */
  function _readFileTail(path, maxBytes = 64 * 1024) {
    let fd = null
    try {
      fd = openSync(path, 'r')
      const { size } = fstatSync(fd)
      if (!size) return ''
      const length = Math.min(size, maxBytes)
      const buffer = Buffer.allocUnsafe(length)
      const bytesRead = readSync(fd, buffer, 0, length, size - length)
      return buffer.toString('utf8', 0, bytesRead)
    } catch {
      return ''
    } finally {
      if (fd != null) { try { closeSync(fd) } catch { /* ignore */ } }
    }
  }

  function _extractLastText(jsonlPath) {
    try {
      const content = _readFileTail(jsonlPath)
      const tail = content.length > 16384 ? content.slice(-16384) : content
      const lines = tail.split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim()
        if (!line) continue
        try {
          const obj = JSON.parse(line)
          // Claude format
          if (obj.type === 'assistant' && obj.message?.content) {
            for (const b of obj.message.content) {
              if (b.type === 'text' && b.text) return b.text.slice(0, 120)
            }
          }
          if (obj.type === 'user' && obj.message?.content) {
            for (const b of obj.message.content) {
              if (b.type === 'text' && b.text) return b.text.slice(0, 120)
            }
          }
          // Codex format: response_item with payload.type === "message"
          if (obj.type === 'response_item' && obj.payload?.type === 'message') {
            const p = obj.payload
            if (p.content && Array.isArray(p.content)) {
              for (const b of p.content) {
                if ((b.type === 'output_text' || b.type === 'text') && b.text) return b.text.slice(0, 120)
              }
            }
          }
          // Codex format: event_msg with payload.type === "agent_message"
          if (obj.type === 'event_msg' && obj.payload?.type === 'agent_message' && obj.payload.message) {
            return String(obj.payload.message).slice(0, 120)
          }
        } catch { /* skip */ }
      }
      return null
    } catch { return null }
  }

  /** Build a session-index lookup from ~/.claude/sessions/*.json for name
   *  metadata. Keys are sessionId strings. */
  function _claudeIndexByName() {
    const map = new Map()
    try {
      const dir = join(home, '.claude', 'sessions')
      if (!existsSync(dir)) return map
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.json')) continue
        try {
          const raw = JSON.parse(readFileSync(join(dir, f), 'utf8'))
          if (raw.sessionId) map.set(raw.sessionId, raw)
        } catch { /* skip */ }
      }
    } catch { /* ignore */ }
    return map
  }

  /** Discover Claude sessions for a cwd by scanning
   *  ~/.claude/projects/<hash>/*.jsonl directly, then enriching with name
   *  metadata from ~/.claude/sessions/.
   *  Returns array of { sessionId, name, startedAt, model, turns }. */
  function listClaudeSessionsByCwd(cwd) {
    try {
      if (!cwd) return []
      const idx = _claudeIndexByName()
      const found = []
      for (const transcript of listClaudeTranscriptFiles(home, cwd)) {
        const sessionId = transcript.sessionId
        const meta = idx.get(sessionId) || {}
        const fullPath = transcript.fullPath
        let model = normalizeClaudeHistoryModel(meta.model)
        let turns = 0
        try {
          const content = readFileSync(fullPath, 'utf8')
          // Extract model from init line (first ~2KB)
          for (const line of content.slice(0, 2048).split('\n').filter(Boolean)) {
            try {
              const obj = JSON.parse(line)
              if (obj.type === 'system' && obj.subtype === 'init' && !model) {
                model = normalizeClaudeHistoryModel(obj.model)
              }
              if (obj.type === 'result' && obj.num_turns) turns = obj.num_turns
            } catch { /* skip */ }
          }
          // Also scan for result lines with num_turns
          if (!turns) {
            for (const line of content.split('\n')) {
              try {
                const obj = JSON.parse(line)
                if (obj.type === 'result' && obj.num_turns) { turns = obj.num_turns; break }
              } catch { /* skip */ }
            }
          }
        } catch { /* metadata extraction is best-effort */ }

        found.push({
          sessionId,
          name: meta.name || null,
          startedAt: meta.startedAt || transcript.startedAt,
          model,
          turns,
          lastMessage: _extractLastText(fullPath)
        })
      }
      return found
    } catch { return [] }
  }

  /** Discover Codex sessions by scanning ~/.codex/sessions/<year>/<month>/<day>/
   *  for rollout-*.jsonl files. Reads the first line (session_meta) of each to
   *  extract cwd, sessionId, and timestamp. Falls back to session_index.jsonl
   *  for session names.
   *  If cwd is given, only returns sessions matching that directory.
   *  Returns array of { sessionId, name, startedAt }. */
  function listCodexSessions(cwd) {
    try {
      const codexHome = getCodexHome()
      const sessionsDir = join(codexHome, 'sessions')
      if (!existsSync(sessionsDir)) return []
      const providerConfig = readCodexRuntimeSnapshot(codexHome)

      // Build name lookup from session_index.jsonl
      const nameMap = new Map()
      try {
        const idxPath = join(codexHome, 'session_index.jsonl')
        if (existsSync(idxPath)) {
          const lines = readFileSync(idxPath, 'utf8').split('\n').filter(Boolean)
          for (const line of lines) {
            try {
              const obj = JSON.parse(line)
              if (obj.id) {
                nameMap.set(obj.id, (obj.thread_name || '').replace(/<[^>]+>/g, '').trim() || null)
              }
            } catch { /* skip */ }
          }
        }
      } catch { /* ok */ }

      const normCwd = cwd ? (cwd || '').replace(/\\/g, '/').toLowerCase() : null
      const found = []

      // Walk year/month/day directories
      const years = readdirSync(sessionsDir)
      for (const year of years) {
        const yearDir = join(sessionsDir, year)
        let months
        try { months = readdirSync(yearDir) } catch { continue }
        for (const month of months) {
          const monthDir = join(yearDir, month)
          let days
          try { days = readdirSync(monthDir) } catch { continue }
          for (const day of days) {
            const dayDir = join(monthDir, day)
            let files
            try { files = readdirSync(dayDir) } catch { continue }
            for (const f of files) {
              if (!f.endsWith('.jsonl')) continue
              const fullPath = join(dayDir, f)
              let meta = null
              try {
                // Codex session_meta lines can be large. Read enough bytes to cover
                // 65536 UTF-16 code units (UTF-8 max 4 bytes/unit) so CJK first lines
                // are not truncated, then slice to the original code-unit bound.
                const head = _readFileHead(fullPath, 65536 * 4).slice(0, 65536)
                const nl = head.indexOf('\n')
                if (nl > 0) {
                  const firstLine = head.slice(0, nl)
                  const obj = JSON.parse(firstLine)
                  if (obj.type === 'session_meta' && obj.payload) {
                    meta = obj.payload
                  }
                }
              } catch { /* unreadable — skip */ }
              if (!meta || !meta.session_id && !meta.id) continue
              const sessionId = meta.session_id || meta.id
              if (normCwd) {
                const metaCwd = (meta.cwd || '').replace(/\\/g, '/').toLowerCase()
                if (metaCwd !== normCwd) continue
              }
              const provider = resolveCodexResumeProvider(meta.model_provider || null, providerConfig)
              found.push({
                sessionId,
                name: nameMap.get(sessionId) || null,
                startedAt: meta.timestamp ? new Date(meta.timestamp).getTime() : statSync(fullPath).birthtimeMs,
                ...provider,
                lastMessage: _extractLastText(fullPath)
              })
            }
          }
        }
      }

      // Deduplicate by sessionId (latest file wins)
      const seen = new Map()
      for (const s of found) {
        const existing = seen.get(s.sessionId)
        if (!existing || (s.startedAt || 0) > (existing.startedAt || 0)) {
          seen.set(s.sessionId, s)
        }
      }
      return Array.from(seen.values()).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    } catch { return [] }
  }

  /** Find the session closest to `createdAt` in `cwd`. */
  function findClaudeSessionIndex(cwd, nearTs) {
    const found = listClaudeSessionsByCwd(cwd)
    if (!found.length) return null
    if (!nearTs) return found[0]
    let best = null, bestDist = Infinity
    for (const s of found) {
      const dist = Math.abs((s.startedAt || 0) - nearTs)
      if (dist < bestDist) { bestDist = dist; best = s }
    }
    return best
  }

  /** Recover a blank compatible CLI record only from a nearby native session. */
  async function findCompatibleSessionIndex(adapterId, cwd, nearTs) {
    if (!nearTs) return null
    const listNativeSessions = adapters.get(adapterId)?.listNativeSessions
    if (!listNativeSessions) return null
    const found = await listNativeSessions(cwd)
    if (!found.length) return null
    let best = null
    let bestDist = Infinity
    for (const session of found) {
      const dist = Math.abs((session.startedAt || session.updatedAt || 0) - nearTs)
      if (dist < bestDist) { bestDist = dist; best = session }
    }
    // Prevent binding an old UCLI session to an unrelated native record.
    return bestDist <= 10 * 60 * 1000 ? best : null
  }

  function listSessions() {
    return Array.from(sessions.entries()).map(([id, e]) => ({
      id,
      adapterId: e.session.adapterId,
      cwd: e.session.cwd,
      model: e.session.model,
      provider: e.session.provider || null,
      sourceProvider: e.session.sourceProvider || null,
      providerPolicy: e.session.providerPolicy || null,
      providerWarning: e.session.providerWarning || null,
      explicitProvider: e.session.explicitProvider || null,
      pendingProvider: e.session.pendingProvider || null,
      pendingProviderWarning: e.session.pendingProviderWarning || null,
      profileId: e.session.profileId || null,
      activeProfileId: e.session.activeProfileId || null,
      pendingProfileId: e.session.pendingProfileId || null,
      profileStatus: e.session.profileStatus || null,
      actualModel: e.session.actualModel || null,
      profileWarning: e.session.profileWarning || null,
      restartRequired: Boolean(e.session.restartRequired),
      canStart: e.session.canStart !== false,
      tier: e.session.tier,
      status: e.status,
      stats: e.stats,
      cliSessionId: e.session.cliSessionId || null,
      nativeSessionId: e.session.cliSessionId || null,
      name: e.session.name || null,
      taskNote: e.session.taskNote || '',
      adapterConfig: normalizePersistedSessionConfig(
        adapters.get(e.session.adapterId) || {},
        e.session.adapterConfig
      ),
      capabilities: normalizeAdapterCapabilities(e.session.capabilities),
      surfaceState: e.surfaceState || null,
      contextWindow: e.session.contextWindow || null,
      lastActivity: e.lastActivity || '',
      startedAt: e.createdAt || null,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt || e.createdAt
    }))
  }

  function gatewaySessionView(sessionId) {
    const entry = sessions.get(sessionId)
    if (!entry) return null
    const view = {
      id: sessionId,
      name: entry.session.name || null,
      adapterId: entry.session.adapterId,
      provider: entry.session.provider || null,
      status: entry.status,
      turnActive: entry._gatewayTurnActive === true,
      adapterConfig: entry.session.adapterConfig || null,
      capabilities: normalizeAdapterCapabilities(entry.session.capabilities),
      bridgeLive: entry.session.adapterId === 'deepseek-harness'
        ? entry.adapter?.isGatewayLive?.() === true
        : false
    }
    const eligibility = describeGatewaySessionEligibility(view)
    return {
      ...view,
      gatewayEligible: eligibility.eligible,
      gatewayReason: eligibility.reason
    }
  }

  function createUnavailableGatewayManager() {
    const state = {
      desiredEnabled: false,
      phase: 'error',
      channelType: null,
      targetLabel: '',
      botIdentity: null,
      errorCode: 'PERSISTENCE_UNAVAILABLE',
      errorMessage: 'Gateway 持久化不可用。',
      selectedSessionCount: 0,
      readySessionCount: 0,
      pendingDecisionCount: 0,
      queuedTaskCount: 0,
      lastConnectedAt: null
    }
    const unavailable = () => {
      throw Object.assign(new Error('Gateway persistence is unavailable'), {
        code: 'PERSISTENCE_UNAVAILABLE'
      })
    }
    return {
      getState: () => ({ ...state }),
      setDesiredEnabled: unavailable,
      getConfiguration: () => null,
      testDraft: unavailable,
      applyDraft: unavailable,
      listSessions: () => listSessions().map((session) => ({
        id: session.id,
        name: session.name,
        adapterId: session.adapterId,
        provider: session.provider,
        status: session.status,
        relayEnabled: false,
        routeStatus: 'waiting'
      })),
      setSessionRelayEnabled: unavailable,
      resyncSession: async () => ({ accepted: false, reason: 'unavailable' }),
      respondDesktopDecision: async () => ({ accepted: false, reason: 'unavailable' }),
      respondDesktopInput: async () => ({ accepted: false, reason: 'unavailable' }),
      shutdown: async () => {}
    }
  }

  async function startGateway() {
    if (gatewayManager) return gatewayManager.getState()
    const db = getDb()
    if (!db) {
      gatewayManager = createUnavailableGatewayManager()
      return gatewayManager.getState()
    }
    const sessionOperations = createGatewaySessionOperations({
      getEntry: sessionId => sessions.get(sessionId),
      getSession: gatewaySessionView
    })
    const gatewayPort = createGatewayPort({
      listSessions: () => [...sessions.keys()]
        .map(gatewaySessionView)
        .filter(Boolean),
      getSession: gatewaySessionView,
      ...sessionOperations,
      subscribeGatewayEvents: (listener) => gatewaySignals.subscribe(listener)
    })
    gatewayManager = new GatewayManager({
      db,
      safeStorage,
      port: gatewayPort,
      publishState: (state) => send('gateway:state', state)
    })
    await gatewayManager.start()
    return gatewayManager.getState()
  }

  /** Respawn an offline (persisted) session. */
  async function restartSession(sessionId) {
    const entry = sessions.get(sessionId)
    if (!entry) throw new Error('no session')
    assertDshSessionStartable(entry.session)
    if (entry.adapter) throw new Error('session already running')
    const descriptor = adapters.get(entry.session.adapterId)
    if (!descriptor) throw new Error('unknown adapter: ' + entry.session.adapterId)
    engine.setSession(sessionId, { tier: entry.session.tier, rulesetId: entry.session.rulesetId, ruleset: rulesets[entry.session.rulesetId] })
    let profileEnvironment = {}
    let profileLaunch = null
    if (entry.session.adapterId === 'codex') {
      if (entry.session.profileId) {
        const prepared = prepareCodexSessionRuntime(entry.session, {
          imported: Boolean(entry.session.cliSessionId),
          explicitProfileId: entry.session.profileId
        })
        Object.assign(entry.session, prepared.session)
        profileEnvironment = prepared.profileEnvironment
      } else {
        const next = refreshCodexProviderRuntime(entry, {
          imported: Boolean(entry.session.cliSessionId),
          isActive: false
        })
        assertCodexSessionCanStart(next)
      }
      const db = getDb()
      if (db) {
        db.updateSession(sessionId, {
          provider: entry.session.provider,
          source_provider: entry.session.sourceProvider,
          provider_policy: entry.session.providerPolicy,
          explicit_provider: entry.session.explicitProvider,
          profile_id: entry.session.profileId || null
        })
        scheduleFlush()
      }
    } else if (entry.session.adapterId === 'claude') {
      const prepared = prepareClaudeSessionRuntime(entry.session, {
        imported: Boolean(entry.session.cliSessionId),
        explicitProfileId: entry.session.profileId || null,
        forceSystem: !entry.session.profileId
      })
      Object.assign(entry.session, prepared.session)
      profileLaunch = prepared.profileLaunch
      const db = getDb()
      if (db) {
        db.updateSession(sessionId, {
          profile_id: entry.session.profileId || null,
          model: entry.session.model
        })
        scheduleFlush()
      }
    }
    const adapter = descriptor.create({
      session: entry.session,
      engine,
      settings: {
        hookRunnerPath,
        hookPort: null,
        ruleset: rulesets[entry.session.rulesetId],
        codexHome: entry.session.adapterId === 'codex' ? getCodexHome() : null,
        profileEnvironment,
        profileLaunch,
        profileManager: entry.session.adapterId === 'deepseek-harness'
          ? getDshProfileManager()
          : null,
        initialStats: {
          tokens: { ...entry.stats.tokens },
          turns: entry.stats.turns,
          completedTurns: entry.stats.turns
        }
      }
    })
    entry.adapter = adapter
    entry.status = 'starting'
    entry._claudeProfileLaunchStamp = entry.session.adapterId === 'claude'
      ? claudeProfileLaunchStamp(entry.session)
      : null
    entry._dirtyStats = null
    entry._lastCumTokens = null
    entry._lastCompletedTurns = entry.session.adapterId === 'deepseek-harness'
      ? entry.stats.turns
      : entry.session.cliSessionId ? null : 0
    entry._lastNotification = null
    entry._gatewayTurnActive = false
    adapter.on('event', (evt) => handleAdapterEvent(sessionId, evt))
    wireAdapterGateway(sessionId, adapter)
    adapter.hookPort = hookPort
    if (entry.session.adapterId === 'claude') {
      armClaudeSessionLaunch(entry)
    }
    let started
    try {
      started = await adapter.start()
    } catch (error) {
      let disposed = false
      try {
        await adapter.dispose()
        disposed = true
      } catch (cleanupError) {
        error.cleanupCode ||= cleanupError?.code || 'DSH_CLEANUP_FAILED'
      }
      if (disposed) entry.adapter = null
      entry.status = 'error'
      const db = getDb()
      if (db) { db.updateSession(sessionId, { status: 'error' }); scheduleFlush() }
      throw error
    }
    if (started === false) {
      entry.status = 'error'
      entry.adapter = null
      const db = getDb()
      if (db) { db.updateSession(sessionId, { status: 'error' }); scheduleFlush() }
      return false
    }
    if (['codex', 'claude'].includes(entry.session.adapterId)) {
      if (entry.session.adapterId === 'codex') {
        entry.session.activeProfileId = entry.session.profileId || null
        entry.session.pendingProfileId = null
        entry.session.pendingProfileRuntimeRevision = null
        entry.session.restartRequired = false
      }
      publishProfileRuntime(sessionId, entry.session)
    }
    const db = getDb()
    if (db) { db.updateSession(sessionId, { status: 'idle' }); scheduleFlush() }
    send('session:event', { sessionId, type: 'ready', status: entry.status })
    await gatewayManager?.resyncSession(sessionId)
  }

  async function restartSessionForSkills(sessionId) {
    const entry = sessions.get(sessionId)
    if (!entry) throw new Error('no session')
    if (entry.adapter) {
      await entry.adapter.dispose()
      entry.adapter = null
      entry.status = 'offline'
      const db = getDb()
      if (db) db.updateSession(sessionId, { status: 'offline' })
    }
    return restartSession(sessionId)
  }

  function updateCodexProviderPolicy(sessionId, { policy, explicitProvider } = {}) {
    const entry = sessions.get(sessionId)
    if (!entry) throw new Error('no session')
    if (entry.session.adapterId !== 'codex') throw new Error('provider policy is only available for Codex')
    if (entry.session.profileId) throw new Error('provider policy is unavailable while a Codex profile is selected')
    if (!['source', 'live', 'explicit'].includes(policy)) throw new Error('invalid Codex provider policy')
    if (explicitProvider && !isSafeProviderName(explicitProvider)) throw new Error('invalid Codex provider')

    const resolved = applyCodexProviderPolicy({
      ...entry.session,
      providerPolicy: policy,
      explicitProvider: explicitProvider || entry.session.explicitProvider || null
    }, { imported: Boolean(entry.session.cliSessionId) })
    const runtime = reconcileCodexRuntimeProvider({
      session: entry.session,
      resolved,
      isActive: hasActiveCodexProcess(entry)
    })
    Object.assign(entry.session, resolved, runtime)
    const db = getDb()
    if (db) {
      db.updateSession(sessionId, {
        provider: entry.session.provider,
        source_provider: entry.session.sourceProvider,
        provider_policy: entry.session.providerPolicy,
        explicit_provider: entry.session.explicitProvider
      })
      scheduleFlush()
    }
    const result = {
      provider: entry.session.provider,
      sourceProvider: entry.session.sourceProvider,
      providerPolicy: entry.session.providerPolicy,
      explicitProvider: entry.session.explicitProvider,
      providerWarning: entry.session.providerWarning,
      pendingProvider: entry.session.pendingProvider,
      pendingProviderWarning: entry.session.pendingProviderWarning,
      restartRequired: entry.session.restartRequired,
      canStart: entry.session.canStart
    }
    send('session:event', { sessionId, type: 'codex-runtime', ...result })
    return result
  }

  function setSessionProfile(sessionId, profileId) {
    const entry = sessions.get(sessionId)
    if (!entry) throw new Error('no session')
    if (!['codex', 'claude'].includes(entry.session.adapterId)) {
      throw new Error('profiles are unavailable for this session')
    }
    if (!profileService) throw new Error('profile service is unavailable')

    const desiredProfileId = profileId || null
    let resolved
    let desiredSession
    if (desiredProfileId) {
      const profile = profileService.listProfiles({ adapterId: entry.session.adapterId })
        .find((item) => item.id === desiredProfileId)
      if (!profile) throw new Error('profile not found')
      const state = profileService.resolveProfileRuntime(desiredProfileId)
      resolved = {
        profileId: desiredProfileId,
        status: state.status,
        canStart: state.canStart,
        runtimeRevision: state.runtimeRevision
      }
      desiredSession = entry.session.adapterId === 'codex'
        ? {
            nativeProfileName: state.nativeProfileName || null,
            model: profile.model,
            provider: state.providerId || profile.providerId,
            sourceProvider: null,
            providerPolicy: null,
            explicitProvider: null,
            providerOverride: null,
            providerWarning: null
          }
        : {
            model: profile.model ?? entry.session.systemModel ?? null,
            actualModel: null,
            profileWarning: null
          }
    } else {
      resolved = {
        profileId: null,
        status: null,
        canStart: true,
        runtimeRevision: null
      }
      desiredSession = entry.session.adapterId === 'codex'
        ? {
            ...applyCodexProviderPolicy({
              ...entry.session,
              profileId: null,
              nativeProfileName: null
            }, { imported: Boolean(entry.session.cliSessionId) }),
            nativeProfileName: null
          }
        : {
            profileId: null,
            model: entry.session.systemModel ?? null,
            actualModel: null,
            profileWarning: null
          }
    }

    const runtime = reconcileActiveProfile({
      session: entry.session,
      resolved,
      isActive: hasActiveCodexProcess(entry)
    })
    Object.assign(entry.session, desiredSession, runtime)

    const db = getDb()
    if (db) {
      db.updateSession(sessionId, {
        profile_id: desiredProfileId,
        model: entry.session.model,
        provider: entry.session.provider,
        source_provider: entry.session.sourceProvider,
        provider_policy: entry.session.providerPolicy,
        explicit_provider: entry.session.explicitProvider
      })
      scheduleFlush()
    }
    return publishProfileRuntime(sessionId, entry.session)
  }

  async function saveSummarySettingsPatch(summary) {
    const previousCacheMaxBytes = summarySettings.cacheMaxBytes
    const candidate = {
      ...summarySettings,
      ...summary,
      autoPeriods: { ...summarySettings.autoPeriods, ...(summary.autoPeriods || {}) }
    }
    const db = getDb()
    const automationAvailable = Boolean(db && summaryScheduler && summaryAutomationReady)
    summarySettings = {
      ...updateSummarySettings(summarySettings, summary, { automationAvailable }),
      cacheEnabled: candidate.cacheEnabled,
      cacheMaxBytes: candidate.cacheMaxBytes,
      failedWorkspaceRetentionDays: candidate.failedWorkspaceRetentionDays,
      mapConcurrency: candidate.mapConcurrency
    }
    if (db) {
      db.setSummarySettings(summarySettings)
      scheduleFlush()
    }
    if (summarySettings.cacheMaxBytes < previousCacheMaxBytes) {
      await summaryStorageMaintenance?.()
    }
    if (summaryAutomationReady) await summaryScheduler?.tick()
    return summarySettings
  }

  // ---- IPC registration ----
  function getDshProfileManager() {
    if (dshProfileManager) return dshProfileManager
    dshProfileManager = createDshProfileManager({
      env: process.env,
      homeDirectory: app.getPath('home'),
      tempDirectory: join(app.getPath('temp'), 'ucli-dsh-profile-transactions'),
      inspectRuntime: async options => {
        const selected = await getDshRuntimeManager().selectLaunch()
        if (selected?.source !== 'managed') return inspectDshRuntime(options)
        return {
          installed: true,
          compatible: true,
          version: SUPPORTED_DSH_VERSION,
          reason: '',
          pnpmAvailable: true,
          launch: selected.launch,
          home: selected.home
        }
      },
      execute: runResolvedProcess
    })
    return dshProfileManager
  }

  function getDshRuntimeManager() {
    if (dshRuntimeManager) return dshRuntimeManager
    const homeDirectory = app.getPath('home')
    dshRuntimeManager = createDshRuntimeManager({
      runtimeDirectory: join(app.getPath('userData'), 'runtimes', 'deepseek-harness'),
      dshHome: resolveDshHome({ env: process.env, homeDirectory }),
      env: process.env,
      assertQuiescent: () => assertDshQuiescent(sessions)
    })
    return dshRuntimeManager
  }

  function getDshWebClient() {
    if (dshWebClient) return dshWebClient
    dshWebClient = createDshWebClient()
    return dshWebClient
  }

  const dshStatsPoller = createDshStatsPoller({
    entries: () => sessions,
    dshClient: { aggregateTokenUsage: (url) => getDshWebClient().aggregateTokenUsage(url) },
    onStats: (sessionId, tokens) => handleAdapterEvent(sessionId, {
      type: 'stats_update',
      usage: { inputTokens: tokens.input, outputTokens: tokens.output }
    })
  })

  const interactiveAdapterFacades = new Map()

  function interactiveSummarySessionEntry(sessionId) {
    const entry = sessions.get(sessionId)
    if (!entry?.adapter) return null
    const cached = interactiveAdapterFacades.get(sessionId)
    if (cached?.source === entry.adapter) return { adapter: cached.facade }
    const source = entry.adapter
    const facade = {
      on: (...args) => source.on(...args),
      removeListener: (...args) => source.removeListener(...args),
      sendTurn: text => sendSessionTurn(sessionId, text)
    }
    interactiveAdapterFacades.set(sessionId, { source, facade })
    return { adapter: facade }
  }

  async function startAdapterSession(sessionId) {
    const e = sessions.get(sessionId)
    if (e) assertDshSessionStartable(e.session)
    if (!e || !e.adapter) return false
    let pinnedProfileReadiness = e._interactiveProfileReadiness
    try {
      assertInteractiveProfileSnapshotCurrent(pinnedProfileReadiness)
      if (e.session.adapterId === 'codex' && !pinnedProfileReadiness) {
        if (e.session.profileId) {
          const prepared = prepareCodexSessionRuntime(e.session, {
            imported: Boolean(e.session.cliSessionId),
            explicitProfileId: e.session.profileId
          })
          Object.assign(e.session, prepared.session)
          e.adapter.setProfileEnvironment?.(prepared.profileEnvironment)
        } else {
          const next = refreshCodexProviderRuntime(e, {
            imported: Boolean(e.session.cliSessionId),
            isActive: false
          })
          send('session:event', {
            sessionId,
            type: 'codex-runtime',
            provider: next.provider,
            providerPolicy: next.providerPolicy,
            explicitProvider: next.explicitProvider,
            providerWarning: next.providerWarning,
            pendingProvider: next.pendingProvider,
            pendingProviderWarning: next.pendingProviderWarning,
            restartRequired: next.restartRequired,
            canStart: next.canStart
          })
          assertCodexSessionCanStart(next)
        }
      }
      await hookReady
      assertInteractiveProfileSnapshotCurrent(pinnedProfileReadiness)
      e.adapter.hookPort = hookPort
      if (e.session.adapterId === 'claude') armClaudeSessionLaunch(e)
      let started
      try {
        try {
          assertInteractiveProfileSnapshotCurrent(pinnedProfileReadiness)
        } finally {
          clearInteractiveProfileCapability(e)
          pinnedProfileReadiness = null
        }
        started = await e.adapter.start()
      } catch (error) {
        clearInteractiveProfileCapability(e)
        let disposed = false
        try {
          await e.adapter.dispose()
          disposed = true
        } catch (cleanupError) {
          error.cleanupCode ||= cleanupError?.code || 'DSH_CLEANUP_FAILED'
        } finally {
          clearInteractiveProfileCapability(e)
        }
        if (disposed) e.adapter = null
        e.status = 'error'
        const db = getDb()
        if (db) { db.updateSession(sessionId, { status: 'error' }); scheduleFlush() }
        throw error
      }
      if (started === false) {
        e.status = 'error'
        const db = getDb()
        if (db) { db.updateSession(sessionId, { status: 'error' }); scheduleFlush() }
        return false
      }
      if (['codex', 'claude'].includes(e.session.adapterId)) {
        if (e.session.adapterId === 'codex') {
          e.session.activeProfileId = e.session.profileId || null
          e.session.pendingProfileId = null
          e.session.pendingProfileRuntimeRevision = null
          e.session.restartRequired = false
        }
        publishProfileRuntime(sessionId, e.session)
      }
      await gatewayManager?.resyncSession(sessionId)
      return true
    } finally {
      clearInteractiveProfileCapability(e)
      pinnedProfileReadiness = null
    }
  }

  async function stopSession(sessionId, _reason = null) {
    const e = sessions.get(sessionId)
    if (e) {
      clearInteractiveProfileCapability(e)
      engine.removeSession(sessionId)
      const cleanup = e.adapter?.dispose()
      gatewaySignals.publish({
        type: 'session_stopped',
        sessionId,
        occurredAt: Date.now()
      })
      try {
        await cleanup
      } finally {
        clearInteractiveProfileCapability(e)
      }
      e.adapter = null
      interactiveAdapterFacades.delete(sessionId)
      e.status = 'offline'
      if (e.session.capabilities.surface === 'web') {
        e.surfaceState = normalizeDshWebSurfaceState({
          status: 'stopped', url: null, errorCode: null
        })
        send('session:event', {
          sessionId,
          type: 'surface_state',
          surfaceState: e.surfaceState,
          status: e.status
        })
      }
      if (['codex', 'claude'].includes(e.session.adapterId)) {
        e.session.activeProfileId = null
        e.session.pendingProfileId = null
        e.session.pendingProfileRuntimeRevision = null
        e.session.restartRequired = false
        publishProfileRuntime(sessionId, e.session)
      }
      const db = getDb()
      if (db) { db.updateSession(sessionId, { status: 'offline' }); scheduleFlush() }
    }
    return true
  }

  async function removeSessionProjection(sessionId, { persist = true } = {}) {
    const e = sessions.get(sessionId)
    if (e) {
      clearInteractiveProfileCapability(e)
      engine.removeSession(sessionId)
      gatewaySignals.publish({
        type: 'session_stopped',
        sessionId,
        occurredAt: Date.now()
      })
      let cleanupError = null
      try {
        await e.adapter?.dispose()
      } catch (error) {
        cleanupError = error
      } finally {
        clearInteractiveProfileCapability(e)
        interactiveAdapterFacades.delete(sessionId)
        sessions.delete(sessionId)
        historyService.invalidate(sessionId)
        const db = getDb()
        if (persist && db) db.removeSession(sessionId)
        scheduleFlush()
      }
      if (cleanupError) throw cleanupError
    }
    return true
  }

  function registerIpc() {
    registerGatewayIpc({ ipcMain, manager: gatewayManager })
    registerAiCliProfileIpc({
      ipcMain,
      service: profileService,
      inspectCliTools,
      getCodexRuntime: () => codexConfigWatcher?.getSnapshot() || readCodexRuntimeSnapshot(getCodexHome()),
      getClaudeRuntime: () => readClaudeRuntimeSnapshot({ env: process.env })
    })
    if (skillsService) registerSkillsIpc({ ipcMain, service: skillsService })
    if (serverConnectionManager) {
      registerServerConnectionIpc({ ipcMain, manager: serverConnectionManager, send })
    }
    if (storageService) registerStorageIpc({ ipcMain, service: storageService })
    registerSummaryIpc({
      ipcMain,
      service: {
        getSettings: () => summarySettings,
        setSettings: patch => saveSummarySettingsPatch(patch),
        listReports: filters => {
          if (!summaryRepository) throw Object.assign(new Error(), { code: 'SUMMARY_SERVICE_UNAVAILABLE' })
          return summaryRepository.list(filters).map(({ markdown, ...report }) => report)
        },
        getReport: reportId => {
          if (!summaryRepository) throw Object.assign(new Error(), { code: 'SUMMARY_SERVICE_UNAVAILABLE' })
          const report = summaryRepository.get(reportId)
          if (!report) throw Object.assign(new Error(), { code: 'SUMMARY_REPORT_NOT_FOUND' })
          return report
        },
        async updateTask({ reportId, title, taskNote }) {
          if (!summaryRepository) throw Object.assign(new Error(), { code: 'SUMMARY_SERVICE_UNAVAILABLE' })
          const result = await summaryRepository.updateTask(reportId, { title, taskNote })
          if (result.sessionUpdated && result.sessionId) {
            const entry = sessions.get(result.sessionId)
            if (entry) {
              entry.session.name = result.report.title
              entry.session.taskNote = result.report.taskNote
              entry.updatedAt = result.report.updatedAt
            }
          }
          scheduleFlush()
          return result.report
        },
        generate: async input => {
          if (!summaryJobService || !summaryAutomationReady) {
            throw Object.assign(new Error(), { code: 'SUMMARY_SERVICE_UNAVAILABLE' })
          }
          if (input.action === 'confirm') {
            const required = summaryJobService.getConfirmationCallLimit(input.reportId)
            if (!Number.isInteger(required) || input.confirmationCallLimit < required) {
              throw Object.assign(new Error(), { code: 'INVALID_SUMMARY_IPC' })
            }
            const { reportId } = await summaryJobService.confirm(input.reportId, {
              confirmationCallLimit: input.confirmationCallLimit
            })
            return { reportId }
          }
          const { action: _action, ...request } = input
          const availableExecutors = await inspectCliTools()
          const availableProfiles = request.profileId
            ? profileService?.listProfiles({ adapterId: request.executorId }) || []
            : []
          const validated = validateManualSummaryRequest(request, {
            availableExecutors,
            availableProfiles
          })
          const { reportId } = await summaryJobService.generate({ ...validated, generatedBy: 'manual' })
          return { reportId }
        },
        startInteractive: input => {
          if (!interactiveSummaryJobService || !summaryAutomationReady) {
            throw Object.assign(new Error(), { code: 'SUMMARY_SERVICE_UNAVAILABLE' })
          }
          return interactiveSummaryJobService.start(resolveInteractiveSummarySelection(input))
        },
        cancel: async reportId => {
          if (!interactiveSummaryJobService && !summaryJobService) {
            throw Object.assign(new Error(), { code: 'SUMMARY_SERVICE_UNAVAILABLE' })
          }
          return cancelActiveSummary(reportId, {
            interactiveJobService: interactiveSummaryJobService,
            headlessJobService: summaryJobService
          })
        },
        async setCurrent(reportId) {
          if (!summaryRepository) throw Object.assign(new Error(), { code: 'SUMMARY_SERVICE_UNAVAILABLE' })
          const report = await summaryRepository.setCurrent(reportId)
          scheduleFlush()
          return report
        },
        async deleteReport(reportId) {
          if (!summaryRepository) throw Object.assign(new Error(), { code: 'SUMMARY_SERVICE_UNAVAILABLE' })
          const result = await deleteSummaryReportAndWorkspace(reportId, {
            repository: summaryRepository,
            interactiveJobService: interactiveSummaryJobService,
            headlessJobService: summaryJobService,
            workspaceService: summaryWorkspaceService,
            removeSessionProjection: id => removeSessionProjection(id, { persist: false }),
            onEvent: event => log('summary-maintenance', event)
          })
          scheduleFlush()
          return result
        },
        exportMarkdown: input => {
          if (!summaryExportService?.exportMarkdown) throw Object.assign(new Error(), { code: 'SUMMARY_EXPORT_UNAVAILABLE' })
          return summaryExportService.exportMarkdown(input)
        },
        exportHtml: input => {
          if (!summaryExportService?.exportHtml) throw Object.assign(new Error(), { code: 'SUMMARY_EXPORT_UNAVAILABLE' })
          return summaryExportService.exportHtml(input).catch(error => {
            log('summary-html-export-failed', safeSummaryErrorCode(error?.code, 'SUMMARY_HTML_EXPORT_FAILED'))
            throw error
          })
        },
        async getCacheStats() {
          if (!summaryCacheService || !summaryWorkspaceService) {
            throw Object.assign(new Error(), { code: 'SUMMARY_SERVICE_UNAVAILABLE' })
          }
          const [cacheStats, workspaceStats] = await Promise.all([
            summaryCacheService.stats(),
            summaryWorkspaceService.usage({ includeFailedWorkspaces: true })
          ])
          return normalizeSummaryStorageStats({
            quotaBytes: cacheStats.quotaBytes,
            cacheBytes: cacheStats.bytes,
            workspaceBytes: workspaceStats.bytes,
            entries: cacheStats.entries,
            failedWorkspaces: workspaceStats.failedWorkspaces,
            lastPrunedAt: summaryCacheLastPrunedAt
          })
        },
        async clearCache({ includeFailedWorkspaces }) {
          if (!summaryCacheService || !summaryWorkspaceService) {
            throw Object.assign(new Error(), { code: 'SUMMARY_SERVICE_UNAVAILABLE' })
          }
          const cacheResult = await summaryCacheService.clear()
          const workspaceResult = includeFailedWorkspaces
            ? await summaryWorkspaceService.clearFailed()
            : { removed: 0 }
          summaryCacheLastPrunedAt = Date.now()
          return {
            cacheEntriesRemoved: cacheResult.removed,
            failedWorkspacesRemoved: workspaceResult.removed
          }
        }
      }
    })
    ipcMain.handle('adapters:list', () =>
      Array.from(adapters.values()).map((d) => ({
        id: d.id,
        displayName: d.displayName,
        icon: d.icon,
        models: d.models,
        costAvailable: d.costAvailable !== false,
        capabilities: normalizeAdapterCapabilities(d.capabilities)
      }))
    )
    ipcMain.handle('cli-tools:list', () => inspectCliTools())
    ipcMain.handle('cli-tools:run', (_e, id, action) => runCliToolAction(id, action))
    registerDshProfileIpc({
      ipcMain,
      profileManager: getDshProfileManager(),
      runtimeManager: getDshRuntimeManager()
    })
    ipcMain.handle('diagnostics:get', () => diagnostics.getReport())
    ipcMain.handle('diagnostics:export', () => diagnostics.exportReport())
    ipcMain.handle('codex:runtime:get', () =>
      codexConfigWatcher?.getSnapshot() || readCodexRuntimeSnapshot(getCodexHome())
    )
    registerSessionHistoryIpc(ipcMain, historyService)
    registerSessionArtifactsIpc(ipcMain, artifactsService)
    registerSessionDiagnosticsIpc(ipcMain, sessionDiagnostics)

    ipcMain.handle('dialog:pick-directory', async () => {
      const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
      return result.canceled ? null : result.filePaths[0]
    })

    ipcMain.handle('dialog:pick-skill-archive', async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [{ name: 'Skill ZIP', extensions: ['zip'] }]
      })
      return result.canceled ? null : result.filePaths[0]
    })

    // Discover all CLI sessions for a cwd, grouped by adapter type.
    // Returns native sessions grouped by adapter id.
    ipcMain.handle('session:discover', async (_e, cwd) => {
      const imported = new Set()
      for (const e of sessions.values()) {
        if (e.session.cliSessionId) imported.add(e.session.cliSessionId)
      }
      const decorate = (list) => annotateImportedSessions(list, imported)
        .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
        .slice(0, 30)

      const compatibleGroups = await Promise.all(
        Array.from(adapters.values())
          .filter((descriptor) => descriptor.id !== 'codex' && descriptor.listNativeSessions)
          .map(async (descriptor) => [
            descriptor.id,
            decorate(await descriptor.listNativeSessions(cwd))
          ])
      )
      return {
        claude: decorate(listClaudeSessionsByCwd(cwd)),
        codex: decorate(listCodexSessions(cwd)),
        ...Object.fromEntries(compatibleGroups)
      }
    })

    // Legacy: keep old handlers for backwards compat
    ipcMain.handle('session:scan-claude', (_e, cwd) => {
      return [] // deprecated — use session:discover
    })

    ipcMain.handle('session:create', (_e, config) => {
      assertPublicSessionConfig(config)
      return createSession(config)
    })

    // Renderer calls this after it has registered the terminal-output listener
    ipcMain.handle('session:start-adapter', (_e, sessionId) => startAdapterSession(sessionId))
    ipcMain.handle('session:send-turn', (_e, sessionId, text) => sendSessionTurn(sessionId, text))
    ipcMain.handle('session:send-terminal-input', async (_e, sessionId, data) => {
      const e = sessions.get(sessionId)
      if (e?.session.capabilities.surface === 'web') return false
      if (e && e.adapter && typeof e.adapter.writeInput === 'function') {
        await gatewayManager?.respondDesktopInput(sessionId)
        return e.adapter.writeInput(data)
      }
      return false
    })
    ipcMain.handle('session:terminal-resize', (_e, sessionId, cols, rows) => {
      const e = sessions.get(sessionId)
      if (e?.session.capabilities.surface === 'web') return false
      if (e && e.adapter && typeof e.adapter.resize === 'function') {
        return e.adapter.resize(cols, rows)
      }
      return false
    })
    ipcMain.handle('session:attach-terminal', (_e, sessionId) => {
      const e = sessions.get(sessionId)
      if (e?.session.capabilities.surface === 'web') return false
      if (e?.adapter && typeof e.adapter.replayHistory === 'function') {
        e.adapter.replayHistory()
      }
      return true
    })
    ipcMain.handle('session:respond-approval', async (_e, sessionId, requestId, verdict) => {
      const e = sessions.get(sessionId)
      if (e?.session.capabilities.permissionOwner === 'native') return false
      const gatewayResult = await gatewayManager?.respondDesktopDecision(
        sessionId,
        requestId,
        { action: verdict === 'allow' ? 'allow_once' : 'deny' }
      )
      if (gatewayResult?.accepted) return true
      return engine.respondApproval(sessionId, requestId, verdict)
    })
    ipcMain.handle('session:interrupt', (_e, sessionId) => {
      const e = sessions.get(sessionId)
      if (e?.session.capabilities.surface === 'web') {
        throw Object.assign(new Error('DSH_WEB_NATIVE_OWNERSHIP'), {
          code: 'DSH_WEB_NATIVE_OWNERSHIP'
        })
      }
      if (!e || !e.adapter) throw new Error('会话已离线')
      return e.adapter.interrupt()
    })
    ipcMain.handle('session:resume', async (_e, sessionId, cliSessionId) => {
      const e = sessions.get(sessionId)
      if (!e) throw new Error('no session')
      if (e.session.capabilities.surface === 'web') {
        throw Object.assign(new Error('DSH_WEB_NATIVE_OWNERSHIP'), {
          code: 'DSH_WEB_NATIVE_OWNERSHIP'
        })
      }
      if (!e.adapter) throw new Error('会话已离线，请先重新启动')
      if (!isSafeNativeSessionId(cliSessionId)) throw new Error('invalid native session id')
      if (e.session.adapterId === 'codex' && !e.session.profileId) {
        const next = refreshCodexProviderRuntime(e, {
          imported: Boolean(e.session.cliSessionId),
          isActive: hasActiveCodexProcess(e)
        })
        send('session:event', {
          sessionId,
          type: 'codex-runtime',
          provider: next.provider,
          providerPolicy: next.providerPolicy,
          explicitProvider: next.explicitProvider,
          providerWarning: next.providerWarning,
          pendingProvider: next.pendingProvider,
          pendingProviderWarning: next.pendingProviderWarning,
          restartRequired: next.restartRequired,
          canStart: next.canStart
        })
        if (requiresCodexProcessRestart(next)) {
          throw new Error('Codex configuration changed. Restart this session before resuming it.')
        }
      }
      let result
      try {
        result = await e.adapter.resume(cliSessionId)
      } catch (error) {
        e.status = 'error'
        const db = getDb()
        if (db) { db.updateSession(sessionId, { status: 'error' }); scheduleFlush() }
        throw error
      }
      const resumedSessionId = e.session.cliSessionId || cliSessionId
      const db = getDb()
      if (db) { db.updateSession(sessionId, { native_session_id: resumedSessionId }); db.flush() }
      await gatewayManager?.resyncSession(sessionId)
      return result
    })
    ipcMain.handle('session:restart', (_e, sessionId) => restartSession(sessionId))
    ipcMain.handle('session:set-profile', (_e, sessionId, profileId) =>
      setSessionProfile(sessionId, profileId)
    )
    ipcMain.handle('session:stop', (_e, sessionId) => stopSession(sessionId))
    ipcMain.handle('session:delete', async (_e, sessionId) => {
      return removeSessionProjection(sessionId)
    })
    ipcMain.handle('session:list', () => listSessions())
    ipcMain.handle('session:update-note', (_e, sessionId, note) => {
      const e = sessions.get(sessionId)
      if (e) { e.session.taskNote = note; const db = getDb(); if (db) { db.updateSession(sessionId, { task_note: note }); scheduleFlush() } }
      return true
    })
    // 清除会话持有的原生 CLI 会话 id：复用共享会话重跑时，codex 等适配器会
    // 因 `cliSessionId` 存在而 `resume` 旧线程，须先清空再重启成全新一轮。
    ipcMain.handle('session:reset-native', (_e, sessionId) => {
      const e = sessions.get(sessionId)
      if (e) {
        e.session.cliSessionId = null
        const db = getDb()
        if (db) { db.updateSession(sessionId, { native_session_id: null }); scheduleFlush() }
      }
      return true
    })
    ipcMain.handle('session:update-name', (_e, sessionId, name) => {
      const e = sessions.get(sessionId)
      if (e) { e.session.name = name; const db = getDb(); if (db) { db.updateSession(sessionId, { name }); scheduleFlush() } }
      return true
    })
    ipcMain.handle('session:update-codex-provider-policy', (_e, sessionId, policy) =>
      updateCodexProviderPolicy(sessionId, policy)
    )

    ipcMain.handle('rules:get', () => rulesets)
    ipcMain.handle('rules:update', (_e, next) => {
      rulesets = next
      for (const [id, rs] of Object.entries(rulesets)) engine.setRuleset(id, rs)
      const db = getDb(); if (db) { db.saveRules(rulesets); scheduleFlush() }
      return true
    })
    ipcMain.handle('rules:blacklist', () => describeBlacklist())
    ipcMain.handle('rules:test-pattern', (_e, { pattern, command, path } = {}) => {
      const parsed = parsePattern(pattern)
      if (!parsed) return { matches: false, parsed: null, error: '无法解析模式' }
      const input = { tool: parsed.tool === '*' ? 'Bash' : parsed.tool, command, path }
      const result = classify(input, { highRisk: [pattern] })
      return { matches: result.classification === 'high-risk', parsed, classification: result.classification }
    })

    ipcMain.handle('stats:get', () => {
      const db = getDb()
      for (const [id, e] of sessions) {
        // Persist full stats (tokens + approvals) to DB — upsertStats uses
        // absolute-value semantics, so pass the cumulative totals.
        if (db && sessionUsesUcliStats(e.session)) {
          db.upsertStats(id, {
            inputTokens: e.stats.tokens.input,
            outputTokens: e.stats.tokens.output,
            costUsd: e.stats.costUsd,
            costAvailable: e.stats.costAvailable,
            turnsDelta: e.stats.turns,
            autoAllowed: e.stats.approvals.autoAllowed,
            confirmed: e.stats.approvals.confirmed,
            denied: e.stats.approvals.denied
          })
        }
      }

      // Statistics are historical records. Read removed sessions from the DB
      // as well, then overlay live in-memory entries with their latest state.
      const historical = db?.listSessions({ includeRemoved: true }) || []
      const source = new Map()
      for (const s of historical) {
        const descriptor = adapters.get(s.adapterId)
        let capabilities = null
        try {
          const adapterConfig = normalizeSessionConfig(descriptor, s.adapterConfig)
          capabilities = resolveAdapterCapabilities(descriptor, adapterConfig)
        } catch {}
        if (!sessionUsesUcliStats({ capabilities })) continue
        source.set(s.id, {
          adapterId: s.adapterId,
          model: s.model,
          cwd: s.cwd,
          status: s.removedAt ? 'removed' : s.status,
          ...s.stats
        })
      }
      for (const [id, e] of sessions) {
        if (!sessionUsesUcliStats(e.session)) {
          source.delete(id)
          continue
        }
        source.set(id, {
          adapterId: e.session.adapterId,
          model: e.session.model,
          cwd: e.session.cwd,
          status: e.status,
          ...e.stats
        })
      }

      const perSession = Object.fromEntries(source)
      const total = { input: 0, output: 0, costUsd: 0, costUnavailableCount: 0, turns: 0, approvals: { autoAllowed: 0, confirmed: 0, denied: 0 } }
      for (const row of source.values()) {
        total.input += row.tokens.input
        total.output += row.tokens.output
        if (row.costAvailable === false) total.costUnavailableCount += 1
        else total.costUsd += row.costUsd || 0
        total.turns += row.turns
        for (const k of Object.keys(total.approvals)) total.approvals[k] += row.approvals[k] || 0
      }
      if (db) scheduleFlush()
      const ownedSessionIds = new Set(source.keys())
      const modelRows = db?.listModelStatsRows() || []
      const result = {
        total,
        perSession,
        modelStats: aggregateOwnedModelStats(modelRows, ownedSessionIds)
      }
      return result
    })
    ipcMain.handle('stats:query', createStatsQueryHandler(() => usageQueryService))

    ipcMain.handle('settings:get', () => ({ ...settings, ...summarySettings }))
    ipcMain.handle('settings:update', async (_e, s) => {
      const { appSettings, summary } = splitSettingsPatch(s)
      await saveSummarySettingsPatch(summary)
      const db = getDb()
      settings = { ...settings, ...appSettings }
      if (db) {
        db.saveSettings(settings)
        scheduleFlush()
      }
      if (Object.prototype.hasOwnProperty.call(appSettings, 'codexConfigDir')) {
        const snapshot = startCodexConfigWatcher()
        publishCodexRuntime(snapshot)
      }
      return true
    })

    ipcMain.handle('log:write', (_e, level, ...args) => {
      log(`[renderer/${level}]`, ...args)
    })

    ipcMain.handle('workbench:get', () => {
      log('IPC workbench:get called')
      const db = getDb()
      const result = db ? db.getWorkbench() : null
      log('IPC workbench:get result:', result)
      return result
    })
    ipcMain.handle('workbench:save', (_e, state) => {
      log('IPC workbench:save called with:', JSON.stringify(state))
      const db = getDb()
      if (db) {
        db.saveWorkbench(state)
        log('IPC workbench:save — db.saveWorkbench completed, calling db.flush()')
        db.flush()
        log('IPC workbench:save — db.flush completed')
      } else {
        log('IPC workbench:save — db is NULL, cannot save!')
      }
      return true
    })

    ipcMain.handle('shell:open-external', async (_e, url) => {
      try {
        return await openAllowedExternalUrl(url, (allowedUrl) => shell.openExternal(allowedUrl))
      } catch (err) {
        log('shell:open-external failed for', url, err)
        return false
      }
    })

    ipcMain.handle('shell:open-path', async (_e, path) => {
      try {
        return await shell.openPath(String(path || ''))
      } catch (err) {
        log('shell:open-path failed for', path, err)
        return 'failed'
      }
    })

    ipcMain.handle('shell:show-item-in-folder', async (_e, path) => {
      try {
        shell.showItemInFolder(String(path || ''))
        return true
      } catch (err) {
        log('shell:show-item-in-folder failed for', path, err)
        return false
      }
    })
  }

  function sendSessionTurn(sessionId, text) {
    const e = sessions.get(sessionId)
    if (!e) throw new Error('no session')
    if (e.session.capabilities.surface === 'web') {
      throw Object.assign(new Error('DSH_WEB_NATIVE_OWNERSHIP'), {
        code: 'DSH_WEB_NATIVE_OWNERSHIP'
      })
    }
    if (!e.adapter) throw new Error('会话已离线，请先重新启动')
    return sendAdapterTurn(e, text)
  }

  let shutdownPromise = null
  function shutdown() {
    if (shutdownPromise) return shutdownPromise
    shutdownPromise = (async () => {
      log('shutdown() called')
      dshStatsPoller.stop()
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      await codexConfigWatcher?.stop()
      codexConfigWatcher = null
      await summaryScheduler?.stop()
      summaryScheduler = null
      await interactiveSummaryJobService?.interruptAll('SUMMARY_APP_SHUTDOWN')
      await summaryJobService?.shutdown()
      await summaryWorkspaceService?.recover()
      for (const notification of approvalNotifications.values()) notification.close()
      approvalNotifications.clear()
      for (const notification of completionNotifications) notification.close()
      completionNotifications.clear()
      await gatewayManager?.shutdown()
      const db = getDb()
      for (const [id, entry] of sessions) {
        clearInteractiveProfileCapability(entry)
        engine.removeSession(id)
        if (entry.adapter) {
          try { await Promise.resolve(entry.adapter.dispose()) }
          catch (error) { console.error(`Failed to dispose session ${id}:`, error) }
          finally { clearInteractiveProfileCapability(entry) }
          entry.adapter = null
        }
        entry.status = 'offline'
        if (db) db.updateSession(id, { status: 'offline' })
      }
      try {
        const server = hookServer || await hookReady
        await server?.close()
      } catch (error) {
        console.error('Failed to close permission hook server:', error)
      }
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      if (db) {
        log('shutdown — calling db.flush()')
        db.flush()
        log('shutdown — db.flush() done')
      }
      log('shutdown() complete')
    })()
    return shutdownPromise
  }

  dshStatsPoller.start()

  return {
    registerIpc,
    setMainWindow,
    hookReady,
    initPersistence,
    startGateway,
    shutdown,
    getPersistenceRecovery: () => persistenceRecovery,
    submitServerConnection: connection => serverConnectionManager?.submitParsedConnection(connection) || Promise.reject(
      Object.assign(new Error('Server connection is unavailable'), { code: 'SERVER_CONNECTION_UNAVAILABLE' })
    )
  }
}
