<template>
  <div class="stats">
    <div class="toolbar">
      <a-button @click="load"><ReloadOutlined /> 刷新</a-button>
      <span class="hint">会话: {{ Object.keys(stats.perSession).length }} | input: {{ stats.total.input.toLocaleString() }} | turns: {{ stats.total.turns }}</span>
    </div>

    <a-row :gutter="14">
      <a-col :span="6"><a-card><a-statistic title="输入 Tokens" :value="stats.total.input" /></a-card></a-col>
      <a-col :span="6"><a-card><a-statistic title="输出 Tokens" :value="stats.total.output" /></a-card></a-col>
      <a-col :span="6"><a-card><a-statistic title="累计费用" :value="stats.total.costUsd" :precision="4" prefix="$" /></a-card></a-col>
      <a-col :span="6"><a-card><a-statistic title="总轮次" :value="stats.total.turns" /></a-card></a-col>
    </a-row>

    <a-card title="审批分布" style="margin-top: 14px">
      <a-row :gutter="14">
        <a-col :span="8"><a-statistic title="自动放行" :value="stats.total.approvals.autoAllowed" :value-style="{ color: '#52c41a' }" /></a-col>
        <a-col :span="8"><a-statistic title="人工确认" :value="stats.total.approvals.confirmed" :value-style="{ color: '#1677ff' }" /></a-col>
        <a-col :span="8"><a-statistic title="已拒绝" :value="stats.total.approvals.denied" :value-style="{ color: '#ff4d4f' }" /></a-col>
      </a-row>
    </a-card>

    <!-- Per-model grouping -->
    <a-card title="按模型统计" style="margin-top: 14px">
      <a-table :dataSource="models" :columns="modelColumns" rowKey="model" :pagination="false" size="small">
        <template #bodyCell="{ column, record }">
          <template v-if="column.dataIndex === 'costUsd'">
            {{ record.costUsd ? '$' + record.costUsd.toFixed(4) : '—' }}
          </template>
        </template>
      </a-table>
      <a-empty v-if="!models.length" description="暂无数据" :imageStyle="{ height: 48 }" />
    </a-card>

    <!-- Per-project grouping -->
    <a-card title="按项目统计" style="margin-top: 14px">
      <a-table :dataSource="projects" :columns="projColumns" rowKey="cwd" :pagination="false" size="small">
        <template #bodyCell="{ column, record }">
          <template v-if="column.dataIndex === 'cwd'">
            <span class="cwd-cell" :title="record.cwd">{{ record.cwd }}</span>
          </template>
          <template v-else-if="column.dataIndex === 'costUsd'">
            {{ record.costUsd ? '$' + record.costUsd.toFixed(4) : '—' }}
          </template>
        </template>
      </a-table>
      <a-empty v-if="!projects.length" description="暂无数据" :imageStyle="{ height: 48 }" />
    </a-card>

    <!-- Per-session -->
    <a-card title="按会话" style="margin-top: 14px">
      <a-table :dataSource="rows" :columns="columns" rowKey="id" :pagination="false" size="small">
        <template #bodyCell="{ column, record }">
          <template v-if="column.dataIndex === 'status'">
            <a-tag v-if="record.status === 'offline'" color="default">已离线</a-tag>
            <a-tag v-else-if="record.status === 'removed'" color="default">已移除（留痕）</a-tag>
            <a-tag v-else-if="record.status === 'running'" color="blue">运行中</a-tag>
            <a-tag v-else-if="record.status === 'idle'" color="green">空闲</a-tag>
            <a-tag v-else color="default">{{ record.status }}</a-tag>
          </template>
          <template v-else-if="column.dataIndex === 'adapter'">{{ record.icon }} {{ record.adapter }}</template>
          <template v-else-if="column.dataIndex === 'cwd'">
            <span class="cwd-cell" :title="record.cwd">{{ record.cwd }}</span>
          </template>
          <template v-else-if="column.dataIndex === 'costUsd'">
            {{ record.costUsd ? '$' + record.costUsd.toFixed(4) : '—' }}
          </template>
          <template v-else-if="column.dataIndex === 'approvals'">
            <a-tag color="green">放行 {{ record.autoAllowed }}</a-tag>
            <a-tag color="blue">确认 {{ record.confirmed }}</a-tag>
            <a-tag color="red">拒绝 {{ record.denied }}</a-tag>
          </template>
        </template>
      </a-table>
    </a-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ReloadOutlined } from '@ant-design/icons-vue'
