<template>
  <div v-if="approvals.length" class="approval-panel">
    <div v-for="req in approvals" :key="req.requestId" class="approval-item">
      <div class="approval-head">
        <a-tag color="orange">需要确认</a-tag>
        <span class="tool">{{ req.tool }}</span>
        <span class="reason">{{ req.reason }}</span>
      </div>
      <div class="approval-summary">{{ req.summary }}</div>
      <pre v-if="req.command" class="approval-code">{{ req.command }}</pre>
      <div v-if="req.path" class="approval-path">📄 {{ req.path }}</div>
      <div class="approval-actions">
        <a-button type="primary" @click="decide(req, 'allow')">允许</a-button>
        <a-button danger @click="decide(req, 'deny')">拒绝</a-button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useSessionsStore } from '../stores/sessions.js'

const props = defineProps({ sessionId: { type: String, required: true } })
const store = useSessionsStore()
const { pendingApprovals } = storeToRefs(store)
const approvals = computed(() => pendingApprovals.value[props.sessionId] || [])

async function decide(req, verdict) {
  await store.respondApproval(props.sessionId, req.requestId, verdict)
}
</script>

<style scoped>
.approval-panel { display: flex; flex-direction: column; gap: 10px; margin-bottom: 12px; }
.approval-item { background: #fffbe6; border: 1px solid #ffe58f; border-radius: 8px; padding: 12px; }
.approval-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.approval-head .tool { font-weight: 700; }
.approval-head .reason { color: #8c8c8c; font-size: 12px; }
.approval-summary { font-size: 13px; margin-bottom: 6px; word-break: break-all; }
.approval-code { background: #0b1021; color: #d4d4d4; padding: 6px 8px; border-radius: 4px; font-size: 12px; margin: 6px 0; white-space: pre-wrap; }
.approval-path { font-size: 12px; color: #595959; margin: 4px 0; }
.approval-actions { display: flex; gap: 8px; margin-top: 8px; }
</style>
