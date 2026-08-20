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
