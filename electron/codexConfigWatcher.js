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

  function refresh() {
    const next = readSnapshot(snapshot?.codexHome)
    const changed = !sameIdentity(snapshot, next)
    snapshot = next
    if (changed) onChange(next)
    return next
  }

  function scheduleRefresh() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      refresh()
    }, debounceMs)
    timer.unref?.()
  }

  return {
    start(codexHome) {
      this.stop()
      snapshot = readSnapshot(codexHome)
      try {
        handle = watchDirectory(snapshot.codexHome, (_eventType, filename) => {
          if (!filename || String(filename).toLowerCase() === 'config.toml') scheduleRefresh()
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
    JSON.stringify(previous.availableProviders) === JSON.stringify(next.availableProviders)
}
