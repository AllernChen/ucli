import { createClaudeRunner } from './runners/claudeRunner.js'
import { createCodexRunner } from './runners/codexRunner.js'
import { createOpenCodeRunner } from './runners/openCodeRunner.js'
import { runnerError } from './runners/processRunner.js'

export function createSummaryRunner({
  profileService,
  processRunner,
  executableResolvers = {},
  maxBudgetUsd = null,
  validateWorkspaceDirectory = null
} = {}) {
  const runners = {
    claude: createClaudeRunner({
      profileService,
      processRunner,
      resolveExecutable: executableResolvers.claude,
      maxBudgetUsd,
      validateWorkspaceDirectory
    }),
    codex: createCodexRunner({
      profileService,
      processRunner,
      resolveExecutable: executableResolvers.codex
    }),
    opencode: createOpenCodeRunner({
      adapterId: 'opencode',
      processRunner,
      resolveExecutable: executableResolvers.opencode,
      validateWorkspaceDirectory
    }),
    ucode: createOpenCodeRunner({
      adapterId: 'ucode',
      processRunner,
      resolveExecutable: executableResolvers.ucode,
      validateWorkspaceDirectory
    })
  }
  return {
    async run({ executorId, ...options }) {
      const runner = runners[executorId]
      if (!runner) {
        throw runnerError('SUMMARY_RUNNER_UNSUPPORTED_EXECUTOR', `Unsupported executor: ${executorId}`)
      }
      return runner.run(options)
    }
  }
}
