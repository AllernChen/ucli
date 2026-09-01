import { spawn } from 'child_process'
import { delimiter, join, posix, win32 } from 'path'
import { getSummaryExecutorCapability } from './summaries/nativeCapabilities.js'
import {
  buildSummaryProcessEnvironment,
  hasSummaryProviderAuthentication,
  stripSummaryProviderEndpoints,
  withIsolatedWorkingDirectory
} from './summaries/runners/processRunner.js'
import {
  inspectClaudeFileAuthentication,
  inspectOpenCodeAuthentication
} from './summaries/runners/authBridge.js'
import { inspectDshRuntime } from './adapters/deepSeekHarnessRuntime.js'

const CLI_TOOLS = {
  claude: {
    id: 'claude',
    displayName: 'Claude Code',
    executable: 'claude',
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    upgradeCommand: 'claude update'
  },
  codex: {
    id: 'codex',
    displayName: 'Codex',
    executable: 'codex',
    installCommand: 'npm install -g @openai/codex',
    upgradeCommand: 'codex --upgrade'
  },
  opencode: {
    id: 'opencode',
    displayName: 'OpenCode',
    executable: 'opencode',
    installCommand: 'npm install -g opencode-ai',
    upgradeCommand: 'npm install -g opencode-ai'
  },
  ucode: {
    id: 'ucode',
    displayName: 'U-Code',
    executable: 'ucode',
    installCommand: 'npm install -g @allenchen77/ucode-cli',
    upgradeCommand: 'npm install -g @allenchen77/ucode-cli'
  },
  'deepseek-harness': {
    id: 'deepseek-harness',
    displayName: 'DeepSeek Harness',
    executable: 'dsh',
    installCommand: 'npm install -g @deepseek-ai/dsh@0.1.0-rc.6',
    upgradeCommand: 'npm install -g @deepseek-ai/dsh@0.1.0-rc.6'
  }
}
const activeCliInspections = new WeakMap()
export function listCliToolDefinitions() {
  return Object.values(CLI_TOOLS).map(summaryCapability)
}

function summaryCapability(tool) {
  const capability = getSummaryExecutorCapability(tool.id)
  const safeForSummary = capability?.available === true
  return {
    ...tool,
    safeForSummary,
    summaryExecutorAvailable: false,
    summaryExecutorUnavailableReason: safeForSummary
      ? 'summary-authentication-unverified'
      : (capability?.reason || 'unsupported-executor'),
    summaryAuthenticationSource: null
  }
}

async function inspectSummaryAuthentication(id, {
  installed,
  env = process.env,
  homeDirectory,
  platform = process.platform,
  runner = runFixedCommand
} = {}) {
  const capability = getSummaryExecutorCapability(id)
  if (capability?.available !== true) {
    return { available: false, reason: capability?.reason || 'unsupported-executor', source: null }
  }
  if (!installed) return { available: false, reason: 'cli-not-installed', source: null }
  if (hasSummaryProviderAuthentication(id, env)) {
    return { available: true, reason: '', source: 'provider-env' }
  }
  if (id === 'opencode') {
    return inspectOpenCodeAuthentication({ env, homeDirectory, platform })
  }
  if (id === 'claude') {
    const fileAuthentication = await inspectClaudeFileAuthentication({ env, homeDirectory, platform })
    if (fileAuthentication.available) return fileAuthentication
    if (platform === 'win32') return fileAuthentication
    if (platform === 'darwin') {
      return withIsolatedWorkingDirectory(async directory => {
        const probeEnv = await buildSummaryProcessEnvironment({
          provider: 'claude',
          isolatedHome: join(directory, 'home'),
          baseEnv: env
        })
        stripSummaryProviderEndpoints('claude', probeEnv)
        const result = await runner('claude auth status --json', 10_000, probeEnv)
        try {
          const status = JSON.parse(result.stdout)
          if (result.code === 0 && status?.loggedIn === true) {
            return { available: true, reason: '', source: 'keychain' }
          }
        } catch {}
        return {
          available: false,
          reason: 'requires-allowlisted-env-or-managed-profile',
          source: null
        }
      })
    }
  }
  return {
    available: false,
    reason: 'requires-allowlisted-env-or-managed-profile',
    source: null
  }
}

