const DEFAULT_INTERVAL_MS = 10_000

export function createDshStatsPoller({
  entries,
  dshClient,
  onStats,
  intervalMs = DEFAULT_INTERVAL_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  let timer = null
  let running = false

  async function tick() {
    for (const [sessionId, entry] of entries()) {
      if (entry?.session?.adapterId !== 'deepseek-harness') continue
      const url = entry?.surfaceState?.url
      if (typeof url !== 'string' || !url) continue
      let tokens
      try {
        tokens = await dshClient.aggregateTokenUsage(url)
      } catch {
        continue
      }
      if (!tokens) continue
      try {
        await onStats(sessionId, tokens)
      } catch { /* observer failure must not break the loop */ }
    }
  }

  function start() {
    if (running) return
    running = true
    const loop = async () => {
      if (!running) return
      await tick()
      if (!running) return
      timer = setTimer(loop, intervalMs)
    }
    timer = setTimer(loop, intervalMs)
  }

  function stop() {
    running = false
    if (timer !== null) clearTimer(timer)
    timer = null
  }

  return { tick, start, stop }
}
