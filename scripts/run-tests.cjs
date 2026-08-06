const { spawnSync } = require('node:child_process')
const { readdirSync } = require('node:fs')
const { resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')
const packageJson = require(resolve(projectRoot, 'package.json'))
const pretestFiles = new Set(
  String(packageJson.scripts.pretest || '').match(/test\/[^\s"]+\.test\.mjs/g) || []
)

const testFiles = readdirSync(resolve(projectRoot, 'test'))
  .filter((name) => name.endsWith('.test.mjs'))
  .map((name) => `test/${name}`)
  .filter((name) => !pretestFiles.has(name))
  .sort()

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  cwd: projectRoot,
  stdio: 'inherit'
})

if (result.error) throw result.error
process.exitCode = result.status ?? 1
