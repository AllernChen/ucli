import { watch } from 'fs'

/** Watch only provider identity in a Codex home directory. The watcher never
 * reads or publishes raw TOML, so credentials remain in the main process. */
export function createCodexConfigWatcher({
  readSnapshot,
  watchDirectory = (directory, onChange) => watch(directory, { persistent: false }, onChange),
  debounceMs = 150,
  onChange = () => {}
} = {}) {
  let handle = null
  let timer = null
  let snapshot = null
  let revision = 0
  let pendingForce = false

  function refresh({ force = false } = {}) {
    const next = readSnapshot(snapshot?.codexHome)
    const changed = force || !sameIdentity(snapshot, next)
    if (changed) revision += 1
    snapshot = { ...next, revision }
    if (changed) onChange(snapshot)
    return snapshot
  }

  function scheduleRefresh(force = false) {
    pendingForce ||= force
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      const forceRefresh = pendingForce
      pendingForce = false
      refresh({ force: forceRefresh })
    }, debounceMs)
    timer.unref?.()
  }

  return {
    start(codexHome) {
      this.stop()
      revision = 0
      snapshot = { ...readSnapshot(codexHome), revision }
      try {
        handle = watchDirectory(snapshot.codexHome, (_eventType, filename) => {
          const name = filename ? String(filename).toLowerCase() : ''
          if (!name || name === 'config.toml') scheduleRefresh()
          else if (/^ucli-[a-f0-9]{32}\.config\.toml$/.test(name)) scheduleRefresh(true)
        })
      } catch {
        handle = null
      }
      return snapshot
    },
    refresh,
    stop() {
      if (timer) clearTimeout(timer)
      timer = null
      pendingForce = false
      try { handle?.close?.() } catch { /* watcher is already closed */ }
      handle = null
    },
    getSnapshot: () => snapshot
  }
}

function sameIdentity(previous, next) {
  if (!previous || !next) return false
  return previous.mtimeMs === next.mtimeMs &&
    previous.currentProvider === next.currentProvider &&
    JSON.stringify(previous.availableProviders) === JSON.stringify(next.availableProviders) &&
    JSON.stringify(previous.providerCatalog) === JSON.stringify(next.providerCatalog)
}
