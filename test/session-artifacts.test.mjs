import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseClaudeArtifactPaths,
  parseCodexArtifactPaths,
  parseOpenCodeArtifactPaths,
  artifactKindFromPath,
  imageMimeTypeFromPath,
  assertInsideDirectory,
  resolveArtifactAbsolutePath
} from '../electron/sessionArtifacts.js'
import { createSessionArtifactsService } from '../electron/sessionArtifactsService.js'

test('parseClaudeArtifactPaths extracts tool_use file_path and ignores non-file tools', () => {
  const records = [{
    message: { content: [
      { type: 'tool_use', name: 'Write', input: { file_path: 'a.md' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_use', name: 'Edit', input: { path: 'b.txt' } },
      { type: 'text', text: 'hi' }
    ] }
  }]
  assert.deepEqual(parseClaudeArtifactPaths(records), ['a.md', 'b.txt'])
})

test('parseCodexArtifactPaths parses JSON-string arguments on function_call', () => {
  const records = [
    { type: 'response_item', payload: { type: 'function_call', name: 'write_file', arguments: JSON.stringify({ file_path: 'c.py' }) } },
    { type: 'response_item', payload: { type: 'function_call', name: 'bash', arguments: JSON.stringify({ command: 'ls' }) } },
    { type: 'event_msg', payload: { type: 'task_started' } }
  ]
  assert.deepEqual(parseCodexArtifactPaths(records), ['c.py'])
})

test('parseOpenCodeArtifactPaths reads camelCase filePath and snake_case file_path', () => {
  const source = { messages: [
    { parts: [{ type: 'tool', tool: 'write', state: { input: { filePath: 'x.md' } } }] },
    { parts: [{ type: 'tool', tool: { name: 'edit' }, state: { input: { file_path: 'y.css' } } }] },
    { parts: [{ type: 'text' }] }
  ] }
  assert.deepEqual(parseOpenCodeArtifactPaths(source), ['x.md', 'y.css'])
})

test('artifactKindFromPath maps extensions', () => {
  assert.equal(artifactKindFromPath('x.md'), 'markdown')
  assert.equal(artifactKindFromPath('x.markdown'), 'markdown')
  assert.equal(artifactKindFromPath('x.html'), 'html')
  assert.equal(artifactKindFromPath('x.png'), 'image')
  assert.equal(artifactKindFromPath('x.jpg'), 'image')
  assert.equal(artifactKindFromPath('x.txt'), 'text')
  assert.equal(artifactKindFromPath('x.unknown'), 'text')
})

test('imageMimeTypeFromPath returns mime or null', () => {
  assert.equal(imageMimeTypeFromPath('a.png'), 'image/png')
  assert.equal(imageMimeTypeFromPath('a.jpeg'), 'image/jpeg')
  assert.equal(imageMimeTypeFromPath('a.svg'), 'image/svg+xml')
  assert.equal(imageMimeTypeFromPath('a.txt'), null)
})

test('assertInsideDirectory accepts children and rejects traversal', () => {
  assert.equal(assertInsideDirectory('C:/proj', 'C:/proj/a.md'), 'C:\\proj\\a.md')
  assert.throws(
    () => assertInsideDirectory('C:/proj', 'C:/proj/../etc/passwd'),
    { code: 'ARTIFACT_PATH_UNSAFE' }
  )
  assert.throws(
    () => assertInsideDirectory('C:/proj', 'C:/etc/passwd'),
    { code: 'ARTIFACT_PATH_UNSAFE' }
  )
})

test('resolveArtifactAbsolutePath handles win32/posix/relative/none', () => {
  assert.equal(resolveArtifactAbsolutePath('C:\\proj\\a.md', 'C:\\proj'), 'C:\\proj\\a.md')
  assert.equal(resolveArtifactAbsolutePath('/home/u/a.md', '/home/u'), '/home/u/a.md')
  assert.equal(resolveArtifactAbsolutePath('rel.md', 'C:\\proj'), 'C:\\proj\\rel.md')
  assert.equal(resolveArtifactAbsolutePath('rel.md', '/home/u'), '/home/u/rel.md')
  assert.equal(resolveArtifactAbsolutePath('rel.md', ''), null)
})

test('assertInsideDirectory rejects non-absolute and non-string inputs', () => {
  assert.throws(() => assertInsideDirectory('C:/proj', 'a.md'), { code: 'ARTIFACT_PATH_UNSAFE' })
  assert.throws(() => assertInsideDirectory('proj', 'C:/proj/a.md'), { code: 'ARTIFACT_PATH_UNSAFE' })
  assert.throws(() => assertInsideDirectory('C:/proj', '  '), { code: 'ARTIFACT_PATH_UNSAFE' })
  assert.throws(() => assertInsideDirectory('C:/proj', 42), { code: 'ARTIFACT_PATH_UNSAFE' })
})

test('resolveArtifactAbsolutePath returns null for empty value', () => {
  assert.equal(resolveArtifactAbsolutePath('', 'C:/proj'), null)
})

test('listArtifacts filters non-files, dedupes, and marks deepseek-harness missing', async () => {
  const claude = createSessionArtifactsService({
    resolveSession: () => ({ adapterId: 'claude', cwd: 'C:\\proj', cliSessionId: 's1' }),
    resolveClaudeTranscript: () => 'C:\\proj\\.claude\\t.jsonl',
    readFile: async () => '',
    parseJsonl: async () => [
      { message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'a.md' } }] } },
      { message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'a.md' } }] } },
      { message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'sub\\dir' } }] } }
    ],
    realpathFile: async (p) => p,
    statFile: async (p) => ({ isFile: () => !p.endsWith('dir'), size: 10, mtimeMs: 1 })
  })
  const result = await claude.listArtifacts('s1')
  assert.equal(result.missing, false)
  assert.equal(result.artifacts.length, 1)
  assert.equal(result.artifacts[0].absolutePath, 'C:\\proj\\a.md')
  assert.equal(result.artifacts[0].name, 'a.md')
  assert.equal(result.artifacts[0].kind, 'markdown')

  const dsh = createSessionArtifactsService({
    resolveSession: () => ({ adapterId: 'deepseek-harness', cwd: 'C:\\proj', cliSessionId: 's2' })
  })
  const dshResult = await dsh.listArtifacts('s2')
  assert.equal(dshResult.missing, true)
  assert.deepEqual(dshResult.artifacts, [])
})

