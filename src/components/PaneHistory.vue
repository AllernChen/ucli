<template>
  <div ref="scrollRef" class="pane-history" @scroll.passive="onScroll">
    <div class="history-toolbar">
      <button
        v-if="!complete && items.length"
        type="button"
        class="history-load"
        :disabled="loading"
        @click.stop="loadOlder"
      >
        {{ loading ? '加载中…' : '加载更早记录' }}
      </button>
      <span v-else-if="complete && items.length" class="history-boundary">已到达会话开头</span>
    </div>

    <div v-if="loading && !items.length" class="history-state">正在加载历史记录…</div>
    <div v-else-if="error && !items.length" class="history-state history-error">
      {{ error }}
      <button type="button" class="history-retry" @click.stop="loadNewest">重试</button>
    </div>
    <div v-else-if="!items.length" class="history-state">暂无可显示的历史记录</div>

    <article
      v-for="item in items"
      :key="item.id"
      :class="['history-item', `history-${item.role}`]"
    >
      <header class="history-meta">
        <span>{{ roleLabel(item.role) }}</span>
        <time v-if="formatHistoryTimestamp(item.timestamp)">
          {{ formatHistoryTimestamp(item.timestamp) }}
        </time>
      </header>
      <pre class="history-text">{{ item.text }}</pre>
    </article>

    <div v-if="error && items.length" class="history-inline-error">{{ error }}</div>
  </div>
</template>

<script setup>
import { nextTick, ref, watch } from 'vue'

import { ipc } from '../ipc.js'
import {
  formatHistoryTimestamp,
  historyScrollTopAfterPrepend,
  mergeHistoryPage,
  shouldLoadOlderHistory
} from '../historyPresentation.js'

const props = defineProps({
  sessionId: { type: String, default: '' },
  active: { type: Boolean, default: false }
})

const PAGE_SIZE = 100
const scrollRef = ref(null)
const items = ref([])
const nextBefore = ref(null)
const complete = ref(false)
const loading = ref(false)
const error = ref('')
let requestVersion = 0

function resetHistory() {
  requestVersion += 1
  items.value = []
  nextBefore.value = null
  complete.value = false
  loading.value = false
  error.value = ''
}

async function loadPage({ reset }) {
  if (!props.sessionId || loading.value) return
  const sessionId = props.sessionId
  const version = ++requestVersion
  const element = scrollRef.value
  const previousScrollTop = element?.scrollTop || 0
  const previousScrollHeight = element?.scrollHeight || 0
  loading.value = true
  error.value = ''

  try {
    const page = await ipc.getSessionHistory(sessionId, {
      before: reset ? null : nextBefore.value,
      limit: PAGE_SIZE
    })
    if (version !== requestVersion || sessionId !== props.sessionId) return

    items.value = reset
      ? mergeHistoryPage([], page)
      : mergeHistoryPage(items.value, page)
    nextBefore.value = page.nextBefore
    complete.value = Boolean(page.complete)
    await nextTick()

    const currentElement = scrollRef.value
    if (!currentElement) return
    if (reset) {
      currentElement.scrollTop = currentElement.scrollHeight
    } else {
      currentElement.scrollTop = historyScrollTopAfterPrepend({
        previousScrollTop,
        previousScrollHeight,
        nextScrollHeight: currentElement.scrollHeight
      })
    }
  } catch {
    if (version === requestVersion) error.value = '源历史记录不可用'
  } finally {
    if (version === requestVersion) loading.value = false
  }
}

function loadNewest() {
  return loadPage({ reset: true })
}

function loadOlder() {
  if (complete.value || nextBefore.value == null) return
  return loadPage({ reset: false })
}

function onScroll() {
  const element = scrollRef.value
  if (!element) return
  if (shouldLoadOlderHistory({
    scrollTop: element.scrollTop,
    loading: loading.value,
    complete: complete.value
  })) {
    void loadOlder()
  }
}

function roleLabel(role) {
  return {
    user: '用户',
    assistant: 'AI',
    tool: '工具',
    system: '系统'
  }[role] || '记录'
}

watch(
  () => props.sessionId,
  () => {
    resetHistory()
    if (props.active && props.sessionId) void loadNewest()
  }
)

watch(
  () => props.active,
  (active) => {
    if (active && props.sessionId) void loadNewest()
  },
  { immediate: true }
)
</script>

<style scoped>
.pane-history {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 10px 14px;
  background: #f5f7fa;
  color: #262626;
  user-select: text;
}

.history-toolbar {
  display: flex;
  min-height: 28px;
  align-items: center;
  justify-content: center;
}

.history-load,
.history-retry {
  border: 0;
  background: transparent;
  color: #1677ff;
  cursor: pointer;
}

.history-load:disabled {
  color: #bfbfbf;
  cursor: default;
}

.history-boundary {
  color: #8c8c8c;
  font-size: 11px;
}

.history-state {
  display: flex;
  min-height: 120px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #8c8c8c;
}

.history-error,
.history-inline-error {
  color: #cf1322;
}

.history-inline-error {
  padding: 8px;
  text-align: center;
  font-size: 12px;
}

.history-item {
  margin: 6px 0;
  padding: 8px 10px;
  border: 1px solid #e8e8e8;
  border-radius: 7px;
  background: #fff;
}

.history-user {
  border-left: 3px solid #52c41a;
}

.history-assistant {
  border-left: 3px solid #1677ff;
}

.history-tool,
.history-system {
  background: #fafafa;
  color: #595959;
}

.history-meta {
  display: flex;
  justify-content: space-between;
  margin-bottom: 4px;
  color: #8c8c8c;
  font-size: 10px;
}

.history-text {
  margin: 0;
  overflow-wrap: anywhere;
  font: 12px/1.55 "Cascadia Code", Consolas, "Courier New", monospace;
  white-space: pre-wrap;
}
</style>
