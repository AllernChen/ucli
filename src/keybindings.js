/**
 * Keyboard shortcut definitions and matching.
 *
 * Each binding has:
 *   id        — programmatic key
 *   name      — human-readable label
 *   keys      — { key, ctrl, shift, alt, meta } (key=null for click-only combos)
 *   contexts  — where the shortcut applies
 */
const DEFAULTS = {
  'pane.switchNext': {
    id: 'pane.switchNext',
    name: '切换到下一个窗格',
    keys: { key: 'Tab', ctrl: false, shift: false, alt: false, meta: false },
    contexts: ['terminal', 'workbench']
  },
  'pane.switchPrev': {
    id: 'pane.switchPrev',
    name: '切换到上一个窗格',
    keys: { key: 'Tab', ctrl: false, shift: true, alt: false, meta: false },
    contexts: ['terminal', 'workbench']
  },
  'terminal.copy': {
    id: 'terminal.copy',
    name: '复制选中内容',
    keys: { key: 'C', ctrl: true, shift: true, alt: false, meta: false },
    contexts: ['terminal']
  },
  'terminal.copyAlt': {
    id: 'terminal.copyAlt',
    name: '复制（备选）',
    keys: { key: 'Insert', ctrl: true, shift: false, alt: false, meta: false },
    contexts: ['terminal']
  },
  'terminal.paste': {
    id: 'terminal.paste',
    name: '粘贴',
    keys: { key: 'V', ctrl: true, shift: false, alt: false, meta: false },
    contexts: ['terminal']
  },
  'session.addPane': {
    id: 'session.addPane',
    name: 'Ctrl+单击 新增窗格并分配会话',
    keys: { key: null, ctrl: true, shift: false, alt: false, meta: false },
    contexts: ['sessionList']
  }
}

/** Return the effective binding (override from overrides, or default). */
export function getBinding(id, overrides = {}) {
  const def = DEFAULTS[id]
  if (!def) return null
  if (overrides[id]) return { ...def, keys: { ...def.keys, ...overrides[id] } }
  return def
}

/** Check if a KeyboardEvent matches a binding's key combo. */
export function matchesBinding(id, event, overrides = {}) {
  const b = getBinding(id, overrides)
  if (!b) return false
  const { key, ctrl, shift, alt, meta } = b.keys
  if (key !== null && event.key.toLowerCase() !== key.toLowerCase()) return false
  return (
    !!event.ctrlKey === !!ctrl &&
    !!event.shiftKey === !!shift &&
    !!event.altKey === !!alt &&
    !!event.metaKey === !!meta
  )
}

/** Format a binding's keys for display (e.g. "Ctrl+Shift+C"). */
export function formatKeys(keys) {
  const parts = []
  if (keys.ctrl) parts.push('Ctrl')
  if (keys.shift) parts.push('Shift')
  if (keys.alt) parts.push('Alt')
  if (keys.meta) parts.push('Meta')
  if (keys.key && keys.key.length === 1) parts.push(keys.key.toUpperCase())
  else if (keys.key) parts.push(keys.key)
  return parts.join('+')
}

/** Return all binding definitions. */
export function getAllBindings() {
  return Object.values(DEFAULTS)
}

/** Parse a KeyboardEvent into a keys descriptor suitable for storage. */
export function eventToKeys(event) {
  return {
    key: event.key === 'Control' || event.key === 'Shift' || event.key === 'Alt' || event.key === 'Meta'
      ? null : event.key,
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey
  }
}
