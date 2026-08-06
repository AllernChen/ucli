import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import * as codexProfileFiles from '../electron/aiCliProfiles/codexProfileFile.js'
import { ProfileSecretStore } from '../electron/aiCliProfiles/profileSecretStore.js'
import { createProfileService } from '../electron/aiCliProfiles/profileService.js'
import { openDb } from '../electron/persistence/db.js'

const IDS = [
  '110e8400-e29b-41d4-a716-446655440000',
  '220e8400-e29b-41d4-a716-446655440000',
  '330e8400-e29b-41d4-a716-446655440000'
]

function safeStorage() {
  return {
    decryptCount: 0,
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString(value) {
      this.decryptCount += 1
      return value.toString('utf8').replace(/^encrypted:/, '')
    }
  }
}

async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'ucli-claude-profile-service-'))
  const codexHome = join(root, '.codex')
  mkdirSync(codexHome)
  const db = await openDb(join(root, 'ucli.db'))
  const storage = safeStorage()
  const secretStore = new ProfileSecretStore({ db, safeStorage: storage, now: () => 100 })
  let idIndex = 0
  const service = createProfileService({
    db,
    secretStore,
    resolveCodexHome: () => codexHome,
    readCodexRuntime: () => ({ availableProviders: ['openai'] }),
    readClaudeRuntime: () => ({ inheritedAuthMode: 'login_or_unknown' }),
    fileOps: codexProfileFiles,
    uuid: () => IDS[idIndex++],
    now: () => 100 + idIndex,
    flush: () => db.flush()
  })
  return {
    root,
    db,
    secretStore,
    storage,
    service,
    close() {
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

test('Claude profile stores sanitized config and encrypted secret without a native artifact', async () => {
  const context = await harness()
  try {
    const created = await context.service.createProfile({
      adapterId: 'claude',
      name: 'Company Claude',
      connectionMode: 'api_key',
      baseUrl: 'https://gateway.example.com',
      model: 'claude-sonnet-5',
      secret: 'secret-value',
      env: { ANTHROPIC_API_KEY: 'forged-value' },
      settings: { apiKeyHelper: 'forged-value' }
    })

    assert.equal(created.adapterId, 'claude')
    assert.equal(created.hasSecret, true)
    assert.deepEqual(created.config, {
      connectionMode: 'api_key',
      baseUrl: 'https://gateway.example.com'
    })
    const stored = context.db.getAiCliProfile(created.id)
    assert.equal(stored.nativeProfileName, null)
    assert.equal(stored.fileSha256, null)
    assert.deepEqual(stored.config, created.config)
    assert.equal(JSON.stringify(context.db.listAiCliProfiles()).includes('secret-value'), false)
    assert.equal(JSON.stringify(context.db.listAiCliProfiles()).includes('forged-value'), false)
  } finally {
    context.close()
  }
})

test('Claude launch decrypts once and keeps the credential in the target environment only', async () => {
  const context = await harness()
  try {
    const created = await context.service.createProfile({
      adapterId: 'claude',
      name: 'Company Claude',
      connectionMode: 'bearer',
      baseUrl: 'https://gateway.example.com',
      model: 'sonnet',
      secret: 'bearer-secret'
    })
    const decryptsBeforeLaunch = context.storage.decryptCount
    const launch = context.service.resolveLaunchProfile({
      profileId: created.id,
      session: { cliSessionId: 'native-session', model: 'haiku' },
      baseEnv: { PATH: 'C:\\tools', ANTHROPIC_API_KEY: 'old-key' }
    })

    assert.deepEqual(launch.args, ['--model', 'sonnet', '--resume', 'native-session'])
    assert.equal(launch.env.ANTHROPIC_AUTH_TOKEN, 'bearer-secret')
    assert.equal(launch.env.ANTHROPIC_API_KEY, undefined)
    assert.equal(launch.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, '1')
    assert.equal(context.storage.decryptCount - decryptsBeforeLaunch, 1)
    assert.equal(JSON.stringify(context.service.listProfiles({ adapterId: 'claude' })).includes('bearer-secret'), false)
  } finally {
    context.close()
  }
})

test('Claude subscription profile starts without a secret and reports managed secret loss', async () => {
  const context = await harness()
  try {
    const subscription = await context.service.createProfile({
      adapterId: 'claude',
      name: 'Claude Login',
      connectionMode: 'subscription',
      model: 'sonnet'
    })
    assert.equal(subscription.status, 'ready')
    assert.equal(subscription.canStart, true)

    const managed = await context.service.createProfile({
      adapterId: 'claude',
      name: 'Temporary API',
      connectionMode: 'api_key',
      model: 'haiku',
      secret: 'temporary-secret'
    })
    await context.service.deleteProfileSecret(managed.id)
    const missing = context.service.listProfiles({ adapterId: 'claude' })
      .find((profile) => profile.id === managed.id)
    assert.equal(missing.status, 'secret_unavailable')
    assert.equal(missing.canStart, false)
  } finally {
    context.close()
  }
})

test('Claude profile selection uses explicit, project, app, then system while imports stay on history', async () => {
  const context = await harness()
  try {
    const app = await context.service.createProfile({
      adapterId: 'claude', name: 'App Login', connectionMode: 'subscription'
    })
    const project = await context.service.createProfile({
      adapterId: 'claude', name: 'Project Login', connectionMode: 'subscription'
    })
    await context.service.setBinding({
      scopeType: 'app', scopeKey: '*', adapterId: 'claude', profileId: app.id
    })
    await context.service.setBinding({
      scopeType: 'project', scopeKey: 'F:\\projects\\demo', adapterId: 'claude', profileId: project.id
    })

    assert.equal(context.service.resolveSessionProfile({
      adapterId: 'claude', cwd: 'F:\\projects\\demo', explicitProfileId: app.id
    }).profileId, app.id)
    assert.equal(context.service.resolveSessionProfile({
      adapterId: 'claude', cwd: 'F:\\projects\\demo'
    }).profileId, project.id)
    assert.equal(context.service.resolveSessionProfile({
      adapterId: 'claude', cwd: 'F:\\projects\\other'
    }).profileId, app.id)
    assert.equal(context.service.resolveSessionProfile({
      adapterId: 'claude', cwd: 'F:\\projects\\demo', imported: true
    }).selectionSource, 'history')
  } finally {
    context.close()
  }
})

test('Claude diagnostics expose aggregate connection health without routing or credentials', async () => {
  const context = await harness()
  try {
    const subscription = await context.service.createProfile({
      adapterId: 'claude', name: 'Login', connectionMode: 'subscription'
    })
    const apiKey = await context.service.createProfile({
      adapterId: 'claude', name: 'API', connectionMode: 'api_key',
      baseUrl: 'https://private.example.com', secret: 'api-secret'
    })
    await context.service.createProfile({
      adapterId: 'claude', name: 'Bearer', connectionMode: 'bearer',
      baseUrl: 'https://gateway.example.com', secret: 'bearer-secret'
    })
    await context.service.deleteProfileSecret(apiKey.id)

    const summary = context.service.getDiagnosticSummary()
    assert.deepEqual(summary.claude, {
      total: 3,
      connectionModes: { subscription: 1, apiKey: 1, bearer: 1 },
      missingSecret: 1,
      modelSubstitutions: 0
    })
    assert.equal(summary.total, 3)
    assert.equal(summary.ready, 2)
    assert.equal(summary.missing, 1)
    assert.equal(context.service.listProfiles({ adapterId: 'claude' }).find((profile) => profile.id === subscription.id).connectionMode, 'subscription')
    assert.doesNotMatch(JSON.stringify(summary), /private\.example|gateway\.example|api-secret|bearer-secret|ANTHROPIC_/)
  } finally {
    context.close()
  }
})
