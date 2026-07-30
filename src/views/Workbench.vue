<template>
  <div class="workbench">
    <div class="toolbar">
      <a-button size="small" @click="openNew">
        <PlusOutlined /> 新建
      </a-button>
      <a-select v-model:value="filterTier" size="small" style="width: 100px" allowClear placeholder="筛选">
        <a-select-option value="always-agree">一直同意</a-select-option>
        <a-select-option value="safety-rules">安全规则</a-select-option>
        <a-select-option value="ask-everything">逐次确认</a-select-option>
      </a-select>
      <span class="spacer"></span>
      <GatewayHeaderControl />
      <a-button v-if="filtered.length" size="small" type="text" @click="expandAll">全部展开</a-button>
      <a-button v-if="filtered.length" size="small" type="text" @click="collapseAll">全部收起</a-button>
      <span class="count">{{ groupedSessions.length }} 个项目 · {{ filtered.length }} 个会话</span>
      <a-button size="small" class="goto-btn" @click="$router.push('/session')" title="工作台">
        <AppstoreOutlined />
      </a-button>
    </div>

    <div v-if="filtered.length" class="project-list">
      <section v-for="project in groupedSessions" :key="project.key" class="project-group">
        <button type="button" class="project-header" @click="toggleProject(project.key)">
          <DownOutlined v-if="!collapsedProjects.has(project.key)" />
          <RightOutlined v-else />
          <FolderOpenOutlined class="project-icon" />
          <span class="project-heading">
            <span class="project-name">{{ project.name }}</span>
            <span class="project-path" :title="project.path">{{ project.path || '未设置工作目录' }}</span>
          </span>
          <span class="group-count">{{ project.count }} 个会话</span>
        </button>

        <div v-show="!collapsedProjects.has(project.key)" class="project-content">
          <section v-for="cli in project.cliGroups" :key="cli.key" class="adapter-group">
            <button type="button" class="adapter-header" @click="toggleCli(cli.key)">
              <DownOutlined v-if="!collapsedClis.has(cli.key)" />
              <RightOutlined v-else />
              <span class="adapter-icon">{{ cli.icon }}</span>
              <span class="adapter-name">{{ cli.displayName }}</span>
              <span class="group-count">{{ cli.count }} 个会话</span>
            </button>
            <div v-show="!collapsedClis.has(cli.key)" class="card-grid">
              <SessionCard v-for="s in cli.sessions" :key="s.id" :session="s" @open="openSession" />
            </div>
          </section>
        </div>
      </section>
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
                <a-checkbox :value="s.sessionId" :disabled="s.imported">
                  <div>
                    <span class="sess-item-name">{{ s.name || s.sessionId?.slice(0, 12) }}</span>
                    <a-tag v-if="s.imported" color="default">已添加</a-tag>
                    <span class="sess-item-meta" v-if="s.model">{{ s.model }}</span>
                    <span class="sess-item-meta provider-change" v-if="s.providerChanged">provider: {{ s.sourceProvider }} → {{ s.resumeProvider }}</span>
                    <span class="sess-item-meta" v-else-if="s.sourceProvider">provider: {{ s.sourceProvider }}</span>
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
        <div v-if="discovering" class="discover-empty"><a-spin size="small" /> 正在查找历史会话…</div>
        <a-alert v-else-if="discoverError" type="error" show-icon :message="`历史会话读取失败：${discoverError}`" />
        <div v-else class="discover-empty">该目录下没有发现历史会话。</div>
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
import {
  PlusOutlined,
  AppstoreOutlined,
  DownOutlined,
  RightOutlined,
  FolderOpenOutlined
} from '@ant-design/icons-vue'
import { useSessionsStore } from '../stores/sessions.js'
import { useSettingsStore } from '../stores/settings.js'
import SessionCard from '../components/SessionCard.vue'
import GatewayHeaderControl from '../components/gateway/GatewayHeaderControl.vue'
import { groupSessionsByProject } from '../sessionGrouping.js'
import { ipc } from '../ipc.js'

const router = useRouter()
const sessions = useSessionsStore()
const settings = useSettingsStore()

const showNew = ref(false)
const creating = ref(false)
const discovering = ref(false)
const discoverError = ref('')
const filterTier = ref(undefined)

