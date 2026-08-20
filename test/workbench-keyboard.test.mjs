import assert from 'node:assert/strict'
import test from 'node:test'

import {
  nextSessionPaneIndex,
  targetPaneForSessionAddition
} from '../src/workbenchKeyboard.js'
import {
  reconcileSessionPanes,
  releaseChangedPaneTerminalBinding,
  restoreAssignedPaneSessions,
  resolveSessionFocusPane,
  resolveWorkbenchFullscreenTarget,
  toggleElementFullscreen
} from '../src/workbenchLayout.js'

const panes = [
  { sessionId: 'claude-a' },
  { sessionId: null },
  { sessionId: 'codex-b' },
  { sessionId: 'claude-c' }
]

test('Tab cycles assigned session panes in layout order and wraps', () => {
  assert.equal(nextSessionPaneIndex(panes, 0), 2)
  assert.equal(nextSessionPaneIndex(panes, 2), 3)
  assert.equal(nextSessionPaneIndex(panes, 3), 0)
})

test('Shift+Tab cycles assigned session panes in reverse', () => {
  assert.equal(nextSessionPaneIndex(panes, 0, -1), 3)
  assert.equal(nextSessionPaneIndex(panes, 3, -1), 2)
})

test('a single already-active session leaves Tab to the CLI', () => {
  assert.equal(nextSessionPaneIndex([{ sessionId: 'claude-a' }], 0), null)
  assert.equal(nextSessionPaneIndex([{ sessionId: null }], 0), null)
})

test('session assignment uses an empty pane before expanding the layout', () => {
  assert.deepEqual(targetPaneForSessionAddition([
    { sessionId: 'claude-a' },
    { sessionId: null }
  ], 2), {
    paneIndex: 1,
    splitCount: 2
  })
})

test('session assignment expands a full layout from one to two panes', () => {
  assert.deepEqual(targetPaneForSessionAddition([{ sessionId: 'claude-a' }], 1), {
    paneIndex: -1,
    splitCount: 2
  })
})

test('session assignment expands a full layout from two to four panes', () => {
  assert.deepEqual(targetPaneForSessionAddition([
    { sessionId: 'claude-a' },
    { sessionId: 'codex-b' }
  ], 2), {
    paneIndex: -1,
    splitCount: 4
  })
})

test('session assignment does not expand a full four-pane layout', () => {
  assert.deepEqual(targetPaneForSessionAddition([
    { sessionId: 'a' },
    { sessionId: 'b' },
    { sessionId: 'c' },
    { sessionId: 'd' }
  ], 4), {
    paneIndex: -1,
    splitCount: 4
  })
})

test('changing split count preserves existing terminal pane instances', () => {
  const terminal = { id: 'terminal-a' }
  const current = [
    { id: 'pane-0', sessionId: 'claude-a', term: terminal },
    { id: 'pane-1', sessionId: 'codex-b', term: { id: 'terminal-b' } }
  ]

  const expanded = reconcileSessionPanes(current, 4, (index) => index === 2 ? 'claude-c' : null)
  assert.equal(expanded.panes[0], current[0])
  assert.equal(expanded.panes[1], current[1])
  assert.equal(expanded.panes[0].term, terminal)
  assert.deepEqual(expanded.panes[2], { id: 'pane-2', sessionId: 'claude-c' })
  assert.deepEqual(expanded.removed, [])

  const reduced = reconcileSessionPanes(expanded.panes, 1)
  assert.equal(reduced.panes[0], current[0])
  assert.deepEqual(reduced.removed, expanded.panes.slice(1))
})

test('saved sessions repopulate empty pane instances during workbench restoration', () => {
  const terminal = { id: 'restored-terminal' }
  const restored = reconcileSessionPanes([
    { id: 'pane-0', sessionId: null, term: terminal },
    { id: 'pane-1', sessionId: null }
  ], 2, (index) => ['claude-a', 'codex-b'][index])

  assert.equal(restored.panes[0].sessionId, 'claude-a')
  assert.equal(restored.panes[0].term, terminal)
  assert.equal(restored.panes[1].sessionId, 'codex-b')
})

test('switching a pane session releases the old terminal output binding before replay', () => {
  const calls = []

  assert.equal(releaseChangedPaneTerminalBinding('claude-a', 'codex-b', {
    clearTerminal: () => calls.push('clear'),
    unsubscribe: () => calls.push('unsubscribe')
  }), true)
  assert.deepEqual(calls, ['clear', 'unsubscribe'])

  assert.equal(releaseChangedPaneTerminalBinding('codex-b', 'codex-b', {
    clearTerminal: () => calls.push('unexpected-clear'),
    unsubscribe: () => calls.push('unexpected-unsubscribe')
  }), false)
  assert.deepEqual(calls, ['clear', 'unsubscribe'])
})

