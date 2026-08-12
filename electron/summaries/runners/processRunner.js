import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'

function runnerError(code, message, metadata = {}) {
  return Object.assign(new Error(message), { code, ...metadata })
}

function commandPaths(command) {
  const result = spawnSync('where.exe', [command], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000
  })
  return result.status === 0
    ? result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : []
}

function expandShimPath(value, shimDirectory) {
  const prefix = shimDirectory.endsWith('\\') ? shimDirectory : `${shimDirectory}\\`
  const expanded = String(value)
    .replace(/%~dp0/gi, prefix)
    .replace(/%dp0%/gi, prefix)
  if (expanded.includes('%')) return null
  return win32.normalize(expanded)
}

function isWithinDirectory(path, directory) {
  const relative = win32.relative(directory, path)
  return relative !== '..' && !relative.startsWith(`..${win32.sep}`) && !win32.isAbsolute(relative)
}

export function resolveSafeCliLaunch(command, {
  platform = process.platform,
  candidates = null,
  nodeCandidates = null,
  pathExists = existsSync,
  readShim = readFileSync
} = {}) {
  if (platform !== 'win32') return { file: command, prefixArgs: [] }
  const paths = candidates || commandPaths(command)
  const executable = paths.find((path) =>
    win32.extname(path).toLowerCase() === '.exe' && pathExists(path)
  )
  if (executable) return { file: executable, prefixArgs: [] }

  for (const shim of paths.filter((path) => win32.extname(path).toLowerCase() === '.cmd')) {
    let content
    try { content = readShim(shim, 'utf8') } catch { continue }
    const directory = win32.dirname(shim)
    const nativeEntries = [...String(content).matchAll(/"(%~?dp0%?[^"\r\n]+\.exe)"/gi)]
      .map((match) => expandShimPath(match[1], directory))
      .filter((path) =>
        path &&
        isWithinDirectory(path, directory) &&
        path.toLowerCase().includes(`${win32.sep}node_modules${win32.sep}`) &&
        path.toLowerCase().includes(command.toLowerCase()) &&
        pathExists(path)
      )
    if (nativeEntries[0]) return { file: nativeEntries[0], prefixArgs: [] }
    const entries = [...String(content).matchAll(/"(%~?dp0%?[^"\r\n]+\.(?:c?js|mjs))"/gi)]
      .map((match) => expandShimPath(match[1], directory))
      .filter((path) =>
        path &&
        isWithinDirectory(path, directory) &&
        path.toLowerCase().includes(`${win32.sep}node_modules${win32.sep}`) &&
        path.toLowerCase().includes(command.toLowerCase()) &&
        pathExists(path)
      )
    const entry = entries[0]
    if (!entry) continue
    const adjacentNode = win32.join(directory, 'node.exe')
    const nodes = pathExists(adjacentNode) ? [adjacentNode] : (nodeCandidates || commandPaths('node'))
    const node = nodes.find((path) =>
      win32.basename(path).toLowerCase() === 'node.exe' && pathExists(path)
    )
    if (node) return { file: node, prefixArgs: [entry] }
  }
  throw runnerError('SUMMARY_RUNNER_EXECUTABLE_NOT_FOUND', `Safe ${command} executable was not found`)
}

