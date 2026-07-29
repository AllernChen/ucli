export function terminalSizeChanged(previous, next) {
  if (
    !Number.isInteger(next?.cols) ||
    !Number.isInteger(next?.rows) ||
    next.cols <= 0 ||
    next.rows <= 0
  ) {
    return false
  }
  return previous?.cols !== next.cols || previous?.rows !== next.rows
}
