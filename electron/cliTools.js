import { spawn } from 'child_process'

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
    upgradeCommand: 'opencode upgrade'
  }
}
export function listCliToolDefinitions() {
  return Object.values(CLI_TOOLS).map((tool) => ({ ...tool }))
}

export async function inspectCliTool(id, runner = runFixedCommand) {
  const tool = requireTool(id)
  const pathCommand = process.platform === 'win32'
    ? `where ${tool.executable}`
    : `command -v ${tool.executable}`
  const [pathResult, versionResult] = await Promise.all([
    runner(pathCommand, 10_000),
    runner(`${tool.executable} --version`, 10_000)
  ])
  const installed = versionResult.code === 0
  return {
    ...tool,
    installed,
    path: firstLine(pathResult.stdout),
    version: installed ? firstLine(versionResult.stdout || versionResult.stderr) : '',
    error: installed ? '' : firstLine(versionResult.stderr || versionResult.stdout)
  }
}

export async function inspectCliTools(runner = runFixedCommand) {
  return Promise.all(Object.keys(CLI_TOOLS).map((id) => inspectCliTool(id, runner)))
}

export async function runCliToolAction(id, action, runner = runFixedCommand) {
  const tool = requireTool(id)
  if (action !== 'install' && action !== 'upgrade') {
    throw new Error(`unsupported CLI action: ${action}`)
  }
  const command = action === 'install' ? tool.installCommand : tool.upgradeCommand
  const result = await runner(command, 10 * 60_000)
  return {
    ok: result.code === 0,
    command,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    status: await inspectCliTool(id, runner)
  }
}

function requireTool(id) {
  const tool = CLI_TOOLS[id]
  if (!tool) throw new Error(`unknown CLI tool: ${id}`)
  return tool
}

function firstLine(value = '') {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || ''
}

function runFixedCommand(command, timeoutMs) {
  return new Promise((resolve) => {
    const shell = process.platform === 'win32'
      ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
      : { file: '/bin/sh', args: ['-lc', command] }
    const child = spawn(shell.file, shell.args, {
      windowsHide: true,
      env: process.env,
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
