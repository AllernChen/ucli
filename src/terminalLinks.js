export function shouldOpenTerminalLink(event) {
  return Boolean(event?.ctrlKey || event?.metaKey)
}