test('a fresh renderer reconstructs and activates every saved 1, 2, and 4 pane layout', async () => {
  const fixtures = [
    { splitCount: 1, sessionIds: ['codex-a'] },
    { splitCount: 2, sessionIds: ['codex-a', 'claude-b'] },
    { splitCount: 4, sessionIds: ['codex-a', 'claude-b', 'opencode-c', 'ucode-d'] }
  ]

  for (const { splitCount, sessionIds } of fixtures) {
    const restored = reconcileSessionPanes([], splitCount, (index) => sessionIds[index])
    const activated = []

    await restoreAssignedPaneSessions(
      restored.panes.map((pane, paneIndex) => ({ paneIndex, sessionId: pane.sessionId })),
      {
        getSession: (sessionId) => ({ id: sessionId, status: 'offline', capabilities: TERMINAL_CAPABILITIES }),
        restartSession: async (sessionId, paneIndex) => activated.push({ sessionId, paneIndex }),
        attachSession: async () => {}
      }
    )

    assert.equal(restored.panes.length, splitCount)
    assert.deepEqual(restored.panes.map((pane) => pane.sessionId), sessionIds)
    assert.deepEqual(activated, sessionIds.map((sessionId, paneIndex) => ({ sessionId, paneIndex })))
  }
})

test('restored panes activate in layout order without overlapping session starts', async () => {
  const events = []
  let activeStarts = 0
  let maxActiveStarts = 0
  await restoreAssignedPaneSessions([
    { paneIndex: 1, sessionId: 'codex-a' },
    { paneIndex: 2, sessionId: 'codex-b' }
  ], {
    getSession: (sessionId) => ({ id: sessionId, status: 'offline', capabilities: TERMINAL_CAPABILITIES }),
    restartSession: async (sessionId) => {
      activeStarts += 1
      maxActiveStarts = Math.max(maxActiveStarts, activeStarts)
      events.push(`start:${sessionId}`)
      await new Promise((resolve) => queueMicrotask(resolve))
      events.push(`ready:${sessionId}`)
      activeStarts -= 1
    },
    attachSession: async () => {}
  })

  assert.equal(maxActiveStarts, 1)
  assert.deepEqual(events, [
    'start:codex-a',
    'ready:codex-a',
    'start:codex-b',
    'ready:codex-b'
  ])
})

test('a failed restored pane does not prevent a later pane from activating', async () => {
  const activated = []
  const failures = []
  await restoreAssignedPaneSessions([
    { paneIndex: 0, sessionId: 'broken' },
    { paneIndex: 1, sessionId: 'healthy' }
  ], {
    getSession: (sessionId) => ({ id: sessionId, status: 'offline', capabilities: TERMINAL_CAPABILITIES }),
    restartSession: async (sessionId) => {
      if (sessionId === 'broken') throw new Error('startup failed')
      activated.push(sessionId)
    },
    attachSession: async () => {},
    onError: (error, pane) => failures.push([pane.sessionId, error.message])
  })

  assert.deepEqual(activated, ['healthy'])
  assert.deepEqual(failures, [['broken', 'startup failed']])
})

test('pane fullscreen enters and exits through the document fullscreen API', async () => {
  const pane = {
    async requestFullscreen() {
      documentMock.fullscreenElement = pane
    }
  }
  const documentMock = {
    fullscreenElement: null,
    async exitFullscreen() {
      this.fullscreenElement = null
    }
  }

  assert.equal(await toggleElementFullscreen(documentMock, pane), true)
  assert.equal(documentMock.fullscreenElement, pane)
  assert.equal(await toggleElementFullscreen(documentMock, pane), false)
  assert.equal(documentMock.fullscreenElement, null)
})

test('fullscreen target distinguishes the entire split grid from a single pane', () => {
  const grid = { id: 'grid' }
  const pane0 = { id: 'pane-0' }
  const pane1 = { id: 'pane-1' }
  const paneRoots = { 0: pane0, 1: pane1 }

  assert.deepEqual(resolveWorkbenchFullscreenTarget(grid, grid, paneRoots), {
    grid: true,
    paneIndex: null
  })
  assert.deepEqual(resolveWorkbenchFullscreenTarget(pane1, grid, paneRoots), {
    grid: false,
    paneIndex: 1
  })
  assert.deepEqual(resolveWorkbenchFullscreenTarget(null, grid, paneRoots), {
    grid: false,
    paneIndex: null
  })
})

test('notification focus uses the existing session pane before an empty pane', () => {
  assert.equal(resolveSessionFocusPane(panes, 'codex-b', 0), 2)
  assert.equal(resolveSessionFocusPane(panes, 'new-session', 2), 1)
  assert.equal(resolveSessionFocusPane([
    { sessionId: 'a' },
    { sessionId: 'b' }
  ], 'new-session', 1), 1)
})
const TERMINAL_CAPABILITIES = Object.freeze({
  surface: 'terminal', permissionOwner: 'ucli', historyOwner: 'ucli',
  statsOwner: 'ucli', gateway: true, bridge: false
})
