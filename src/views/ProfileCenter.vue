<template>
  <div class="profile-center">
    <div class="profile-page-heading">
      <div>
        <h2>配置档案</h2>
        <p>为不同项目和会话选择独立的 AI CLI 配置。UCLI 不接管全局登录状态。</p>
      </div>
      <a-button :loading="profiles.loading" @click="reload">重新读取</a-button>
    </div>

    <div class="profile-cli-grid">
      <button
        v-for="cli in cliEntries"
        :key="cli.id"
        type="button"
        :class="['profile-cli-card', { active: selectedCli === cli.id }]"
        @click="selectedCli = cli.id"
      >
        <span class="profile-cli-name">{{ cli.name }}</span>
        <a-tag :color="cli.installed ? 'green' : 'default'">{{ cli.installed ? '已安装' : '未检测到' }}</a-tag>
        <span class="profile-cli-version">{{ cli.version || '版本未知' }}</span>
        <span>{{ cli.id === 'codex' ? '支持配置档案' : '0.8.0 沿用系统配置' }}</span>
      </button>
    </div>

    <a-alert
      v-if="selectedCli !== 'codex'"
      type="info"
      show-icon
      :message="`${selectedEntry.name} 在 0.8.0 沿用系统配置`"
      description="当前版本只展示安装状态、版本和路径，不提供尚未生效的配置按钮。"
    />

    <template v-else>
      <a-card class="profile-runtime-card" :bordered="false">
        <div class="profile-runtime-row">
          <div>
            <strong>Codex 状态</strong>
            <p>
              {{ selectedEntry.installed ? '已安装' : '未检测到' }}
              · 当前系统 Provider：{{ profiles.codexRuntime?.currentProvider || 'openai' }}
            </p>
            <span class="profile-path">{{ profiles.codexRuntime?.configPath || selectedEntry.path || '配置路径未知' }}</span>
          </div>
          <a-space>
            <a-button @click="chooseProject">选择项目</a-button>
            <a-button type="primary" @click="openCreate">＋ 新建档案</a-button>
          </a-space>
        </div>
        <div v-if="projectPath" class="profile-project-path">
          项目默认范围：{{ projectPath }}
        </div>
      </a-card>

      <a-alert
        v-if="profiles.error"
        type="error"
        show-icon
        :message="profiles.error.message"
        closable
        @close="profiles.error = null"
      />

      <a-spin :spinning="profiles.loading">
        <div v-if="profiles.profiles.length" class="profile-card-grid">
          <a-card v-for="profile in profiles.profiles" :key="profile.id" class="profile-card">
            <template #title>
              <div class="profile-card-title">
                <span>{{ profile.name }}</span>
                <a-tag :color="statusView(profile).color">{{ statusView(profile).label }}</a-tag>
              </div>
            </template>
            <template #extra>
              <a-dropdown>
                <a-button type="text">更多</a-button>
                <template #overlay>
                  <a-menu>
                    <a-menu-item @click="openEdit(profile)">编辑</a-menu-item>
                    <a-menu-item @click="openCopy(profile)">复制</a-menu-item>
                    <a-menu-item @click="openRevisions(profile)">版本记录</a-menu-item>
                    <a-menu-divider />
                    <a-menu-item danger @click="confirmDelete(profile)">删除</a-menu-item>
                  </a-menu>
                </template>
              </a-dropdown>
            </template>

            <div class="profile-card-body">
              <div class="profile-kind">{{ profile.kind === 'managed' ? 'UCLI 托管' : '引用现有 Provider' }}</div>
              <div><span>服务</span><strong>{{ profile.kind === 'managed' ? profileEndpointLabel(profile.baseUrl) : profile.providerId }}</strong></div>
              <div><span>模型</span><strong>{{ profile.model || '跟随 Provider' }}</strong></div>
              <div v-if="profile.kind === 'managed'"><span>密钥</span><strong>{{ profileSecretLabel(profile) }}</strong></div>
              <div><span>推理强度</span><strong>{{ profile.reasoningEffort || '默认' }}</strong></div>
            </div>

            <div v-if="profileBadges(profile).length" class="profile-badges">
              <a-tag v-for="badge in profileBadges(profile)" :key="badge" color="blue">{{ badge }}</a-tag>
            </div>

            <a-alert
              v-if="profile.status !== 'ready'"
              :type="profile.status === 'drifted' ? 'warning' : 'error'"
              show-icon
              :message="statusView(profile).label"
            />

            <div class="profile-card-actions">
              <a-button size="small" @click="openEdit(profile)">编辑</a-button>
              <a-button size="small" @click="toggleAppDefault(profile)">
                {{ profile.isAppDefault ? '取消应用默认' : '设为应用默认' }}
              </a-button>
              <a-button size="small" :disabled="!projectPath" @click="toggleProjectDefault(profile)">
                {{ profile.isProjectDefault ? '取消项目默认' : '设为项目默认' }}
              </a-button>
              <a-button
                v-if="['drifted', 'missing_file'].includes(profile.status)"
                size="small"
                danger
                @click="confirmRepair(profile)"
              >{{ profile.status === 'missing_file' ? '重新生成' : '用 UCLI 版本覆盖' }}</a-button>
              <a-button size="small" @click="openRevisions(profile)">版本记录</a-button>
            </div>
          </a-card>
        </div>
        <a-empty v-else description="还没有 Codex 档案">
          <a-button type="primary" @click="openCreate">新建档案</a-button>
        </a-empty>
      </a-spin>
    </template>

    <CodexProfileDrawer
      v-model:open="editorOpen"
      :profile="editorSeed"
      :mode="editorMode"
      :provider-catalog="profiles.codexRuntime?.providerCatalog || []"
      :saving="profiles.saving"
      @save="saveProfile"
    />
    <ProfileRevisionDrawer
      v-model:open="revisionOpen"
      :revisions="activeProfile ? profiles.revisionsByProfileId[activeProfile.id] || [] : []"
      :rolling-back-id="rollingBackId"
      @rollback="rollback"
    />
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { message, Modal } from 'ant-design-vue'