export function runProcess({
  file,
  args = [],
  prompt = '',
  cwd,
  env = process.env,
  timeoutMs = 120000,
  maxOutputBytes = 4 * 1024 * 1024,
  signal,
  spawnImpl = spawn,
  onProgress
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(runnerError('SUMMARY_RUNNER_ABORTED', 'Summary runner was aborted'))
      return
    }

    let child
    try {
      child = spawnImpl(file, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (error) {
      reject(runnerError('SUMMARY_RUNNER_SPAWN', 'Unable to start summary runner', { cause: error }))
      return
    }

    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let terminationError = null
    let timer = null

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (action, value) => {
      if (settled) return
      settled = true
      cleanup()
      action(value)
    }
    const fail = (error, options) => finish(reject, error, options)
    const terminate = (error) => {
      if (settled || terminationError) return
      terminationError = error
      cleanup()
      try {
        child.kill()
      } catch {
        finish(reject, error)
      }
    }
    const onAbort = () => terminate(
      runnerError('SUMMARY_RUNNER_ABORTED', 'Summary runner was aborted')
    )
    const collect = (target, chunk, stream) => {
      if (terminationError) return
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (stream === 'stdout') stdoutBytes += value.length
      else stderrBytes += value.length
      if ((stream === 'stdout' ? stdoutBytes : stderrBytes) > maxOutputBytes) {
        terminate(runnerError(
          'SUMMARY_RUNNER_OUTPUT_LIMIT',
          `Summary runner ${stream} exceeded the output limit`,
          { stream, maxOutputBytes }
        ))
        return
      }
      target.push(value)
    }

    child.stdout.on('data', (chunk) => collect(stdout, chunk, 'stdout'))
    child.stderr.on('data', (chunk) => collect(stderr, chunk, 'stderr'))
    child.once('error', (error) => fail(
      runnerError('SUMMARY_RUNNER_SPAWN', 'Unable to start summary runner', { cause: error })
    ))
    child.once('close', (code, processSignal) => {
      if (settled) return
      if (terminationError) {
        finish(reject, terminationError)
        return
      }
      const result = {
        exitCode: code ?? -1,
        signal: processSignal || null,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      }
      if (code !== 0) {
        fail(runnerError('SUMMARY_RUNNER_EXIT', 'Summary runner exited unsuccessfully', {
          exitCode: result.exitCode,
          signal: result.signal,
          stderr: result.stderr
        }))
        return
      }
      onProgress?.({ phase: 'process-complete' })
      finish(resolve, result)
    })

    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => terminate(
      runnerError('SUMMARY_RUNNER_TIMEOUT', 'Summary runner timed out', { timeoutMs })
    ), timeoutMs)
    onProgress?.({ phase: 'process-started' })
    child.stdin.on('error', (error) => {
      if (error?.code !== 'EPIPE') terminate(
        runnerError('SUMMARY_RUNNER_STDIN', 'Unable to send the summary prompt', { cause: error })
      )
    })
    child.stdin.end(String(prompt))
  })
}

export function parseJsonOutput(value) {
  try {
    return JSON.parse(String(value || '').trim())
  } catch (error) {
    throw runnerError('SUMMARY_RUNNER_INVALID_JSON', 'Summary runner returned invalid JSON', {
      cause: error
    })
  }
}

export function parseJsonLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => parseJsonOutput(line))
}

function matchesType(value, type) {
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'integer') return Number.isInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
  return typeof value === type
}

function validateSchemaNode(value, schema, path = '$') {
  if (!schema || typeof schema !== 'object') return null
  const allowedTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  if (allowedTypes.length && !allowedTypes.some((type) => matchesType(value, type))) {
    return `${path} must be ${allowedTypes.join(' or ')}`
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value))) {
    return `${path} must be one of the allowed values`
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) return `${path}.${key} is required`
    }
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const problem = validateSchemaNode(value[key], childSchema, `${path}.${key}`)
        if (problem) return problem
      }
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties || {}))
      const unexpected = Object.keys(value).find((key) => !known.has(key))
      if (unexpected) return `${path}.${unexpected} is not allowed`
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (let index = 0; index < value.length; index += 1) {
      const problem = validateSchemaNode(value[index], schema.items, `${path}[${index}]`)
      if (problem) return problem
    }
  }
  return null
}

export function validateStructuredOutput(value, schema) {
  const problem = validateSchemaNode(value, schema)
  if (problem) {
    throw runnerError('SUMMARY_RUNNER_SCHEMA_INVALID', `Summary output does not match the schema: ${problem}`)
  }
  return value
}

