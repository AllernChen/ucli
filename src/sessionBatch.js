import { reactive } from 'vue'

export function createBatchSelection() {
  const state = reactive({ ids: new Set() })
  return {
    toggle(id) { state.ids.has(id) ? state.ids.delete(id) : state.ids.add(id) },
    setAll(allIds) { state.ids = new Set(allIds) },
    isAllSelected(allIds) { return allIds.length > 0 && allIds.every(id => state.ids.has(id)) },
    selected() { return state.ids },
    mode() { return state.ids.size > 0 },
    clear() { state.ids = new Set() }
  }
}
