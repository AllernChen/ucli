function executorError(code, message) {
  return Object.assign(new Error(message), { code })
}

export function mapBounded(items, concurrency, worker, { signal, onSettled } = {}) {
  if (!Array.isArray(items) || typeof worker !== 'function') {
    return Promise.reject(new TypeError('items and worker are required'))
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) {
    return Promise.reject(executorError(
      'SUMMARY_MAP_CONCURRENCY_INVALID',
      'Map concurrency must be between 1 and 3'
    ))
  }
  if (signal?.aborted) {
    return Promise.reject(executorError('SUMMARY_PIPELINE_ABORTED', 'Summary generation was aborted'))
  }
  if (items.length === 0) return Promise.resolve([])

  return new Promise((resolve, reject) => {
    const results = new Array(items.length)
    let nextIndex = 0
    let active = 0
    let settled = 0
    let firstError = null

    const abortError = () => executorError(
      'SUMMARY_PIPELINE_ABORTED',
      'Summary generation was aborted'
    )
    const onAbort = () => {
      if (!firstError) firstError = abortError()
      finishIfDone()
    }
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    const finishIfDone = () => {
      if (active > 0) return
      if (firstError) {
        cleanup()
        reject(firstError)
        return
      }
      if (settled === items.length) {
        cleanup()
        resolve(results)
      }
    }
    const launch = () => {
      while (!firstError && !signal?.aborted && active < concurrency && nextIndex < items.length) {
        const index = nextIndex
        nextIndex += 1
        active += 1
        Promise.resolve()
          .then(() => worker(items[index], index))
          .then(value => { results[index] = value })
          .catch(error => {
            if (!firstError) firstError = error
          })
          .finally(() => {
            active -= 1
            settled += 1
            try { onSettled?.({ settled, total: items.length, index }) } catch { /* progress only */ }
            if (signal?.aborted && !firstError) firstError = abortError()
            if (!firstError) launch()
            finishIfDone()
          })
      }
      if (signal?.aborted && !firstError) firstError = abortError()
      finishIfDone()
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    launch()
  })
}
