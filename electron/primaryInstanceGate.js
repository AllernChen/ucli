export function runPrimaryInstanceGate({ acquireLock, quit, bootstrap, onSecondInstance } = {}) {
  if (!acquireLock()) {
    quit()
    return false
  }
  onSecondInstance()
  bootstrap()
  return true
}
