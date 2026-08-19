<template>
  <div class="workbench">
    <div class="toolbar">
      <a-button size="small" @click="openNew">
        <PlusOutlined /> 新建
      </a-button>
      <a-button size="small" :type="batchMode ? 'primary' : 'default'" @click="toggleBatchMode">多选</a-button>
      <a-select v-model:value="filterTier" size="small" style="width: 100px" allowClear placeholder="筛选">
        <a-select-option value="always-agree">一直同意</a-select-option>
        <a-select-option value="safety-rules">安全规则</a-select-option>
        <a-select-option value="ask-everything">逐次确认</a-select-option>
      </a-select>
      <span class="spacer"></span>
      <a-button v-if="filtered.length" size="small" type="text" @click="expandAll">全部展开</a-button>
      <a-button v-if="filtered.length" size="small" type="text" @click="collapseAll">全部收起</a-button>
      <span class="count">{{ groupedSessions.length }} 个项目 · {{ filtered.length }} 个会话</span>
      <a-button size="small" class="goto-btn" @click="$router.push('/session')" title="工作台">
        <AppstoreOutlined />
      </a-button>
    </div>

    <div v-if="batchMode" class="batch-bar">
      <a-space>
        <a-button size="small" @click="selectAllSessions">{{ allSelected ? '取消全选' : '全选' }}</a-button>
        <span class="batch-count">已选 {{ batchSelection.selected().size }} 个会话</span>
        <a-button size="small" danger :disabled="!batchSelection.hasSelection()" @click="confirmBatchDelete">批量删除</a-button>
        <a-button size="small" :disabled="!batchSelection.hasSelection()" @click="batchStop">批量停止</a-button>
        <a-button size="small" @click="exitBatchMode">退出多选</a-button>
      </a-space>
    </div>

    <div v-if="filtered.length" class="project-list">
      <section v-for="project in groupedSessions" :key="project.key" class="project-group">
        <div class="project-header" role="button" tabindex="0" @click="toggleProject(project.key)" @keydown.enter.self.prevent="toggleProject(project.key)" @keydown.space.self.prevent="toggleProject(project.key)">
          <DownOutlined v-if="!collapsedProjects.has(project.key)" />
          <RightOutlined v-else />
          <FolderOpenOutlined class="project-icon" />
          <span class="project-heading">
            <span class="project-name">{{ project.name }}</span>
            <span class="project-path" :title="project.path">{{ project.path || '未设置工作目录' }}</span>
          </span>
          <span class="group-count">{{ project.count }} 个会话</span>
          <a-button size="small" type="text" class="header-quick-add" title="在此项目新建会话" @click.stop="openQuickNew(project.path)">
            <PlusOutlined />
          </a-button>
        </div>

        <div v-show="!collapsedProjects.has(project.key)" class="project-content">
          <section v-for="cli in project.cliGroups" :key="cli.key" class="adapter-group">
            <div class="adapter-header" role="button" tabindex="0" @click="toggleCli(cli.key)" @keydown.enter.self.prevent="toggleCli(cli.key)" @keydown.space.self.prevent="toggleCli(cli.key)">
              <DownOutlined v-if="!collapsedClis.has(cli.key)" />
              <RightOutlined v-else />
              <span class="adapter-icon">{{ cli.icon }}</span>
              <span class="adapter-name">{{ cli.displayName }}</span>
              <span class="group-count">{{ cli.count }} 个会话</span>
              <a-button size="small" type="text" class="header-quick-add" :title="`新建 ${cli.displayName} 会话`" @click.stop="openQuickNew(project.path)">
                <PlusOutlined />
              </a-button>
            </div>
            <div v-show="!collapsedClis.has(cli.key)" class="card-grid">
              <SessionCard
                v-for="s in cli.sessions"
                :key="s.id"
                :session="s"
                :selectable="batchMode"
                :selected="batchSelection.selected().has(s.id)"
                @open="openSession"
                @configure="openSessionConfig"
                @action="handleSessionAction"
                @select="batchSelection.toggle"
              />
            </div>
          </section>
        </div>
      </section>
    </div>
    <a-empty v-else description="还没有会话，点击「新建会话」开始" style="margin-top: 60px" />

    <NewSessionDialog v-model:open="showNew" :initial-cwd="quickNew.cwd" />

    <SessionConfigModal
      v-model:open="sessionConfig.open"
      :session-id="sessionConfig.sessionId"
    />

    <a-modal
      v-model:open="renameState.open"
      title="重命名会话"
      ok-text="确定"
      @ok="confirmRename"
    >
      <a-input v-model:value="renameState.name" placeholder="会话名称" @pressEnter="confirmRename" />
    </a-modal>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { message, Modal } from 'ant-design-vue'
import {
  PlusOutlined,
  AppstoreOutlined,
  DownOutlined,
  RightOutlined,
  FolderOpenOutlined
} from '@ant-design/icons-vue'
import { useSessionsStore } from '../stores/sessions.js'
import { useSettingsStore } from '../stores/settings.js'
import { useGatewayStore } from '../stores/gateway.js'
import SessionCard from '../components/SessionCard.vue'
import SessionConfigModal from '../components/SessionConfigModal.vue'
import NewSessionDialog from '../components/NewSessionDialog.vue'
import { groupSessionsByProject } from '../sessionGrouping.js'
import { deriveSessionMaintenanceState } from '../sessionMaintenancePresentation.js'
import { createBatchSelection } from '../sessionBatch.js'

