export function isClipboardPasteShortcut(event) {
  return Boolean(
    event?.ctrlKey &&
    (event.key === 'v' || event.key === 'V')
  )
}

// xterm forwards keydown, keypress and keyup through the custom key handler.
// Only the keydown event may read and forward clipboard data to the PTY.
export function shouldSendClipboardPaste(event) {
  return event?.type === 'keydown' && isClipboardPasteShortcut(event)
}
