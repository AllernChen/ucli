import { open } from 'node:fs/promises'

import { runnerError } from './processRunner.js'

export async function readBoundedCodexOutput(path, maxOutputBytes) {
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new TypeError('maxOutputBytes must be a positive integer')
  }
  const handle = await open(path, 'r')
  try {
    const metadata = await handle.stat()
    if (metadata.size > maxOutputBytes) {
      throw runnerError(
        'SUMMARY_RUNNER_OUTPUT_LIMIT',
        'Codex output file exceeded the output limit',
        { stream: 'output-file', maxOutputBytes }
      )
    }
    const buffer = Buffer.allocUnsafe(maxOutputBytes + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > maxOutputBytes) {
      throw runnerError(
        'SUMMARY_RUNNER_OUTPUT_LIMIT',
        'Codex output file exceeded the output limit',
        { stream: 'output-file', maxOutputBytes }
      )
    }
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

export function createCodexRunner() {
  return {
    async run() {
      throw runnerError(
        'SUMMARY_EXECUTOR_UNSAFE',
        'Codex summary execution is unavailable because codex exec has no guaranteed no-tools mode'
      )
    }
  }
}