import { useStatsStore } from '../stores/stats.js'
import { useSessionsStore } from '../stores/sessions.js'

const stats = useStatsStore()
const sessions = useSessionsStore()

const columns = [
  { title: '状态', dataIndex: 'status', width: 70 },
  { title: 'CLI', dataIndex: 'adapter', width: 70 },
  { title: '模型', dataIndex: 'model', width: 100 },
  { title: '目录', dataIndex: 'cwd', width: 150 },
  { title: '输入', dataIndex: 'input', width: 80 },
  { title: '输出', dataIndex: 'output', width: 80 },
  { title: '费用', dataIndex: 'costUsd', width: 90 },
  { title: '轮次', dataIndex: 'turns', width: 60 },
  { title: '审批', dataIndex: 'approvals' }
]

const modelColumns = [
  { title: '模型', dataIndex: 'model' },
  { title: '输入', dataIndex: 'input', width: 100 },
  { title: '输出', dataIndex: 'output', width: 100 },
  { title: '费用', dataIndex: 'costUsd', width: 110 },
  { title: '轮次', dataIndex: 'turns', width: 80 },
  { title: '会话数', dataIndex: 'count', width: 80 }
]

const projColumns = [
  { title: '项目目录', dataIndex: 'cwd' },
  { title: '输入', dataIndex: 'input', width: 100 },
  { title: '输出', dataIndex: 'output', width: 100 },
  { title: '费用', dataIndex: 'costUsd', width: 110 },
  { title: '轮次', dataIndex: 'turns', width: 80 },
  { title: '会话数', dataIndex: 'count', width: 80 }
]

const rows = computed(() => {
  const adapterMap = Object.fromEntries(sessions.adapters.map((a) => [a.id, a]))
  return Object.entries(stats.perSession).map(([id, s]) => ({
    id, adapter: s.adapterId, icon: adapterMap[s.adapterId]?.icon || '',
    model: s.model || '—',
    cwd: s.cwd || '',
    status: s.status,
    input: s.tokens.input, output: s.tokens.output,
    costUsd: s.costUsd,
    turns: s.turns,
    autoAllowed: s.approvals.autoAllowed || 0, confirmed: s.approvals.confirmed || 0, denied: s.approvals.denied || 0
  }))
})

const models = computed(() =>
  (stats.modelStats || []).map((m) => ({
    model: m.model,
    input: m.input_tokens,
    output: m.output_tokens,
    costUsd: m.cost_usd,
    turns: '—',
    count: m.session_count
  }))
)

const projects = computed(() => {
  const map = {}
  for (const s of Object.values(stats.perSession)) {
    const key = s.cwd || '(未设置)'
    if (!map[key]) map[key] = { cwd: key, input: 0, output: 0, costUsd: 0, turns: 0, count: 0 }
    map[key].input += s.tokens.input
    map[key].output += s.tokens.output
    map[key].costUsd += s.costUsd || 0
    map[key].turns += s.turns || 0
    map[key].count += 1
  }
  return Object.values(map)
})

onMounted(load)
const route = useRoute()
watch(() => route.path, (p) => { if (p === '/stats') load() })

async function load() {
  stats.initLiveUpdates()
  await Promise.all([sessions.init(), stats.refresh()])
}
</script>

<style scoped>
.toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.hint { color: #8c8c8c; font-size: 12px; }
.cwd-cell { max-width: 200px; display: inline-block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
