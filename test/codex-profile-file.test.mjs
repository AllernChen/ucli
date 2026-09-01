import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import {
  codexNativeProfileName,
  cleanStaleServerCodexProfileFiles,
  inspectCodexProfileFile,
  removeCodexProfileFile,
  renderCodexProfileFile,
  renderServerCodexProfileFile,
  resolveCodexProfilePath,
  resolveServerCodexProfilePath,
  serverCodexNativeProfileName,
  writeServerCodexProfileFileAtomic,
  writeCodexProfileFileAtomic
} from '../electron/aiCliProfiles/codexProfileFile.js'

const PROFILE_ID = '550e8400-e29b-41d4-a716-446655440000'
const NATIVE_PROFILE = 'ucli-550e8400e29b41d4a716446655440000'

function managedProfile(overrides = {}) {
  return {
    id: PROFILE_ID,
    adapterId: 'codex',
    name: 'Company Gateway',
    kind: 'managed',
    providerId: 'ucli_550e8400e29b',
    baseUrl: 'https://gateway.example.com/v1',
    model: 'gpt-5.4',
    reasoningEffort: 'high',
    contextWindow: 400000,
    ...overrides
  }
}

function withCodexHome(work) {
  const root = mkdtempSync(join(tmpdir(), 'ucli-codex-profile-'))
  try {
    return work(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('managed Codex profiles render the reviewed fixture without secret values', () => {
  const fixture = readFileSync(
    new URL('./fixtures/codex-profiles/ucli-managed.config.toml', import.meta.url),
    'utf8'
  ).replace(/\r\n/g, '\n')
  const rendered = renderCodexProfileFile({
    ...managedProfile(),
    secret: 'sk-must-not-be-rendered'
  })

  assert.equal(rendered, fixture)
  assert.equal(rendered.includes('sk-must-not-be-rendered'), false)
  assert.equal(rendered.includes('api_key'), false)
  assert.equal(rendered.includes('experimental_bearer_token'), false)
})

test('reference Codex profiles contain no provider definition and omit empty fields', () => {
  const rendered = renderCodexProfileFile({
    id: PROFILE_ID,
    adapterId: 'codex',
    name: 'Existing Provider',
    kind: 'reference',
    providerId: 'work_gateway',
    baseUrl: 'https://must-not-be-copied.example.com',
    model: null,
    reasoningEffort: null,
    contextWindow: null
  })

  assert.equal(rendered, [
    `# ucli-profile-id: ${PROFILE_ID}`,
    'model_provider = "work_gateway"',
    ''
  ].join('\n'))
  assert.equal(rendered.includes('model_providers'), false)
  assert.equal(rendered.includes('base_url'), false)
  assert.equal(rendered.includes('model ='), false)
})

test('server Codex profiles target the fixed loopback v1 API prefix', () => {
  const rendered = renderServerCodexProfileFile({
    id: '0123456789abcdef0123456789abcdef',
    name: 'Responses',
    model: 'responses-a',
    contextWindow: 128000
  }, {
    baseUrl: 'http://127.0.0.1:43123'
  })

  assert.match(rendered, /base_url = "http:\/\/127\.0\.0\.1:43123\/v1"/)
  assert.doesNotMatch(rendered, /base_url = "http:\/\/127\.0\.0\.1:43123"\n/)
})

test('Codex profile paths are deterministic and reject names outside the UCLI namespace', () => {
  assert.equal(codexNativeProfileName(PROFILE_ID), NATIVE_PROFILE)
  withCodexHome((codexHome) => {
    const path = resolveCodexProfilePath(codexHome, NATIVE_PROFILE)
    assert.equal(basename(path), `${NATIVE_PROFILE}.config.toml`)
    assert.throws(
      () => resolveCodexProfilePath(codexHome, '../config'),
      { code: 'INVALID_NATIVE_PROFILE_NAME' }
    )
    assert.throws(
      () => resolveCodexProfilePath(codexHome, 'default'),
      { code: 'INVALID_NATIVE_PROFILE_NAME' }
    )
  })
})

test('profile inspection maps missing and oversized files to stable errors', () => {
  withCodexHome((codexHome) => {
    const path = resolveCodexProfilePath(codexHome, NATIVE_PROFILE)
    assert.throws(
      () => inspectCodexProfileFile(path),
      { code: 'PROFILE_FILE_MISSING' }
    )

    writeFileSync(path, `# ucli-profile-id: ${PROFILE_ID}\n# ${'x'.repeat(1024 * 1024)}\n`)
    assert.throws(
      () => inspectCodexProfileFile(path),
      { code: 'PROFILE_FILE_TOO_LARGE' }
    )
  })
})

test('atomic profile writes can be inspected and leave no temporary files', () => {
  withCodexHome((codexHome) => {
    const result = writeCodexProfileFileAtomic({
      codexHome,
      profile: managedProfile(),
      expectedSha256: null
    })

    assert.equal(existsSync(result.path), true)
    assert.equal(result.path, resolveCodexProfilePath(codexHome, NATIVE_PROFILE))
    assert.equal(result.sha256.length, 64)
    assert.deepEqual(inspectCodexProfileFile(result.path), {
      profileId: PROFILE_ID,
      sha256: result.sha256,
      config: {
        model: 'gpt-5.4',
        model_reasoning_effort: 'high',
        model_context_window: 400000,
        model_provider: 'ucli_550e8400e29b',
        model_providers: {
          ucli_550e8400e29b: {
            name: 'Company Gateway',
            base_url: 'https://gateway.example.com/v1',
            env_key: 'UCLI_CODEX_PROFILE_550E8400_E29B_41D4_A716_446655440000',
            wire_api: 'responses',
            requires_openai_auth: false
          }
        }
      }
    })
    assert.deepEqual(
      readdirSync(codexHome).filter((name) => name.includes('.tmp-')),
      []
    )
  })
})

test('atomic profile writes replace a matching owned revision', () => {
  withCodexHome((codexHome) => {
    const created = writeCodexProfileFileAtomic({
      codexHome,
      profile: managedProfile(),
      expectedSha256: null
    })
    const updated = writeCodexProfileFileAtomic({
      codexHome,
      profile: managedProfile({ model: 'gpt-5.5' }),
      expectedSha256: created.sha256
    })

    assert.notEqual(updated.sha256, created.sha256)
    assert.equal(inspectCodexProfileFile(updated.path).config.model, 'gpt-5.5')
    assert.deepEqual(readdirSync(codexHome), [`${NATIVE_PROFILE}.config.toml`])
  })
})

test('compare-and-swap rejects external edits and files UCLI does not own', () => {
  withCodexHome((codexHome) => {
    const created = writeCodexProfileFileAtomic({
      codexHome,
      profile: managedProfile(),
      expectedSha256: null
    })
    writeFileSync(created.path, `${readFileSync(created.path, 'utf8')}# external edit\n`)

    assert.throws(
      () => writeCodexProfileFileAtomic({
        codexHome,
        profile: managedProfile({ model: 'gpt-5.5' }),
        expectedSha256: created.sha256
      }),
      { code: 'PROFILE_FILE_DRIFTED' }
    )

    writeFileSync(created.path, '# not owned by ucli\nmodel = "gpt-5"\n')
    assert.throws(
      () => inspectCodexProfileFile(created.path),
      { code: 'PROFILE_FILE_NOT_OWNED' }
    )
  })
})

test('profile writes reject symbolic-link targets', (t) => {
  withCodexHome((codexHome) => {
    const outside = join(codexHome, 'outside.config.toml')
    writeFileSync(outside, '# external file\n')
    const target = resolveCodexProfilePath(codexHome, NATIVE_PROFILE)
    try {
      symlinkSync(outside, target, 'file')
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
        t.skip('Creating symbolic links requires Windows developer mode or elevation')
        return
      }
      throw error
    }

    assert.throws(
      () => writeCodexProfileFileAtomic({
        codexHome,
        profile: managedProfile(),
        expectedSha256: null
      }),
      { code: 'PROFILE_FILE_NOT_OWNED' }
    )
  })
})

test('profile removal requires matching ownership and expected hash', () => {
  withCodexHome((codexHome) => {
    const created = writeCodexProfileFileAtomic({
      codexHome,
      profile: managedProfile(),
      expectedSha256: null
    })

    assert.throws(
      () => removeCodexProfileFile({
        codexHome,
        profile: managedProfile(),
        expectedSha256: '0'.repeat(64)
      }),
      { code: 'PROFILE_FILE_DRIFTED' }
    )
    assert.equal(existsSync(created.path), true)

    assert.equal(removeCodexProfileFile({
      codexHome,
      profile: managedProfile(),
      expectedSha256: created.sha256
    }), true)
    assert.equal(existsSync(created.path), false)
    assert.equal(removeCodexProfileFile({
      codexHome,
      profile: managedProfile(),
      expectedSha256: created.sha256
    }), false)
  })
})

test('stale server Codex cleanup removes only owned files absent from the artifact set', () => {
  withCodexHome((codexHome) => {
    const retainedId = '0123456789abcdef0123456789abcdef'
    const staleId = 'fedcba9876543210fedcba9876543210'
    const retained = writeServerCodexProfileFileAtomic({
      codexHome,
      profile: { id: retainedId, name: 'Retained', model: 'responses-a', contextWindow: 128000 },
      baseUrl: 'http://127.0.0.1:43123'
    })
    const stale = writeServerCodexProfileFileAtomic({
      codexHome,
      profile: { id: staleId, name: 'Stale', model: 'responses-b', contextWindow: 128000 },
      baseUrl: 'http://127.0.0.1:43123'
    })
    const malformed = resolveServerCodexProfilePath(codexHome, serverCodexNativeProfileName('11111111111111111111111111111111'))
    writeFileSync(malformed, '# external file\n')
    writeFileSync(join(codexHome, 'unrelated.config.toml'), '# preserve\n')

    assert.equal(cleanStaleServerCodexProfileFiles({
      codexHome,
      validArtifactIds: new Set([retainedId])
    }), 1)
    assert.equal(existsSync(retained.path), true)
    assert.equal(existsSync(stale.path), false)
    assert.equal(existsSync(malformed), true)
    assert.equal(existsSync(join(codexHome, 'unrelated.config.toml')), true)
  })
})
