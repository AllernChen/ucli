export function createServerConnectionRegistrationController({ getAttempt, setVisible, navigate } = {}) {
  let visibleAttemptId = null
  return {
    presentCurrentAttempt() {
      const attemptId = getAttempt?.()?.attemptId
      if (typeof attemptId !== 'string' || attemptId === visibleAttemptId) return false
      visibleAttemptId = attemptId
      setVisible?.(true)
      navigate?.({ name: 'settings', query: { section: 'server' } })
      return true
    },
    clear() { visibleAttemptId = null }
  }
}
