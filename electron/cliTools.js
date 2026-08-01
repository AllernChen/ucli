import { spawn } from 'child_process'
import { homedir } from 'os'
import { delimiter, join } from 'path'

const UCODE_RELEASE_DOWNLOAD = 'https://github.com/AllernChen/U-Code/releases/latest/download'

export function buildUCodeInstallCommand(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`
  if (target === 'win32-x64') {
    const url = `${UCODE_RELEASE_DOWNLOAD}/ucode-windows-x64.zip`
    return `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $url='${url}'; $bin=Join-Path $env:USERPROFILE '.ucode\\bin'; $tmp=Join-Path ([IO.Path]::GetTempPath()) ('ucode-'+[guid]::NewGuid().ToString('N')); [void](New-Item -ItemType Directory -Force -Path $tmp); [void](New-Item -ItemType Directory -Force -Path $bin); try { $zip=Join-Path $tmp 'ucode.zip'; Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip; Expand-Archive -Path $zip -DestinationPath $tmp -Force; $source=Join-Path $tmp 'ucode.exe'; if (!(Test-Path -LiteralPath $source)) { throw 'ucode.exe was not found in the GitHub Release asset' }; Copy-Item -LiteralPath $source -Destination (Join-Path $bin 'ucode.exe') -Force; $userPath=[Environment]::GetEnvironmentVariable('Path','User'); if (($userPath -split ';') -notcontains $bin) { [Environment]::SetEnvironmentVariable('Path',($bin+';'+$userPath),'User') }; Write-Output ('Installed U-Code from '+$url) } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }"`
  }
  if (target === 'darwin-arm64') {
    const url = `${UCODE_RELEASE_DOWNLOAD}/ucode-darwin-arm64.zip`
    return `tmp="$(mktemp -d)" && trap 'rm -rf "$tmp"' 0 && curl -fL '${url}' -o "$tmp/ucode.zip" && ditto -x -k "$tmp/ucode.zip" "$tmp" && mkdir -p "$HOME/.ucode/bin" && install -m 755 "$tmp/ucode" "$HOME/.ucode/bin/ucode"`
  }
  if (target === 'linux-x64') {
    const url = `${UCODE_RELEASE_DOWNLOAD}/ucode-linux-x64.tar.gz`
    return `tmp="$(mktemp -d)" && trap 'rm -rf "$tmp"' 0 && curl -fL '${url}' -o "$tmp/ucode.tar.gz" && tar -xzf "$tmp/ucode.tar.gz" -C "$tmp" && mkdir -p "$HOME/.ucode/bin" && install -m 755 "$tmp/ucode" "$HOME/.ucode/bin/ucode"`
  }
  throw new Error(`U-Code does not publish a GitHub Release asset for ${target}`)
}

function currentUCodeInstallCommand() {
  try {
    return buildUCodeInstallCommand()
  } catch (error) {
    const message = String(error?.message || error).replaceAll("'", "''")
    return process.platform === 'win32'
      ? `powershell.exe -NoProfile -NonInteractive -Command "Write-Error '${message}'; exit 1"`
      : `printf '%s\\n' '${message}' >&2; exit 1`
  }
}

const UCODE_INSTALL_COMMAND = currentUCodeInstallCommand()

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
  },
  ucode: {
    id: 'ucode',
    displayName: 'U-Code',
    executable: 'ucode',
    installCommand: UCODE_INSTALL_COMMAND,
    upgradeCommand: UCODE_INSTALL_COMMAND
  }
}
export function listCliToolDefinitions() {
  return Object.values(CLI_TOOLS).map((tool) => ({ ...tool }))
}

export async function inspectCliTool(id, runner = runFixedCommand) {
  const tool = requireTool(id)
  if (id === 'ucode') prependUCodeInstallDirToPath()
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
  if (id === 'ucode' && result.code === 0) prependUCodeInstallDirToPath()
  return {
    ok: result.code === 0,
    command,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    status: await inspectCliTool(id, runner)
  }
}

function prependUCodeInstallDirToPath() {
  const installDir = join(homedir(), '.ucode', 'bin')
  const paths = String(process.env.PATH || '').split(delimiter).filter(Boolean)
  if (!paths.includes(installDir)) process.env.PATH = [installDir, ...paths].join(delimiter)
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
