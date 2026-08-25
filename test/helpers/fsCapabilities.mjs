import { symlinkSync } from 'node:fs'

export function symlinkOrSkip(t, target, link, type) {
  try {
    symlinkSync(target, link, type)
    return true
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) {
      t.skip(`Windows ${type} capability unavailable`)
      return false
    }
    throw error
  }
}
