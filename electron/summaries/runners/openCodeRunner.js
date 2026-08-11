import { resolveOpenCodeLaunch } from '../../adapters/openCodeAdapter.js'
import { resolveUCodeLaunch } from '../../adapters/ucodeAdapter.js'

import {
  normalizeRunnerResult,
  parseJsonLines,
  parseJsonOutput,
  runProcess,
  runnerError,
  withIsolatedWorkingDirectory
} from './processRunner.js'

function strictPrompt(prompt, schema) {
  return `${prompt}\n\nReturn only JSON matching this schema: ${JSON.stringify(schema || {})}`
}
function eventText(event) {
  if (typeof event?.part?.text === 'string') return event.part.text
  if (typeof event?.text === 'string') return event.text
  if (typeof event?.content === 'string') return event.content
  if (typeof event?.result === 'string') return event.result
  return null
}

function eventUsage(events) {
  let inputTokens = 0
  let outputTokens = 0
  let costUsd = null
  for (const event of events) {
    const usage = event?.usage || event?.part?.tokens
    inputTokens += Number.isFinite(usage?.input_tokens ?? usage?.input)
      ? (usage.input_tokens ?? usage.input)
      : 0
    outputTokens += Number.isFinite(usage?.output_tokens ?? usage?.output)
      ? (usage.output_tokens ?? usage.output)
      : 0
    const cost = event?.cost ?? event?.part?.cost
    if (Number.isFinite(cost) && cost >= 0) costUsd = (costUsd || 0) + cost
  }
  return { inputTokens, outputTokens, costUsd }
}

export function createOpenCodeRunner({
  adapterId = 'opencode',
  resolveExecutable,
  processRunner = runProcess
} = {}) {
  if (!['opencode', 'ucode'].includes(adapterId)) {
    throw runnerError('SUMMARY_RUNNER_UNSUPPORTED_EXECUTOR', `Unsupported executor: ${adapterId}`)
  }
  const resolver = resolveExecutable || (adapterId === 'ucode' ? resolveUCodeLaunch : resolveOpenCodeLaunch)
  return {
    async run(options) {
      if (options.profileId) {
        throw runnerError('SUMMARY_RUNNER_PROFILE_UNSUPPORTED', `${adapterId} does not support AI CLI profiles`)
      }
      return withIsolatedWorkingDirectory(async (workingDirectory) => {
        const launch = resolver() || {}
        const args = [
          ...(launch.prefixArgs || []),
          'run', '--format', 'json'
        ]
        if (options.model) args.push('--model', options.model)
        args.push('-')
        const processResult = await processRunner({
          file: launch.file,
          args,
          prompt: strictPrompt(options.prompt, options.schema),
          cwd: workingDirectory,
          env: { ...process.env, ...(launch.env || {}) },
          timeoutMs: options.timeoutMs,
          maxOutputBytes: options.maxOutputBytes,
          signal: options.signal,
          onProgress: options.onProgress
        })
        const events = parseJsonLines(processResult.stdout)
        const directValue = [...events].reverse().find((event) => event?.value !== undefined)?.value
        const text = events.map(eventText).filter(Boolean).join('')
        const value = directValue !== undefined ? directValue : parseJsonOutput(text)
        return normalizeRunnerResult({
          value,
          schema: options.schema,
          usage: eventUsage(events),
          rawMetadata: {
            adapterId,
            exitCode: processResult.exitCode,
            eventCount: events.length
          }
        })
      })
    }
  }
}