import CodexProfileDrawer from '../components/profiles/CodexProfileDrawer.vue'
import ProfileRevisionDrawer from '../components/profiles/ProfileRevisionDrawer.vue'
import { ipc } from '../ipc.js'
import {
  profileBadges,
  profileEndpointLabel,
  profileSecretLabel,
  profileStatusPresentation
} from '../profilePresentation.js'
import { useAiCliProfilesStore } from '../stores/aiCliProfiles.js'

const profiles = useAiCliProfilesStore()
const selectedCli = ref('codex')
const projectPath = ref('')
const editorOpen = ref(false)
const editorMode = ref('create')
const editorSeed = ref(null)
const activeProfile = ref(null)
const revisionOpen = ref(false)
const rollingBackId = ref('')

const names = { codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode', ucode: 'U-Code' }
const cliEntries = computed(() => ['codex', 'claude', 'opencode', 'ucode'].map((id) => ({
  id,
  name: names[id],
  ...profiles.cliById(id)
})))
const selectedEntry = computed(() => cliEntries.value.find((item) => item.id === selectedCli.value) || cliEntries.value[0])

const statusView = (profile) => profileStatusPresentation(profile.status)

async function reload() {
  await profiles.load(projectPath.value)
}

async function chooseProject() {
  const path = await ipc.pickDirectory()
  if (!path) return
  projectPath.value = path
  await reload()
}

function openCreate() {
  editorMode.value = 'create'
  editorSeed.value = null
  editorOpen.value = true
}

function openEdit(profile) {
  editorMode.value = 'edit'
  editorSeed.value = profile
  editorOpen.value = true
}

function openCopy(profile) {
  editorMode.value = 'copy'
  editorSeed.value = { ...profile, name: `${profile.name} 副本`, hasSecret: false }
  editorOpen.value = true
}

async function saveProfile(draft) {
  try {
    if (editorMode.value === 'edit') {
      const { secret, adapterId, ...patch } = draft
      await profiles.update(editorSeed.value.id, patch)
      if (secret) await profiles.setSecret(editorSeed.value.id, secret)
    } else {
      await profiles.create(draft)
    }
    editorOpen.value = false
    message.success('档案已保存')
  } catch (error) {
    message.error(error?.message || '保存档案失败')
  }
}

async function toggleAppDefault(profile) {
  await profiles.setBinding({
    scopeType: 'app', scopeKey: '*', adapterId: 'codex',
    profileId: profile.isAppDefault ? null : profile.id
  })
}

async function toggleProjectDefault(profile) {
  if (!projectPath.value) return
  await profiles.setBinding({
    scopeType: 'project', scopeKey: projectPath.value, adapterId: 'codex',
    profileId: profile.isProjectDefault ? null : profile.id
  })
}

function confirmRepair(profile) {
  Modal.confirm({
    title: profile.status === 'missing_file' ? '重新生成档案文件？' : '用 UCLI 版本覆盖外部修改？',
    content: `目标：${profiles.codexRuntime?.configPath || 'Codex 配置目录'} 下的 UCLI 管理文件。继续后将更新文件指纹；不会改写 config.toml。`,
    okText: profile.status === 'missing_file' ? '重新生成' : '确认覆盖',
    cancelText: '取消',
    async onOk() {
      await profiles.repair(profile.id)
      message.success('档案文件已修复')
    }
  })
}

function confirmDelete(profile) {
  Modal.confirm({
    title: `删除“${profile.name}”？`,
    content: '已被默认设置或会话使用的档案不能删除。API Key 将从系统加密存储中一并移除。',
    okText: '删除', okType: 'danger', cancelText: '取消',
    async onOk() { await profiles.remove(profile.id) }
  })
}

async function openRevisions(profile) {
  activeProfile.value = profile
  await profiles.loadRevisions(profile.id)
  revisionOpen.value = true
}

async function rollback(revisionId) {
  if (!activeProfile.value) return
  rollingBackId.value = revisionId
  try {
    await profiles.rollback(activeProfile.value.id, revisionId)
    message.success('已回滚档案配置，密钥保持不变')
  } finally {
    rollingBackId.value = ''
  }
}

onMounted(() => reload())
</script>
