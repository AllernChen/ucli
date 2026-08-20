<template>
  <div ref="container" class="session-terminal"></div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import ipc from '../ipc.js'
import { shouldOpenTerminalLink } from '../terminalLinks.js'
import { terminalSizeChanged } from '../terminalResize.js'
import {
  isClipboardCopyShortcut,
  shouldBlockDuplicateClipboardPaste,
  shouldHandleTerminalPaste,
  shouldSendClipboardPaste
} from '../terminalKeybindings.js'

// Reusable single-session xterm surface. The owner is responsible for calling
// ipc.startAdapter(sessionId) AFTER this component has mounted — the
// `session:terminal-output` subscription below must be live before the adapter
// boots or early output is lost.
const props = defineProps({ sessionId: { type: String, required: true } })

const container = ref(null)
let term = null
let fitAddon = null
let webLinksAddon = null
let resizeDisposable = null
let resizeObserver = null
let unsubscribe = null
let lastPtySize = { cols: 0, rows: 0 }

function sendSize(nextSize) {
  if (!term || !terminalSizeChanged(lastPtySize, nextSize)) return false
  lastPtySize = { cols: nextSize.cols, rows: nextSize.rows }
  ipc.terminalResize(props.sessionId, nextSize.cols, nextSize.rows).catch(() => {})
  return true
}

function fitTerminal() {
  if (!term || !fitAddon) return
  try { fitAddon.fit() } catch { return }
  return sendSize({ cols: term.cols, rows: term.rows })
}

onMounted(() => {
  if (!container.value) return
  term = new Terminal({
    cursorBlink: true,
    disableStdin: false,
    fontSize: 13,
    fontFamily: "Menlo, Monaco, 'Cascadia Code', Consolas, 'Courier New', monospace",
    allowProposedApi: true,
    scrollback: 5000,
    theme: { background: '#0b1021', foreground: '#d4d4d4', cursor: '#d4d4d4', selectionBackground: '#264f78' }
  })
  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(container.value)

  // Clickable HTTP(S) links open in the default browser after main-process validation.
  webLinksAddon = new WebLinksAddon((event, uri) => {
    if (shouldOpenTerminalLink(event)) ipc.openExternal(uri)
  })
  term.loadAddon(webLinksAddon)

  // Minimal clipboard handling — Ctrl/Cmd+C copies a selection, Ctrl/Cmd+V pastes.
  term.attachCustomKeyEventHandler((event) => {
    if (shouldBlockDuplicateClipboardPaste(event)) return false
    if (event.type !== 'keydown') return true
    const copyShortcut = isClipboardCopyShortcut(event) ||
      (event.ctrlKey && !event.shiftKey && (event.key === 'c' || event.key === 'C'))
    if (copyShortcut) {
      const selection = term.getSelection()
      if (selection) {
        navigator.clipboard.writeText(selection).catch(() => {})
        term.clearSelection()
        return false
      }
      return true
    }
    if (shouldHandleTerminalPaste(event, false)) {
      if (shouldSendClipboardPaste(event)) {
        event.preventDefault()
        event.stopPropagation()
      }
      navigator.clipboard.readText().then(text => {
        if (text) ipc.sendTerminalInput(props.sessionId, text)
      }).catch(() => {})
      return false
    }
    return true
  })

  // Forward user input to the PTY.
  term.onData((data) => {
    ipc.sendTerminalInput(props.sessionId, data)
  })

  // xterm's onResize is the single path that forwards changed dimensions to the PTY.
  resizeDisposable = term.onResize((size) => {
    sendSize({ cols: size.cols, rows: size.rows })
  })
  resizeObserver = new ResizeObserver(() => {
    if (!term) return
    try { fitAddon.fit() } catch {}
  })
  resizeObserver.observe(container.value)

  // Route main-process terminal output into this terminal. Registered on mount,
  // BEFORE the owner calls startAdapter, so early output is not lost.
  unsubscribe = ipc.on('session:terminal-output', (evt) => {
    if (evt.sessionId === props.sessionId && term) term.write(evt.data)
  })

  fitTerminal()
  term.focus()
})

onBeforeUnmount(() => {
  unsubscribe?.()
  webLinksAddon?.dispose()
  resizeDisposable?.dispose()
  resizeObserver?.disconnect()
  if (term) {
    term.dispose()
    term = null
    fitAddon = null
    webLinksAddon = null
    resizeDisposable = null
    resizeObserver = null
    unsubscribe = null
  }
})

defineExpose({
  focus: () => term?.focus(),
  fit: () => fitTerminal(),
  write: (data) => term?.write(data)
})
</script>

<style scoped>
.session-terminal {
  height: 100%;
  min-height: 320px;
  background: #0b1021;
  border-radius: 6px;
  overflow: hidden;
  padding: 4px 6px;
}
.session-terminal :deep(.xterm) { height: 100%; }
</style>
