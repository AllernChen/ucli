export function runPrimaryInstanceGate({ acquireLock, quit, bootstrap, onSecondInstance, handleSecondInstance } = {}) {
  if (!acquireLock()) {
    quit()
    return false
  }
  onSecondInstance(({ argv, workingDirectory } = {}) => {
    handleSecondInstance?.({ argv, workingDirectory })
  })
  bootstrap()
  return true
}
