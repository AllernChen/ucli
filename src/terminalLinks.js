export function shouldOpenTerminalLink(event, platform = globalThis.navigator?.platform || '') {
  if (/mac/i.test(platform)) return Boolean(event?.metaKey)
  return Boolean(event?.ctrlKey)
}
