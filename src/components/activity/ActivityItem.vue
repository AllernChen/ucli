<template>
  <div :class="['activity-item', cls]">
    <div class="meta">
      <span class="meta-label">{{ label }}</span>
      <span class="meta-time">{{ time }}</span>
    </div>
    <div class="body">
      <template v-if="item.type === 'ready'">
        <span class="tag-ready">✅ 已就绪</span>
      </template>
      <template v-else-if="item.type === 'init'">
        <span class="tag-ready">🚀 已连接</span>
        <span v-if="item.model" class="init-detail">模型: {{ item.model }}</span>
        <span v-if="item.cliSessionId" class="init-detail">会话: {{ item.cliSessionId.slice(0, 8) }}</span>
      </template>
      <template v-else-if="item.type === 'message'">
        <div :class="['message-bubble', item.role]">
          <span v-if="item.role === 'user'" class="role-tag">👤 用户</span>
          <span v-else class="role-tag">🤖 助手</span>
          <div class="message-text" v-html="renderMarkdown(item.text)"></div>
          <span v-if="item.partial" class="streaming-indicator">▊</span>
        </div>
      </template>
      <template v-else-if="item.type === 'reasoning'">
        <div class="reasoning-block">
          <span class="reasoning-icon">💭</span>
          <span class="reasoning-text">{{ item.text }}</span>
          <span v-if="item.partial" class="streaming-indicator">▊</span>
        </div>
      </template>
      <template v-else-if="item.type === 'tool_call'">
        <div class="tool-call">
          <span class="tool-icon">🔧</span>
          <span class="tool-name">{{ item.tool }}</span>
          <span class="tool-args">{{ summarizeToolInput(item.tool, item.input) }}</span>
        </div>
      </template>
      <template v-else-if="item.type === 'tool_result'">
        <div :class="['tool-result', item.isError ? 'error' : 'success']">
          <span class="result-icon">{{ item.isError ? '❌' : '✅' }}</span>
          <span class="result-text">{{ summarizeToolResult(item) }}</span>
        </div>
      </template>
      <template v-else-if="item.type === 'command_output'">
        <pre class="code">{{ item.text }}</pre>
      </template>
      <template v-else-if="item.type === 'file_diff'">
        <div class="file-diff">
          <span class="diff-icon">📝</span>
          <span class="diff-path">{{ item.path }}</span>
          <pre v-if="item.diff" class="diff-content">{{ item.diff }}</pre>
        </div>
      </template>
      <template v-else-if="item.type === 'turn_complete'">
        <div class="turn-complete">
          <span>🔄 本轮完成</span>
          <span v-if="item.result" class="turn-result">{{ truncate(item.result, 120) }}</span>
        </div>
      </template>
      <template v-else-if="item.type === 'token_usage'">
        <div class="token-usage">
          <span>📊 Token: ↑{{ fmtNum(item.usage?.inputTokens) }} ↓{{ fmtNum(item.usage?.outputTokens) }}</span>
          <span v-if="item.costUsd != null"> · ${{ item.costUsd.toFixed(4) }}</span>
        </div>
      </template>
      <template v-else-if="item.type === 'exit'">
        <span>进程退出 (code {{ item.code }})</span>
      </template>
      <template v-else-if="item.type === 'error'">
        <span class="error-text">{{ item.message }}</span>
      </template>
      <template v-else-if="item.type === 'cli_raw'">
        <pre class="code">{{ formatted }}</pre>
      </template>
      <template v-else>
        <pre class="code">{{ JSON.stringify(item, null, 2) }}</pre>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({ item: { type: Object, required: true } })

const cls = computed(() => {
  const c = [`activity-${props.item.type}`]
  if (props.item.type === 'cli_raw' && props.item.stream === 'stderr') c.push('stderr')
  if (props.item.replay) c.push('replay')
  if (props.item.partial) c.push('streaming')
  return c
})

const label = computed(() => {
  const m = {
    ready: '就绪', init: '初始化', message: props.item.role === 'user' ? '用户' : '助手',
    reasoning: '推理', tool_call: '工具调用', tool_result: '工具结果',
    command_output: '命令输出', file_diff: '文件编辑', turn_complete: '轮次完成',
    token_usage: 'Token', exit: '退出', error: '错误',
    cli_raw: props.item.stream === 'stderr' ? 'CLI (stderr)' : 'CLI'
  }
  return m[props.item.type] || props.item.type
})

const time = computed(() => new Date(props.item.ts).toLocaleTimeString())

function truncate(s, n = 120) {
  if (!s) return ''
  return s.length > n ? s.slice(0, n) + '…' : s
}

function fmtNum(n) { return n ? n.toLocaleString() : '0' }

