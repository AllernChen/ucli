<template>
  <div class="workbench">
    <div class="toolbar">
      <a-space>
        <a-button type="primary" @click="openNew">
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
      <SessionCard v-for="s in filtered" :key="s.id" :session="s" @open="openSession" />
    </div>
    <a-empty v-else description="还没有会话，点击「新建会话」开始" style="margin-top: 60px" />

    <a-modal v-model:open="showNew" title="新建会话" :footer="null" width="640px" :destroyOnClose="true">
      <!-- Step 1: pick directory -->
      <div class="new-section">
        <div class="section-title">工作目录</div>
        <a-input-group compact>
          <a-input v-model:value="form.cwd" style="width: calc(100% - 80px)" placeholder="选择项目目录" @change="onCwdChange" />
          <a-button style="width: 80px" @click="pickDir">浏览</a-button>
        </a-input-group>
      </div>

      <!-- Step 2: discovered sessions, grouped by CLI -->
      <div v-if="hasAnySessions" class="new-section">
        <div class="section-title">发现的历史会话 — 选择导入或新建</div>

        <div v-for="group in cliGroups" :key="group.id" class="cli-group">
          <div class="cli-group-header">
            <span class="cli-icon">{{ group.icon }}</span>
            <span class="cli-name">{{ group.displayName }}</span>
            <span class="cli-count">{{ group.sessions.length }} 个历史会话</span>
          </div>

          <div v-if="group.sessions.length" class="session-list">
            <a-checkbox-group v-model:value="selectedSessions[group.id]" style="width:100%">
              <div v-for="s in group.sessions" :key="group.id + '/' + s.sessionId" class="session-row">
                <a-checkbox :value="s.sessionId">
                  <div>
                    <span class="sess-item-name">{{ s.name || s.sessionId?.slice(0, 12) }}</span>
                    <span class="sess-item-meta" v-if="s.model">{{ s.model }}</span>
                    <span class="sess-item-meta" v-if="s.turns">{{ s.turns }} 轮</span>
                    <span class="sess-item-meta">{{ fmtTime(s.startedAt) }}</span>
                  </div>
                  <div class="sess-item-preview" v-if="s.lastMessage">{{ s.lastMessage }}</div>
                </a-checkbox>
              </div>
            </a-checkbox-group>
          </div>

          <div class="cli-group-actions">
            <a-button size="small" @click="newSession(group)">新建 {{ group.displayName }}</a-button>
          </div>
        </div>
      </div>

      <div v-else-if="form.cwd" class="new-section">
        <div class="discover-empty">该目录下没有发现历史会话。</div>
        <div class="cli-quick-new">
          <span>快速新建：</span>
          <a-button v-for="a in sessions.adapters" :key="a.id" size="small" type="primary" ghost @click="newSession(a)">
            {{ a.icon }} {{ a.displayName }}
          </a-button>
        </div>
      </div>

      <!-- Tier selector (always visible) -->
      <div class="new-section">
        <div class="section-title">权限模式</div>
        <a-radio-group v-model:value="form.tier">
          <a-radio value="always-agree">一直同意</a-radio>
          <a-radio value="safety-rules">安全规则</a-radio>
          <a-radio value="ask-everything">逐次确认</a-radio>
        </a-radio-group>
      </div>
      <a-alert v-if="form.tier === 'always-agree'" type="warning" show-icon message="一直同意模式会自动放行所有操作（硬黑名单仍拦截）。" style="margin-bottom:12px" />

      <div class="modal-footer">
        <a-button @click="showNew = false">取消</a-button>
        <a-button type="primary" @click="importSelected" :loading="creating" :disabled="!totalSelected">
          导入选中会话 ({{ totalSelected }})
        </a-button>
      </div>
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
const discovered = ref({ claude: [], codex: [] })
const selectedSessions = ref({})

const filtered = computed(() =>
  filterTier.value ? sessions.sessions.filter((s) => s.tier === filterTier.value) : sessions.sessions
)

const hasAnySessions = computed(() =>
  discovered.value.claude.length > 0 || discovered.value.codex.length > 0
)

const totalSelected = computed(() => {
  let n = 0
  for (const arr of Object.values(selectedSessions.value)) n += (arr || []).length
  return n
})

