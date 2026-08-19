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
// This is also the gate for preventDefault: xterm 6.x fires a native `paste`
// event for the browser's default Ctrl/Cmd+V action when the key handler returns
// false, so the keydown handler must preventDefault to avoid a second paste.
export function shouldSendClipboardPaste(event) {
  return event?.type === 'keydown' && isClipboardPasteShortcut(event)
}

// xterm may emit a keypress after the keydown handler has already forwarded
// clipboard content. Suppress that second Ctrl/Cmd+V path without affecting keyup.
export function shouldBlockDuplicateClipboardPaste(event) {
  return event?.type === 'keypress' && isClipboardPasteShortcut(event)
}
