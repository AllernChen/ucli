export function isClipboardPasteShortcut(event) {
  return Boolean(
    (event?.ctrlKey || event?.metaKey) &&
    (event.key === 'v' || event.key === 'V')
  )
}

export function isClipboardCopyShortcut(event) {
  return Boolean(
    event?.metaKey &&
    !event.altKey &&
    (event.key === 'c' || event.key === 'C')
  )
}

export function shouldHandleTerminalPaste(event, bindingMatches) {
  return Boolean(bindingMatches || isClipboardPasteShortcut(event))
}

// xterm forwards keydown, keypress and keyup through the custom key handler.
// Only the keydown event may read and forward clipboard data to the PTY.
export function shouldSendClipboardPaste(event) {
  return event?.type === 'keydown' && isClipboardPasteShortcut(event)
}

// xterm may emit a keypress after the keydown handler has already forwarded
// clipboard content. Suppress that second Ctrl/Cmd+V path without affecting keyup.
export function shouldBlockDuplicateClipboardPaste(event) {
  return event?.type === 'keypress' && isClipboardPasteShortcut(event)
}
