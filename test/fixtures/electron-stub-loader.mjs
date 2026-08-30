const electronStub = `
export const app = {
  getPath: () => process.env.UCLI_TEST_USER_DATA,
  getAppPath: () => process.cwd(),
  getName: () => 'UCLI Test',
  isPackaged: false,
  getVersion: () => 'test'
}
export const ipcMain = { handle() {}, on() {} }
export const dialog = {}
export const shell = {}
export class Notification {}
export const safeStorage = {}
`

const electronStubUrl = `data:text/javascript,${encodeURIComponent(electronStub)}`

export function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: electronStubUrl, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