function nonNegativeNumber(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

export function normalizeRunnerResult({ value, schema, usage = {}, rawMetadata = {} }) {
  validateStructuredOutput(value, schema)
  return {
    value,
    usage: {
      inputTokens: nonNegativeNumber(usage.inputTokens),
      outputTokens: nonNegativeNumber(usage.outputTokens),
      costUsd: nonNegativeNumber(usage.costUsd, null)
    },
    rawMetadata
  }
}

const RUNTIME_ENV_KEYS = Object.freeze([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'LANG', 'LC_ALL', 'TZ'
])
const PROVIDER_ENV_KEYS = Object.freeze({
  claude: Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']),
  opencode: Object.freeze([
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'AZURE_OPENAI_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY', 'MISTRAL_API_KEY',
    'GROQ_API_KEY', 'XAI_API_KEY', 'OPENROUTER_API_KEY', 'COHERE_API_KEY'
  ])
})

const PROVIDER_AUTH_ENV_KEYS = Object.freeze({
  claude: Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']),
  opencode: Object.freeze([
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY',
    'AZURE_OPENAI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY',
    'MISTRAL_API_KEY', 'GROQ_API_KEY', 'XAI_API_KEY', 'OPENROUTER_API_KEY',
    'COHERE_API_KEY'
  ])
})

const PROVIDER_ENDPOINT_AUTH_KEYS = Object.freeze({
  claude: Object.freeze({
    ANTHROPIC_BASE_URL: Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])
  }),
  opencode: Object.freeze({
    ANTHROPIC_BASE_URL: Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']),
    OPENAI_BASE_URL: Object.freeze(['OPENAI_API_KEY'])
  })
})

function envValue(source, name) {
  const key = Object.keys(source || {}).find(candidate => candidate.toUpperCase() === name)
  return key ? source[key] : undefined
}

export function hasSummaryProviderAuthentication(provider, env = {}) {
  return (PROVIDER_AUTH_ENV_KEYS[provider] || []).some(name => {
    const value = envValue(env, name)
    return typeof value === 'string' && value.trim().length > 0
  })
}

export function stripSummaryProviderEndpoints(provider, env = {}) {
  const endpointAuthentication = PROVIDER_ENDPOINT_AUTH_KEYS[provider] || {}
  for (const key of Object.keys(env)) {
    const requiredAuthentication = endpointAuthentication[key.toUpperCase()]
    if (requiredAuthentication && !requiredAuthentication.some(name => {
      const value = envValue(env, name)
      return typeof value === 'string' && value.trim()
    })) delete env[key]
  }
  return env
}

export async function buildSummaryProcessEnvironment({
  provider,
  isolatedHome,
  baseEnv = process.env,
  launchEnv = {},
  profileEnv = {}
}) {
  if (!isolatedHome) throw new TypeError('isolatedHome is required')
  const sources = [baseEnv, launchEnv, profileEnv]
  const env = {}
  for (const name of RUNTIME_ENV_KEYS) {
    for (const source of sources) {
      const value = envValue(source, name)
      if (value !== undefined) env[name] = value
    }
  }
  for (const name of PROVIDER_ENV_KEYS[provider] || []) {
    for (const source of sources) {
      const value = envValue(source, name)
      if (value !== undefined) env[name] = value
    }
  }

  const directories = {
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    XDG_CONFIG_HOME: join(isolatedHome, 'config'),
    XDG_DATA_HOME: join(isolatedHome, 'data'),
    XDG_CACHE_HOME: join(isolatedHome, 'cache'),
    APPDATA: join(isolatedHome, 'appdata'),
    LOCALAPPDATA: join(isolatedHome, 'localappdata'),
    TEMP: join(isolatedHome, 'tmp'),
    TMP: join(isolatedHome, 'tmp')
  }
  await Promise.all([...new Set(Object.values(directories))].map(directory =>
    mkdir(directory, { recursive: true })
  ))
  Object.assign(env, directories)
  if (provider === 'claude') {
    env.CLAUDE_CONFIG_DIR = join(isolatedHome, 'claude')
    env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1'
    await mkdir(env.CLAUDE_CONFIG_DIR, { recursive: true })
  }
  return env
}

export async function withIsolatedWorkingDirectory(work) {
  const directory = await mkdtemp(join(tmpdir(), 'ucli-summary-runner-'))
  try {
    return await work(directory)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

export { runnerError }