test('listArtifacts caches the OpenCode export across calls', async () => {
  let exportCalls = 0
  const service = createSessionArtifactsService({
    resolveSession: () => ({ adapterId: 'opencode', cwd: 'C:\\proj', cliSessionId: 's1' }),
    exportOpenCode: async () => {
      exportCalls += 1
      return { messages: [{ parts: [{ type: 'tool', tool: 'write', state: { input: { filePath: 'x.txt' } } }] }] }
    },
    realpathFile: async (p) => p,
    statFile: async () => ({ isFile: () => true, size: 10, mtimeMs: 1 }),
    now: () => 0
  })
  const first = await service.listArtifacts('s1')
  const second = await service.listArtifacts('s1')
  assert.equal(exportCalls, 1)
  assert.equal(first.artifacts[0].name, 'x.txt')
  assert.equal(second.artifacts[0].absolutePath, 'C:\\proj\\x.txt')
})

test('readArtifact rejects symlink escaping cwd', async () => {
  const service = createSessionArtifactsService({
    resolveSession: () => ({ adapterId: 'claude', cwd: 'C:\\proj', cliSessionId: 's1' }),
    realpathFile: async () => 'C:\\etc\\passwd',
    statFile: async () => ({ isFile: () => true, size: 10 }),
    readFile: async () => 'secret'
  })
  await assert.rejects(
    () => service.readArtifact('s1', 'C:\\proj\\link', { kind: 'text' }),
    { code: 'ARTIFACT_PATH_UNSAFE' }
  )
})

test('readArtifact rejects oversized files', async () => {
  const service = createSessionArtifactsService({
    resolveSession: () => ({ adapterId: 'claude', cwd: 'C:\\proj', cliSessionId: 's1' }),
    realpathFile: async (p) => p,
    statFile: async () => ({ isFile: () => true, size: 11 * 1024 * 1024 })
  })
  await assert.rejects(
    () => service.readArtifact('s1', 'C:\\proj\\big.txt', { kind: 'text' }),
    { code: 'ARTIFACT_TOO_LARGE' }
  )
})

test('readArtifact returns text for markdown and base64 for images', async () => {
  const service = createSessionArtifactsService({
    resolveSession: () => ({ adapterId: 'claude', cwd: 'C:\\proj', cliSessionId: 's1' }),
    realpathFile: async (p) => p,
    statFile: async () => ({ isFile: () => true, size: 10 }),
    readFile: async (p, enc) => (enc ? '# hi' : Buffer.from([1, 2, 3]))
  })
  const text = await service.readArtifact('s1', 'C:\\proj\\a.md', { kind: 'markdown' })
  assert.deepEqual(text, { kind: 'markdown', text: '# hi', truncated: false })
  const image = await service.readArtifact('s1', 'C:\\proj\\a.png', { kind: 'image' })
  assert.equal(image.kind, 'image')
  assert.equal(image.base64, Buffer.from([1, 2, 3]).toString('base64'))
  assert.equal(image.mimeType, 'image/png')
})

test('readArtifact throws ARTIFACT_SESSION_NOT_FOUND for unknown session', async () => {
  const service = createSessionArtifactsService({
    resolveSession: () => null
  })
  await assert.rejects(
    () => service.readArtifact('nope', 'C:\\proj\\a.md', { kind: 'text' }),
    { code: 'ARTIFACT_SESSION_NOT_FOUND' }
  )
})
