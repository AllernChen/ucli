<template>
  <div class="workbench">
    <div class="toolbar">
      <a-space>
        <a-button type="primary" @click="showNew = true">
          <PlusOutlined /> 新建会话
        </a-button>
        <a-select v-model:value="filterTier" style="width: 140px" allowClear placeholder="按模式筛选">
          <a-select-option value="always-agree">一直同意</a-select-option>
          <a-select-option value="safety-rules">安全规则</a-select-option>
          <a-select-option value="ask-everything">逐次确认</a-select-option>
        </a-select>
      </a-space>
      <span class="count">共 {{ filtered.length }} 个会话</span>
    </div>

    <div v-if="filtered.length" class="card-grid">
      <SessionCard
        v-for="s in filtered"
        :key="s.id"
        :session="s"
        @open="openSession"
      />
    </div>
    <a-empty v-else description="还没有会话，点击「新建会话」开始" style="margin-top: 60px" />

    <a-modal v-model:open="showNew" title="新建会话" okText="创建并启动" cancelText="取消" @ok="createNew" :confirmLoading="creating">
      <a-form layout="vertical">
        <a-form-item label="CLI">
          <a-select v-model:value="form.adapterId">
            <a-select-option v-for="a in sessions.adapters" :key="a.id" :value="a.id">
              {{ a.icon }} {{ a.displayName }}
            </a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item label="工作目录">
          <a-input-group compact>
            <a-input v-model:value="form.cwd" style="width: calc(100% - 80px)" placeholder="选择项目目录" />
            <a-button style="width: 80px" @click="pickDir">浏览</a-button>
          </a-input-group>
        </a-form-item>
        <a-form-item v-if="claudeSessions.length" label="导入历史会话">
          <a-select v-model:value="importSessionIds" mode="multiple" allowClear placeholder="选择已有的 Claude 会话（可多选）">
            <a-select-option v-for="cs in claudeSessions" :key="cs.sessionId" :value="cs.sessionId">
              {{ cs.name || cs.sessionId?.slice(0, 8) }}
              <span style="color:#8c8c8c;font-size:12px">{{ fmtTime(cs.startedAt) }}</span>
            </a-select-option>
          </a-select>
          <div v-if="importSessionIds.length" style="font-size:12px;color:#1677ff;margin-top:4px">
            将导入 {{ importSessionIds.length }} 个会话，创建后自动 --resume 续接。
          </div>
        </a-form-item>

        <a-form-item label="模型（可选）">
          <a-select v-model:value="form.model" allowClear placeholder="使用默认">
            <a-select-option v-for="m in currentModels" :key="m" :value="m">{{ m }}</a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item label="权限模式">
          <a-radio-group v-model:value="form.tier">
            <a-radio value="always-agree">一直同意</a-radio>
            <a-radio value="safety-rules">安全规则</a-radio>
            <a-radio value="ask-everything">逐次确认</a-radio>
          </a-radio-group>
        </a-form-item>
      </a-form>
      <a-alert v-if="form.tier === 'always-agree'" type="warning" show-icon message="一直同意模式会自动放行所有操作（硬黑名单仍拦截）。" />
      <a-alert v-else-if="form.tier === 'ask-everything'" type="info" show-icon message="逐次确认模式：每次工具调用都需要你手动确认。" />
    </a-modal>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { message } from 'ant-design-vue'
import { PlusOutlined } from '@ant-design/icons-vue'
import { useSessionsStore } from '../stores/sessions.js'
import { useSettingsStore } from '../stores/settings.js'
import SessionCard from '../components/SessionCard.vue'
import { ipc } from '../ipc.js'

const router = useRouter()
const sessions = useSessionsStore()
const settings = useSettingsStore()

const showNew = ref(false)
const creating = ref(false)
const filterTier = ref(undefined)

const form = ref({ adapterId: 'claude', cwd: '', model: undefined, tier: 'safety-rules' })
const claudeSessions = ref([])
const importSessionIds = ref([])

const currentModels = computed(() => {
  const a = sessions.adapters.find((x) => x.id === form.value.adapterId)
  return a?.models || []
})

const filtered = computed(() =>
  filterTier.value ? sessions.sessions.filter((s) => s.tier === filterTier.value) : sessions.sessions
)

onMounted(async () => {
  await Promise.all([sessions.init(), settings.load()])
  form.value.adapterId = settings.defaultAdapter || 'claude'
  form.value.tier = settings.defaultTier || 'safety-rules'
  form.value.cwd = settings.defaultCwd || ''
})

function openSession(id) {
  router.push(`/session/${id}`)
}

async function pickDir() {
  const dir = await ipc.pickDirectory()
  if (dir) { form.value.cwd = dir; await scanSessions(dir) }
}

async function scanSessions(dir) {
  if (!dir) return
  claudeSessions.value = await ipc.scanClaudeSessions(dir)
  importSessionIds.value = []
}

function fmtTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`
}

async function createNew() {
  if (!form.value.cwd) {
    message.warning('请选择工作目录')
    return
  }
  creating.value = true
  try {
    const ids = importSessionIds.value
    let lastId = null
    if (ids.length) {
      for (const sid of ids) {
        const cs = claudeSessions.value.find((s) => s.sessionId === sid)
        const config = { ...form.value, adapterId: 'claude', cliSessionId: sid }
        if (cs?.name) config.name = cs.name
        if (cs?.startedAt) config.startedAt = cs.startedAt
        lastId = await sessions.createSession(config)
      }
    } else {
      const config = { ...form.value }
      if (config.name === undefined) delete config.name
      lastId = await sessions.createSession(config)
    }
    showNew.value = false
    claudeSessions.value = []
    importSessionIds.value = []
    const count = ids.length || 1
    message.success(`已启动 ${count} 个会话`)
    if (count === 1 && lastId) openSession(lastId)
  } catch (e) {
    message.error('创建失败：' + (e?.message || e))
  } finally {
    creating.value = false
  }
}
</script>

<style scoped>
.toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.count { color: #8c8c8c; font-size: 13px; }
</style>