const router = useRouter()
const sessions = useSessionsStore()
const settings = useSettingsStore()
const gateway = useGatewayStore()

const showNew = ref(false)
const quickNew = ref({ cwd: '' })
const filterTier = ref(undefined)
const sessionConfig = ref({ open: false, sessionId: '' })
const renameState = ref({ open: false, id: '', name: '' })
const batchSelection = createBatchSelection()
const batchMode = ref(false)

const filtered = computed(() =>
  filterTier.value ? sessions.sessions.filter((s) => s.tier === filterTier.value) : sessions.sessions
)
const groupedSessions = computed(() => groupSessionsByProject(filtered.value, sessions.adapters))
const collapsedProjects = ref(new Set())
const collapsedClis = ref(new Set())

const allSelected = computed(() =>
  batchSelection.isAllSelected(filtered.value.map((s) => s.id))
)

onMounted(async () => {
  await Promise.all([sessions.init(), settings.load(), gateway.init()])
})

function openNew() {
  quickNew.value = { cwd: '' }
  showNew.value = true
}

function openQuickNew(cwd) {
  quickNew.value = { cwd: cwd || '' }
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

function openSessionConfig(sessionId) {
  sessionConfig.value = { open: true, sessionId }
}

function handleSessionAction(id, key) {
  if (key === 'stop') stopSession(id)
  else if (key === 'restart') restartSession(id)
  else if (key === 'rename') renameSession(id)
  else if (key === 'delete') confirmDeleteSession(id)
}

function toggleBatchMode() {
  if (batchMode.value) batchSelection.clear()
  batchMode.value = !batchMode.value
}

function exitBatchMode() {
  batchSelection.clear()
  batchMode.value = false
}

function selectAllSessions() {
  if (allSelected.value) batchSelection.clear()
  else batchSelection.setAll(filtered.value.map((s) => s.id))
}

function confirmBatchDelete() {
  const ids = [...batchSelection.selected()]
  if (!ids.length) return
  Modal.confirm({
    title: `批量移除 ${ids.length} 个会话？`,
    content: '仅移除 UCLI 中的会话记录，原生 CLI 历史与用量统计会保留。',
    okText: '移除',
    okType: 'danger',
    onOk: async () => {
      let ok = 0
      for (const id of ids) {
        try {
          await sessions.deleteSession(id)
          ok++
        } catch (e) {
          message.error('移除失败：' + (e?.message || e))
        }
      }
      if (ok > 0) {
        message.success(ok < ids.length ? `已移除 ${ok} 个会话，${ids.length - ok} 个失败` : `已移除 ${ok} 个会话`)
      }
      exitBatchMode()
    }
  })
}

async function batchStop() {
  const ids = [...batchSelection.selected()]
  let ok = 0
  for (const id of ids) {
    const state = deriveSessionMaintenanceState(sessions.byId(id))
    if (!state.canStop) continue
    try {
      await sessions.stop(id)
      ok++
    } catch (e) {
      message.error('停止失败：' + (e?.message || e))
    }
  }
  if (ok > 0) message.success(`已停止 ${ok} 个会话`)
  exitBatchMode()
}

async function stopSession(id) {
  try {
    await sessions.stop(id)
    message.success('已停止会话')
  } catch (e) {
    message.error('停止失败：' + (e?.message || e))
  }
}

async function restartSession(id) {
  const state = deriveSessionMaintenanceState(sessions.byId(id))
  try {
    if (state.stopBeforeRestart) await sessions.stop(id)
    await sessions.restart(id)
    message.success('已重启会话')
  } catch (e) {
    message.error('重启失败：' + (e?.message || e))
  }
}

function renameSession(id) {
  const s = sessions.byId(id)
  renameState.value = { open: true, id, name: s?.displayName || '' }
}

async function confirmRename() {
  const { id, name } = renameState.value
  const trimmed = (name || '').trim()
  if (!trimmed) { message.warning('名称不能为空'); return }
  try {
    await sessions.updateName(id, trimmed)
    message.success('已重命名')
    renameState.value.open = false
  } catch (e) {
    message.error('重命名失败：' + (e?.message || e))
  }
}

function confirmDeleteSession(id) {
  Modal.confirm({
    title: '从 UCLI 移除该会话？',
    content: '仅移除 UCLI 中的会话记录，原生 CLI 历史与用量统计会保留。',
    okText: '移除',
    okType: 'danger',
    onOk: async () => {
      try {
        await sessions.deleteSession(id)
        message.success('会话已从 UCLI 移除')
      } catch (e) {
        message.error('移除失败：' + (e?.message || e))
      }
    }
  })
}
</script>

<style scoped>
.toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
.spacer { flex: 1; }
.count { color: #bfbfbf; font-size: 12px; }
.batch-bar { margin-bottom: 12px; padding: 8px 12px; background: #e6f4ff; border: 1px solid #91caff; border-radius: 8px; }
.batch-count { color: #0958d9; font-size: 12px; }
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
.header-quick-add { flex-shrink: 0; color: #8c8c8c; }
.header-quick-add:hover { color: #1677ff; }
.card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
</style>