const cliGroups = computed(() => {
  const groups = []
  for (const a of sessions.adapters) {
    groups.push({
      id: a.id,
      icon: a.icon,
      displayName: a.displayName,
      sessions: discovered.value[a.id] || []
    })
  }
  return groups
})

onMounted(async () => {
  await Promise.all([sessions.init(), settings.load()])
  form.value.adapterId = settings.defaultAdapter || 'claude'
  form.value.tier = settings.defaultTier || 'safety-rules'
  form.value.cwd = settings.defaultCwd || ''
  selectedSessions.value = {}
  if (form.value.cwd) discover(form.value.cwd)
})

function openNew() {
  selectedSessions.value = {}
  discovered.value = { claude: [], codex: [] }
  if (form.value.cwd) discover(form.value.cwd)
  showNew.value = true
}

function openSession(id) {
  sessions.pendingAssign = id
  router.push('/session')
}

async function pickDir() {
  const dir = await ipc.pickDirectory()
  if (dir) { form.value.cwd = dir; await discover(dir) }
}

let _debounce = null
function onCwdChange() {
  if (_debounce) clearTimeout(_debounce)
  _debounce = setTimeout(() => {
    if (form.value.cwd) discover(form.value.cwd)
  }, 400)
}

async function discover(cwd) {
  if (!cwd) return
  discovered.value = await ipc.discoverSessions(cwd)
  selectedSessions.value = {}
}

function fmtTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function importSelected() {
  if (!totalSelected.value || !form.value.cwd) { message.warning('请选择工作目录和会话'); return }
  creating.value = true
  let lastId = null, count = 0
  try {
    for (const group of cliGroups.value) {
      const ids = selectedSessions.value[group.id] || []
      for (const sid of ids) {
        const cs = group.sessions.find(s => s.sessionId === sid)
        const config = { adapterId: group.id, cwd: form.value.cwd, tier: form.value.tier, cliSessionId: sid, model: cs?.model || undefined }
        if (cs?.name) config.name = cs.name
        if (cs?.startedAt) config.startedAt = cs.startedAt
        lastId = await sessions.createSession(config)
        count++
      }
    }
    message.success(`已导入 ${count} 个会话`)
    if (count === 1 && lastId) openSession(lastId)
    showNew.value = false
  } catch (e) {
    message.error('导入失败：' + (e?.message || e))
  } finally {
    creating.value = false
  }
}

async function newSession(adapter) {
  if (!form.value.cwd) { message.warning('请先选择工作目录'); return }
  creating.value = true
  try {
    const config = {
      adapterId: adapter.id,
      cwd: form.value.cwd,
      tier: form.value.tier
    }
    const { sessionId } = await sessions.createSession(config)
    message.success(`已创建 ${adapter.displayName} 会话`)
    showNew.value = false
    openSession(sessionId)
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

.new-section { margin-bottom: 16px; }
.section-title { font-weight: 600; font-size: 13px; margin-bottom: 8px; color: #262626; }

.cli-group { border: 1px solid #f0f0f0; border-radius: 8px; padding: 12px; margin-bottom: 10px; }
.cli-group-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.cli-icon { font-size: 18px; }
.cli-name { font-weight: 600; }
.cli-count { font-size: 12px; color: #8c8c8c; }

.session-list { margin-bottom: 8px; max-height: 200px; overflow-y: auto; }
.session-row { padding: 4px 0; border-bottom: 1px solid #fafafa; }
.session-row :deep(.ant-checkbox-wrapper) { width: 100%; }
.sess-item-name { font-weight: 500; margin-right: 8px; }
.sess-item-meta { font-size: 11px; color: #8c8c8c; margin-right: 8px; }
.sess-item-preview { font-size: 11px; color: #595959; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 480px; }

.cli-group-actions { display: flex; gap: 8px; }

.discover-empty { text-align: center; color: #bfbfbf; padding: 12px; font-size: 13px; }
.cli-quick-new { display: flex; align-items: center; gap: 8px; padding: 8px 0; }
.cli-quick-new span { font-size: 13px; color: #595959; }

.modal-footer { display: flex; justify-content: flex-end; margin-top: 8px; }
</style>