const form = ref({ adapterId: 'claude', cwd: '', model: undefined, tier: 'safety-rules' })
const discovered = ref({ claude: [], codex: [], opencode: [] })
const selectedSessions = ref({})

const filtered = computed(() =>
  filterTier.value ? sessions.sessions.filter((s) => s.tier === filterTier.value) : sessions.sessions
)
const groupedSessions = computed(() => groupSessionsByProject(filtered.value, sessions.adapters))
const collapsedProjects = ref(new Set())
const collapsedClis = ref(new Set())

const hasAnySessions = computed(() =>
  Object.values(discovered.value).some((items) => items.length > 0)
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
  discovered.value = { claude: [], codex: [], opencode: [] }
  if (form.value.cwd) discover(form.value.cwd)
  showNew.value = true
}

function openSession(id) {
  sessions.pendingAssign = id
  router.push('/session')
}

function toggleProject(key) {
  const next = new Set(collapsedProjects.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedProjects.value = next
}

function toggleCli(key) {
  const next = new Set(collapsedClis.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedClis.value = next
}

function expandAll() {
  collapsedProjects.value = new Set()
  collapsedClis.value = new Set()
}

function collapseAll() {
  collapsedProjects.value = new Set(groupedSessions.value.map((project) => project.key))
  collapsedClis.value = new Set(
    groupedSessions.value.flatMap((project) => project.cliGroups.map((cli) => cli.key))
  )
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
  discovering.value = true
  discoverError.value = ''
  discovered.value = { claude: [], codex: [], opencode: [] }
  selectedSessions.value = {}
  try {
    discovered.value = await ipc.discoverSessions(cwd)
  } catch (e) {
    discovered.value = { claude: [], codex: [], opencode: [] }
    discoverError.value = e?.message || String(e)
  } finally {
    discovering.value = false
  }
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
        const config = {
          adapterId: group.id,
          cwd: form.value.cwd,
          tier: form.value.tier,
          cliSessionId: sid,
          model: cs?.model || undefined,
          provider: cs?.resumeProvider || undefined,
          sourceProvider: cs?.sourceProvider || undefined
        }
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
    const sessionId = await sessions.createSession(config)
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
.toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
.spacer { flex: 1; }
.count { color: #bfbfbf; font-size: 12px; }
.goto-btn { color: #8c8c8c; }

.project-list { display: flex; flex-direction: column; gap: 12px; }
.project-group { overflow: hidden; background: #fff; border: 1px solid #e8e8e8; border-radius: 8px; }
.project-header, .adapter-header {
  width: 100%;
  border: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  text-align: left;
  color: #262626;
  font: inherit;
}
.project-header { gap: 8px; padding: 12px 14px; background: #fff; }
.project-header:hover { background: #fafafa; }
.project-icon { color: #d48806; font-size: 17px; }
.project-heading { min-width: 0; display: flex; align-items: baseline; gap: 10px; }
.project-name { flex-shrink: 0; font-size: 14px; font-weight: 600; }
.project-path { overflow: hidden; color: #8c8c8c; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.group-count { margin-left: auto; color: #8c8c8c; font-size: 11px; white-space: nowrap; }
.project-content { padding: 0 12px 12px; }
.adapter-group { padding-top: 8px; border-top: 1px solid #f0f0f0; }
.adapter-group + .adapter-group { margin-top: 10px; }
.adapter-header { gap: 6px; padding: 0 2px 8px; background: transparent; }
.adapter-header:hover .adapter-name { color: #1677ff; }
.adapter-icon { font-size: 15px; }
.adapter-name { font-size: 12px; font-weight: 600; }
.card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }

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
.provider-change { color: #d46b08; }
.sess-item-preview { font-size: 11px; color: #595959; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 480px; }

.cli-group-actions { display: flex; gap: 8px; }

.discover-empty { text-align: center; color: #bfbfbf; padding: 12px; font-size: 13px; }
.cli-quick-new { display: flex; align-items: center; gap: 8px; padding: 8px 0; }
.cli-quick-new span { font-size: 13px; color: #595959; }

.modal-footer { display: flex; justify-content: flex-end; margin-top: 8px; }
</style>