export async function inspectCliTool(id, runner = runFixedCommand, options = {}) {
  const tool = requireTool(id)
  if (id === 'deepseek-harness') {
    const runtime = await (options.dshRuntimeInspector || inspectDshRuntime)({
      env: options.env || process.env,
      homeDirectory: options.homeDirectory
    })
    const version = typeof runtime.version === 'string' &&
      runtime.version.length <= 64 &&
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/u.test(runtime.version)
      ? runtime.version
      : ''
    const compatibilityReason = ['not-installed', 'version-unreadable', 'unsupported-version', ''].includes(runtime.reason)
      ? runtime.reason
      : 'version-unreadable'
    return {
      ...summaryCapability(tool),
      installed: runtime.installed === true,
      path: '',
      version,
      compatible: runtime.compatible === true,
      compatibilityReason,
      error: runtime.installed ? '' : 'not-installed'
    }
  }
  if (id === 'opencode' || id === 'ucode') {
    await prependNpmGlobalBinToPath(runner)
  }
  const pathCommand = process.platform === 'win32'
    ? `where ${tool.executable}`
    : `command -v ${tool.executable}`
  const [pathResult, versionResult] = await Promise.all([
    runner(pathCommand, 10_000),
    runner(`${tool.executable} --version`, 10_000)
  ])
  const installed = versionResult.code === 0
  const summaryAuthentication = await inspectSummaryAuthentication(id, {
    installed,
    env: options.env || process.env,
    homeDirectory: options.homeDirectory,
    platform: options.platform || process.platform,
    runner
  })
  return {
    ...summaryCapability(tool),
    summaryExecutorAvailable: summaryAuthentication.available,
    summaryExecutorUnavailableReason: summaryAuthentication.reason || '',
    summaryAuthenticationSource: summaryAuthentication.source,
    installed,
    path: firstLine(pathResult.stdout),
    version: installed ? firstLine(versionResult.stdout || versionResult.stderr) : '',
    error: installed ? '' : firstLine(versionResult.stderr || versionResult.stdout)
  }
}

export async function inspectCliTools(runner = runFixedCommand) {
  const active = activeCliInspections.get(runner)
  if (active) return active
  const inspection = Promise.all(Object.keys(CLI_TOOLS).map((id) => inspectCliTool(id, runner)))
  activeCliInspections.set(runner, inspection)
  const release = () => {
    if (activeCliInspections.get(runner) === inspection) activeCliInspections.delete(runner)
  }
  inspection.then(release, release)
  return inspection
}

export async function runCliToolAction(id, action, runner = runFixedCommand, options = {}) {
  const tool = requireTool(id)
  if (action !== 'install' && action !== 'upgrade') {
    throw new Error(`unsupported CLI action: ${action}`)
  }
  const command = action === 'install' ? tool.installCommand : tool.upgradeCommand
  const result = await runner(command, 10 * 60_000)
  const status = await inspectCliTool(id, runner, options)
  if (id === 'deepseek-harness') {
    return {
      ok: result.code === 0,
      command,
      code: result.code,
      status
    }
  }
  return {
    ok: result.code === 0,
    command,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    status
  }
}

async function prependNpmGlobalBinToPath(runner) {
  const result = await runner('npm prefix -g', 10_000)
  if (result.code !== 0) return
  const prefix = firstLine(result.stdout)
  const pathApi = process.platform === 'win32' ? win32 : posix
  if (!pathApi.isAbsolute(prefix)) return
  const npmBin = process.platform === 'win32'
    ? pathApi.normalize(prefix)
    : pathApi.join(prefix, 'bin')
  const paths = String(process.env.PATH || '').split(delimiter).filter(Boolean)
  const normalise = process.platform === 'win32'
    ? (value) => value.toLowerCase()
    : (value) => value
  process.env.PATH = [
    npmBin,
    ...paths.filter((value) => normalise(value) !== normalise(npmBin))
  ].join(delimiter)
}

function requireTool(id) {
  const tool = CLI_TOOLS[id]
  if (!tool) throw new Error(`unknown CLI tool: ${id}`)
  return tool
}

function firstLine(value = '') {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || ''
}

function runFixedCommand(command, timeoutMs, env = process.env) {
  return new Promise((resolve) => {
    const shell = process.platform === 'win32'
      ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
      : { file: '/bin/sh', args: ['-lc', command] }
    const child = spawn(shell.file, shell.args, {
      windowsHide: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer = null
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.once('error', (error) => finish({ code: -1, stdout, stderr: error.message }))
    child.once('close', (code) => finish({ code: code ?? -1, stdout, stderr }))
    timer = setTimeout(() => {
      child.kill()
      finish({ code: -1, stdout, stderr: `${stderr}\ncommand timed out`.trim() })
    }, timeoutMs)
  })
}