function summarizeToolInput(tool, input) {
  if (!input) return ''
  if (input.command) return truncate(input.command, 100)
  if (input.file_path) return input.file_path
  if (input.path) return input.path
  if (input.url) return input.url
  return ''
}

function summarizeToolResult(item) {
  if (!item.content) return item.isError ? '执行失败' : '执行成功'
  const s = typeof item.content === 'string' ? item.content : JSON.stringify(item.content)
  return truncate(s, 200)
}

function renderMarkdown(text) {
  if (!text) return ''
  let s = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="code">$2</pre>')
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/\n/g, '<br>')
  return s
}

const formatted = computed(() => {
  if (props.item.type !== 'cli_raw') return ''
  try {
    const obj = JSON.parse(props.item.text)
    if (obj.type === 'system' && obj.subtype === 'init') return `系统初始化 · 模型: ${obj.model || '—'} · 会话: ${obj.session_id?.slice(0, 8) || '—'}`
    if (obj.type === 'assistant' && obj.message?.content) {
      const t = obj.message.content.filter(b => b.type === 'text')
      if (t.length) return t.map(b => b.text).join('\n')
    }
    if (obj.type === 'result') return `结果: ${obj.subtype || '—'} · ${obj.result || ''}`
    if (obj.type === 'user' && obj.message?.content) {
      const t = obj.message.content.filter(b => b.type === 'text')
      if (t.length) return '👤 ' + t.map(b => b.text).join('\n')
    }
    return `[${obj.type || '?'}] ${obj.subtype || ''}`
  } catch { return props.item.text }
})
</script>

<style scoped>
.activity-item { padding: 6px 10px; border-bottom: 1px solid #f5f5f5; }
.activity-item:hover { background: #fafafa; }
.activity-item.replay { opacity: 0.65; border-left: 2px solid #d9d9d9; padding-left: 8px; }
.meta { display: flex; justify-content: space-between; align-items: center; margin-bottom: 3px; }
.meta-label { font-size: 11px; color: #8c8c8c; font-weight: 500; }
.meta-time { font-size: 10px; color: #bfbfbf; }
.body { font-size: 13px; line-height: 1.5; }
.message-bubble { padding: 6px 10px; border-radius: 6px; }
.message-bubble.user { background: #e6f4ff; }
.message-bubble.assistant { background: #f6ffed; }
.role-tag { font-size: 11px; color: #8c8c8c; margin-right: 6px; }
.message-text { display: inline; }
.message-text :deep(pre.code) { background: #0b1021; color: #d4d4d4; padding: 6px 8px; border-radius: 4px; font-size: 12px; margin: 4px 0; white-space: pre-wrap; overflow-x: auto; }
.message-text :deep(code) { background: #f5f5f5; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
.streaming-indicator { color: #1677ff; animation: blink 0.8s infinite; margin-left: 4px; }
@keyframes blink { 0%,100% { opacity: 1 } 50% { opacity: 0.2 } }
.reasoning-block { display: flex; align-items: flex-start; gap: 6px; padding: 4px 8px; background: #fffbe6; border-radius: 4px; font-size: 12px; color: #614700; }
.reasoning-icon { flex-shrink: 0; }
.reasoning-text { flex: 1; white-space: pre-wrap; word-break: break-all; }
.tool-call { display: flex; align-items: center; gap: 6px; padding: 4px 8px; background: #f0f5ff; border-radius: 4px; font-size: 12px; }
.tool-icon { flex-shrink: 0; }
.tool-name { font-weight: 700; color: #1677ff; }
.tool-args { color: #595959; font-family: 'Cascadia Code', Consolas, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-result { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 4px; font-size: 12px; }
.tool-result.success { background: #f6ffed; }
.tool-result.error { background: #fff2f0; }
.result-icon { flex-shrink: 0; }
.result-text { color: #595959; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.code { margin: 0; background: #0b1021; color: #d4d4d4; padding: 6px 8px; border-radius: 4px; font-size: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow-y: auto; }
.activity-cli_raw.stderr .code { background: #2d1b1b; color: #ffa0a0; }
.file-diff { font-size: 12px; }
.diff-icon { margin-right: 4px; }
.diff-path { font-weight: 600; color: #722ed1; }
.diff-content { margin: 4px 0 0 0; background: #f9f0ff; color: #333; padding: 6px 8px; border-radius: 4px; font-size: 11px; max-height: 160px; overflow-y: auto; white-space: pre-wrap; }
.turn-complete { display: flex; align-items: center; gap: 8px; color: #52c41a; font-size: 12px; }
.turn-result { color: #8c8c8c; }
.token-usage { font-size: 12px; color: #8c8c8c; }
.init-detail { font-size: 11px; color: #8c8c8c; margin-left: 8px; }
.tag-ready { color: #52c41a; }
.error-text { color: #ff4d4f; }
</style>
