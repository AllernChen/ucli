/**
 * Package script: builds a clean production bundle and creates a Windows distributable.
 * Run: node scripts/package.mjs
 */
import { execSync } from 'child_process'
import { cpSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'

const ROOT = resolve(import.meta.dirname, '..')
const BUILD_DIR = join(ROOT, 'dist-packager', 'build')
const OUT_DIR = join(ROOT, 'dist-packager')

console.log('=== UCLI Windows Packager ===\n')

// Clean
if (existsSync(BUILD_DIR)) rmSync(BUILD_DIR, { recursive: true })
mkdirSync(BUILD_DIR, { recursive: true })

// Copy production files
console.log('Copying files...')
cpSync(join(ROOT, 'out'), join(BUILD_DIR, 'out'), { recursive: true })
cpSync(join(ROOT, 'resources'), join(BUILD_DIR, 'resources'), { recursive: true })

// Copy package.json but strip devDependencies
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
delete pkg.devDependencies
delete pkg.scripts
writeFileSync(join(BUILD_DIR, 'package.json'), JSON.stringify(pkg, null, 2))

// Install production dependencies
console.log('Installing production dependencies...')
execSync('npm install --omit=dev --no-audit --no-fund', { cwd: BUILD_DIR, stdio: 'inherit' })

// Use electron-packager
console.log('\nPackaging...')
const ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
execSync(
  `npx @electron/packager "${BUILD_DIR}" UCLI --platform=win32 --arch=x64 --out="${OUT_DIR}" --overwrite --asar --asar-unpack="**/node_modules/node-pty/**"`,
  { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ELECTRON_MIRROR } }
)

// Cleanup build dir
rmSync(BUILD_DIR, { recursive: true, force: true })

console.log('\n=== Done! ===')
console.log(`Output: ${join(OUT_DIR, 'UCLI-win32-x64')}`)
