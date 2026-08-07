<template>
  <div class="skills-center">
    <div class="skills-heading">
      <div>
        <h2>Skills</h2>
        <p>统一管理 Claude Code、Codex、OpenCode 和 U-Code 的可复用能力。</p>
      </div>
      <a-space>
        <a-button :loading="skills.loading" @click="reload">重新扫描</a-button>
        <a-button type="primary" @click="openInstall">安装 Skill</a-button>
      </a-space>
    </div>

    <a-alert
      v-if="skills.error"
      type="error"
      show-icon
      closable
      :message="skills.error.message"
      @close="skills.error = null"
    />

    <a-card class="skills-project-card" :bordered="false">
      <div class="skills-project-row">
        <div>
          <strong>当前查看范围</strong>
          <div class="skills-muted">{{ projectPath || '用户级 Skills（所有项目）' }}</div>
        </div>
        <a-space>
          <a-button @click="chooseProject">选择项目</a-button>
          <a-button v-if="projectPath" type="link" @click="clearProject">返回用户级</a-button>
        </a-space>
      </div>
    </a-card>

    <a-row :gutter="12">
      <a-col v-for="metric in metrics" :key="metric.label" :xs="12" :lg="6">
        <a-card class="skills-metric" :bordered="false">
          <div class="skills-metric-value">{{ metric.value }}</div>
          <div class="skills-muted">{{ metric.label }}</div>
        </a-card>
      </a-col>
    </a-row>

    <a-card :bordered="false">
      <div class="skills-filters">
        <a-input v-model:value="search" allow-clear placeholder="搜索名称或说明" />
        <a-select v-model:value="cliFilter" :options="cliOptions" />
        <a-select v-model:value="statusFilter" :options="statusOptions" />
        <a-button :loading="skills.checking" @click="checkUpdates">检查更新</a-button>
      </div>
    </a-card>

    <a-spin :spinning="skills.loading">
      <a-tabs v-model:activeKey="activeTab">
        <a-tab-pane key="managed" tab="已管理">
          <div v-if="visiblePackages.length" class="skills-grid">
            <a-card v-for="pkg in visiblePackages" :key="pkg.id" class="skill-card">
              <template #title>
                <div class="skill-card-title">
                  <span>{{ pkg.name }}</span>
                  <a-tag :color="packageStatus(pkg).color">{{ packageStatus(pkg).label }}</a-tag>
                </div>
              </template>
              <template #extra><a-button type="link" @click="openDetail(pkg)">详情</a-button></template>

              <p class="skill-description">{{ pkg.description }}</p>
              <div class="skill-meta-row">
                <a-tag>{{ skillSourceLabel(pkg) }}</a-tag>
                <span v-if="pkg.sourceRef">{{ pkg.sourceRefType }} · {{ pkg.sourceRef }}</span>
                <span v-if="pkg.resolvedRevision" class="skills-mono">{{ pkg.resolvedRevision.slice(0, 8) }}</span>
              </div>

              <div class="skill-installations">
                <div v-for="item in pkg.installations" :key="item.id" class="skill-installation-row">
                  <div>
                    <strong>{{ skillCliName(item.targetAdapterId) }}</strong>
                    <div class="skills-muted">{{ item.scopeType === 'project' ? '项目级' : '用户级' }} · {{ skillStatusPresentation(item.status).label }}</div>
                  </div>
                  <a-space>
                    <a-switch
                      :checked="item.enabled"
                      :loading="skills.saving"
                      :disabled="item.status === 'drifted' || item.status === 'invalid'"
                      @change="toggleInstallation(item, $event)"
                    />
                    <a-button size="small" danger @click="confirmRemove(item)">移除</a-button>
                  </a-space>
                </div>
                <div v-if="item.status === 'drifted'" class="skill-drift-actions">
                  <a-alert type="warning" show-icon message="投放内容已在 UCLI 外部修改。" />
                  <a-space>
                    <a-button size="small" @click="confirmResolveDrift(item, 'restore')">恢复 UCLI 版本</a-button>
                    <a-button size="small" @click="confirmResolveDrift(item, 'adopt')">接纳当前修改</a-button>
                  </a-space>
                </div>
              </div>

              <div class="skill-visibility">
                <span>实际可见性</span>
                <a-tooltip
                  v-for="(visibility, adapterId) in pkg.visibility"
                  :key="adapterId"
                  :title="skillVisibilitySummary(visibility)"
                >
                  <a-tag :color="visibility.direct ? 'purple' : visibility.visible ? 'cyan' : 'default'">
                    {{ skillCliName(adapterId) }}{{ visibility.visible && !visibility.direct ? ' · 兼容继承' : '' }}
                  </a-tag>
                </a-tooltip>
              </div>

              <div class="skill-actions">
                <a-button size="small" @click="previewAndUpdate(pkg)">查看更新</a-button>
                <a-button
                  v-if="pkg.installations.some(item => item.status === 'update_available')"
                  size="small"
                  type="primary"
                  @click="previewAndUpdate(pkg)"
                >更新</a-button>
              </div>
            </a-card>
          </div>
          <a-empty v-else description="还没有受 UCLI 管理的 Skill">
            <a-button type="primary" @click="openInstall">安装 Skill</a-button>
          </a-empty>
        </a-tab-pane>

        <a-tab-pane key="discovered" tab="已发现">
          <div v-if="visibleDiscovered.length" class="discovered-list">
            <a-card v-for="group in visibleDiscovered" :key="group.name" class="discovered-card">
              <div class="discovered-heading">
                <div>
                  <strong>{{ group.name }}</strong>
                  <p>{{ group.description }}</p>
                </div>
                <a-tag :color="skillStatusPresentation(group.status).color">{{ skillStatusPresentation(group.status).label }}</a-tag>
              </div>
              <a-alert
                v-if="group.status === 'conflict'"
                type="warning"
                show-icon
                message="发现同名但内容不同的 Skill；UCLI 不会自动覆盖。"
              />
              <div v-for="source in group.sources" :key="source.key" class="discovered-source">
                <div>
                  <a-tag>{{ skillCliName(source.adapterId) }}</a-tag>
                  <a-tag>{{ skillOriginLabel(source.origin) }}</a-tag>
                  <span>{{ source.scopeType === 'project' ? '项目级' : source.scopeType === 'user' ? '用户级' : '系统' }}</span>
                  <div class="skills-path">{{ source.path }}</div>
                </div>
                <a-button
                  v-if="source.origin === 'external'"
                  size="small"
                  @click="confirmAdopt(source)"
                >接管</a-button>
              </div>
            </a-card>
          </div>
          <a-empty v-else description="当前范围没有发现 Skills" />
        </a-tab-pane>
      </a-tabs>
    </a-spin>

    <a-drawer v-model:open="installOpen" title="安装 Skill" width="540" :destroy-on-close="true">
      <a-form layout="vertical">
        <a-form-item label="来源">
          <a-radio-group v-model:value="installDraft.sourceType" @change="clearPreview">
            <a-radio-button value="local">本地目录 / ZIP</a-radio-button>
            <a-radio-button value="github">GitHub</a-radio-button>
          </a-radio-group>
        </a-form-item>

        <template v-if="installDraft.sourceType === 'local'">
          <a-form-item label="本地位置">
            <a-input v-model:value="installDraft.localPath" readonly placeholder="选择 Skill 目录或 ZIP 文件" />
            <a-space class="skills-picker-actions">
              <a-button @click="chooseLocalDirectory">选择目录</a-button>
              <a-button @click="chooseArchive">选择 ZIP</a-button>
            </a-space>
          </a-form-item>
        </template>
        <template v-else>
          <a-form-item label="GitHub 仓库地址">
            <a-input v-model:value="installDraft.githubUrl" placeholder="https://github.com/owner/repository.git" @input="clearPreview" />
            <div class="skills-help">私有仓库使用本机 Git 登录状态，UCLI 不保存令牌。</div>
          </a-form-item>
          <a-row :gutter="12">
            <a-col :span="8">
              <a-form-item label="引用类型">
                <a-select v-model:value="installDraft.refType" :options="refTypeOptions" @change="clearPreview" />
              </a-form-item>
            </a-col>
            <a-col :span="16">
              <a-form-item label="分支 / 标签 / 提交">
                <a-input v-model:value="installDraft.ref" :disabled="installDraft.refType === 'default'" @input="clearPreview" />
              </a-form-item>
            </a-col>
          </a-row>
          <a-form-item label="仓库内子目录（可选）">
            <a-input v-model:value="installDraft.subdir" placeholder="skills/my-skill" @input="clearPreview" />
          </a-form-item>
        </template>

        <a-button :loading="inspecting" :disabled="!sourceReady" @click="inspectSource">检查来源</a-button>

        <a-card v-if="sourcePreview" class="source-preview" size="small">
          <strong>{{ sourcePreview.name }}</strong>
          <p>{{ sourcePreview.description }}</p>
          <div>{{ sourcePreview.fileList.length }} 个文件 · {{ formatBytes(sourcePreview.totalBytes) }}</div>
        </a-card>

        <a-form-item label="确保可用于">
          <a-checkbox-group v-model:value="installDraft.targets" :options="targetOptions" />
          <div class="skills-help">OpenCode 和 U-Code 可能通过兼容目录继承，不会重复投放相同内容。</div>
        </a-form-item>
        <a-form-item label="安装范围">
          <a-radio-group v-model:value="installDraft.scopeType">
            <a-radio value="user">用户级（所有项目）</a-radio>
            <a-radio value="project">项目级</a-radio>
          </a-radio-group>
        </a-form-item>
        <a-form-item v-if="installDraft.scopeType === 'project'" label="项目">
          <a-input v-model:value="installDraft.projectPath" readonly placeholder="请选择项目目录" />
          <a-button class="skills-picker-actions" @click="chooseInstallProject">选择项目</a-button>
        </a-form-item>
      </a-form>
      <template #footer>
        <div class="drawer-footer">
          <a-button @click="installOpen = false">取消</a-button>
          <a-button type="primary" :loading="skills.saving" :disabled="!canInstall" @click="install">确认安装</a-button>
        </div>
      </template>
    </a-drawer>

    <a-drawer v-model:open="detailOpen" title="Skill 详情" width="620">
      <template v-if="detailPackage">
        <a-descriptions :column="1" bordered size="small">
          <a-descriptions-item label="名称">{{ detailPackage.name }}</a-descriptions-item>
          <a-descriptions-item label="说明">{{ detailPackage.description }}</a-descriptions-item>
          <a-descriptions-item label="来源">{{ detailPackage.sourceLocator }}</a-descriptions-item>
          <a-descriptions-item label="提交" v-if="detailPackage.resolvedRevision"><span class="skills-mono">{{ detailPackage.resolvedRevision }}</span></a-descriptions-item>
        </a-descriptions>
        <h4>兼容性与实际可见性</h4>
        <div v-for="adapter in skills.adapters" :key="adapter.id" class="detail-row">
          <strong>{{ adapter.displayName }}</strong>
          <span>{{ skillVisibilitySummary(detailPackage.visibility[adapter.id]) }}</span>
        </div>
        <h4>投放位置</h4>
        <div v-for="item in detailPackage.installations" :key="item.id" class="skills-path">{{ item.targetPath }}</div>
        <h4>文件</h4>
        <a-list size="small" bordered :data-source="detailPackage.fileList">
          <template #renderItem="{ item }"><a-list-item><span class="skills-mono">{{ item }}</span></a-list-item></template>
        </a-list>
        <a-alert type="info" show-icon message="UCLI 只管理投放副本，不会执行 Skill 中的脚本。" />
      </template>
    </a-drawer>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { message, Modal } from 'ant-design-vue'

import { ipc } from '../ipc.js'
import {
  skillCliName,
  skillOriginLabel,
  skillSourceLabel,
  skillStatusPresentation,
  skillVisibilitySummary
} from '../skillsPresentation.js'
import { useSkillsStore } from '../stores/skills.js'

const skills = useSkillsStore()
const projectPath = ref('')
const activeTab = ref('managed')
const search = ref('')
const cliFilter = ref('all')
const statusFilter = ref('all')
const installOpen = ref(false)
const detailOpen = ref(false)
const detailPackage = ref(null)
const sourcePreview = ref(null)
const inspecting = ref(false)

const installDraft = reactive({
  sourceType: 'local', localPath: '', githubUrl: '', refType: 'default', ref: '', subdir: '',
  targets: ['claude', 'codex', 'opencode', 'ucode'], scopeType: 'user', projectPath: ''
})

const metrics = computed(() => [
  { label: '受管 Skills', value: skills.summary.managedPackages },
  { label: '有效投放', value: skills.summary.activeInstallations },
  { label: '可用更新', value: skills.summary.updates },
  { label: '待处理冲突', value: skills.summary.conflicts }
])
const cliOptions = computed(() => [{ value: 'all', label: '全部 CLI' }, ...skills.adapters.map(item => ({ value: item.id, label: item.displayName }))])
const statusOptions = [
  { value: 'all', label: '全部状态' },
  { value: 'ready', label: '可用' },
  { value: 'update_available', label: '有更新' },
  { value: 'drifted', label: '外部修改' },
  { value: 'conflict', label: '冲突' },
  { value: 'disabled', label: '已停用' }
]
const refTypeOptions = [
  { value: 'default', label: '默认分支' },
  { value: 'branch', label: '分支' },
  { value: 'tag', label: '标签（固定）' },
  { value: 'commit', label: '提交（固定）' }
]
const targetOptions = computed(() => skills.adapters.map(item => ({ value: item.id, label: item.displayName })))

const matchesSearch = item => !search.value || `${item.name} ${item.description}`.toLowerCase().includes(search.value.toLowerCase())
const visiblePackages = computed(() => skills.packages.filter(pkg => {
  if (!matchesSearch(pkg)) return false
  if (cliFilter.value !== 'all' && !pkg.visibility[cliFilter.value]?.visible) return false
  if (statusFilter.value !== 'all' && !pkg.installations.some(item => item.status === statusFilter.value)) return false
  return true
}))
const visibleDiscovered = computed(() => skills.discovered.filter(group => {
  if (!matchesSearch(group)) return false
  if (cliFilter.value !== 'all' && !group.sources.some(source => source.visibility[cliFilter.value]?.visible)) return false
  if (statusFilter.value !== 'all' && group.status !== statusFilter.value) return false
  return true
}))
const sourceReady = computed(() => installDraft.sourceType === 'local' ? Boolean(installDraft.localPath) : Boolean(installDraft.githubUrl))
const canInstall = computed(() => sourcePreview.value && installDraft.targets.length && (installDraft.scopeType === 'user' || installDraft.projectPath))

function sourceRequest() {
  return installDraft.sourceType === 'local'
    ? { type: 'local', path: installDraft.localPath }
    : {
        type: 'github', url: installDraft.githubUrl, refType: installDraft.refType,
        ref: installDraft.refType === 'default' ? '' : installDraft.ref, subdir: installDraft.subdir
      }
}
function clearPreview() { sourcePreview.value = null }
function formatBytes(value) { return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB` }
function packageStatus(pkg) {
  const order = ['drifted', 'invalid', 'missing', 'update_available', 'ready', 'disabled']
  const status = order.find(value => pkg.installations.some(item => item.status === value)) || 'disabled'
  return skillStatusPresentation(status)
}

async function reload() { await skills.load(projectPath.value) }
async function chooseProject() {
  const selected = await ipc.pickDirectory()
  if (!selected) return
  projectPath.value = selected
  await reload()
}
async function clearProject() { projectPath.value = ''; await reload() }
function openInstall() {
  installDraft.scopeType = projectPath.value ? 'project' : 'user'
  installDraft.projectPath = projectPath.value
  sourcePreview.value = null
  installOpen.value = true
}
async function chooseLocalDirectory() {
  const selected = await ipc.pickDirectory()
  if (selected) { installDraft.localPath = selected; clearPreview() }
}
async function chooseArchive() {
  const selected = await ipc.pickSkillArchive()
  if (selected) { installDraft.localPath = selected; clearPreview() }
}
async function chooseInstallProject() {
  const selected = await ipc.pickDirectory()
  if (selected) installDraft.projectPath = selected
}
async function inspectSource() {
  inspecting.value = true
  try { sourcePreview.value = await skills.inspectSource(sourceRequest()) } catch (error) {
    message.error(error?.message || '无法读取 Skill 来源')
  } finally { inspecting.value = false }
}
async function install() {
  try {
    const pkg = await skills.install({
      source: sourceRequest(), targetAdapterIds: installDraft.targets,
      scopeType: installDraft.scopeType, projectPath: installDraft.projectPath
    })
    installOpen.value = false
    message.success('Skill 已安装')
    await promptRestart(pkg.installations.map(item => item.id))
  } catch (error) { message.error(error?.message || '安装失败') }
}
async function sessionsFor(installationIds) { return skills.getAffectedSessions(installationIds) }
async function promptRestart(installationIds, knownSessions = null) {
  const sessions = knownSessions || await sessionsFor(installationIds)
  if (!sessions.length) return
  Modal.confirm({
    title: '重启受影响会话？',
    content: `有 ${sessions.length} 个会话需要重启后才能可靠使用新的 Skill。当前任务不会自动中断。`,
    okText: '重启会话', cancelText: '稍后处理',
    async onOk() {
      const result = await skills.restartSessions(sessions.map(item => item.id))
      const failed = result.filter(item => !item.restarted).length
      if (failed) message.warning(`${failed} 个会话未能重启`)
      else message.success('会话已重启')
    }
  })
}
async function toggleInstallation(item, enabled) {
  const affected = await sessionsFor([item.id])
  try {
    await skills.setEnabled(item.id, enabled)
    message.success(enabled ? 'Skill 已启用' : 'Skill 已停用')
    await promptRestart([], affected)
  } catch (error) { message.error(error?.message || '操作失败') }
}
function confirmRemove(item) {
  Modal.confirm({
    title: '移除此投放？',
    content: '只删除 UCLI 管理的投放副本；其他位置的现有 Skills 不会受影响。',
    okText: '移除', okType: 'danger', cancelText: '取消',
    async onOk() {
      const affected = await sessionsFor([item.id])
      await skills.removeInstallation(item.id)
      message.success('投放已移除')
      await promptRestart([], affected)
    }
  })
}
function confirmResolveDrift(item, resolution) {
  Modal.confirm({
    title: resolution === 'restore' ? '恢复 UCLI 保存的版本？' : '接纳当前外部修改？',
    content: resolution === 'restore'
      ? '当前投放目录会恢复为 UCLI 保存的受管原件。'
      : '当前目录将成为新的受管原件，并同步到该 Skill 的其他投放位置。',
    okText: resolution === 'restore' ? '确认恢复' : '确认接纳',
    cancelText: '取消',
    async onOk() {
      const affected = await sessionsFor([item.id])
      await skills.resolveDrift(item.id, resolution)
      message.success(resolution === 'restore' ? '已恢复 UCLI 版本' : '已接纳当前修改')
      await promptRestart([], affected)
    }
  })
}
function confirmAdopt(source) {
  Modal.confirm({
    title: `接管“${source.name}”？`,
    content: 'UCLI 会保存一份受管原件。接管后，启停、更新和卸载将由 UCLI 负责。',
    okText: '确认接管', cancelText: '取消',
    async onOk() {
      const pkg = await skills.adopt({
        path: source.path, targetAdapterId: source.adapterId, scopeType: source.scopeType,
        projectPath: source.scopeType === 'project' ? projectPath.value : ''
      })
      message.success('Skill 已接管')
      await promptRestart(pkg.installations.map(item => item.id))
    }
  })
}
async function checkUpdates() {
  const results = await skills.checkUpdates()
  const count = results.filter(item => item.updateAvailable).length
  message.info(count ? `发现 ${count} 个更新` : '暂未发现更新')
}
async function previewAndUpdate(pkg) {
  try {
    const preview = await skills.previewUpdate(pkg.id)
    if (!preview.updateable) { message.info('该来源不支持更新'); return }
    if (!preview.hasChanges) { message.success('当前已是最新内容'); return }
    Modal.confirm({
      title: `更新“${pkg.name}”？`,
      content: `新增 ${preview.addedFiles.length} 个文件，修改 ${preview.changedFiles.length} 个文件，移除 ${preview.removedFiles.length} 个文件。${preview.skillMdChanged ? 'SKILL.md 已发生变化，请重点核对。' : ''}更新失败时会保留当前版本。`,
      okText: '确认更新', cancelText: '取消',
      async onOk() {
        const affected = await sessionsFor(pkg.installations.map(item => item.id))
        await skills.update(pkg.id, preview.fromRevision)
        message.success('Skill 已更新')
        await promptRestart([], affected)
      }
    })
  } catch (error) { message.error(error?.message || '检查更新失败') }
}
function openDetail(pkg) { detailPackage.value = pkg; detailOpen.value = true }

onMounted(async () => {
  await reload()
  if (!skills.lastCheckedAt || Date.now() - skills.lastCheckedAt > 24 * 60 * 60 * 1000) {
    skills.checkUpdates().catch(() => {})
  }
})
</script>

<style scoped>
.skills-center { max-width: 1240px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
.skills-heading, .skills-project-row, .discovered-heading, .discovered-source { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.skills-heading h2 { margin: 0 0 4px; font-size: 22px; }
.skills-heading p, .discovered-heading p { margin: 0; color: #6b7280; }
.skills-project-card, .skills-metric, .skill-card, .discovered-card { border-radius: 10px; }
.skills-metric-value { font-size: 26px; font-weight: 700; color: #531dab; }
.skills-muted, .skills-help { color: #8c8c8c; font-size: 12px; }
.skills-filters { display: grid; grid-template-columns: minmax(220px, 1fr) 160px 160px auto; gap: 10px; }
.skills-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 14px; }
.skill-card-title { display: flex; align-items: center; gap: 8px; }
.skill-description { min-height: 42px; color: #595959; }
.skill-meta-row, .skill-actions, .skill-visibility { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.skill-meta-row { color: #8c8c8c; font-size: 12px; }
.skill-installations { margin: 14px 0; border-top: 1px solid #f0f0f0; }
.skill-installation-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid #f0f0f0; }
.skill-drift-actions { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 8px 0; }
.skill-visibility { margin-top: 12px; }
.skill-visibility > span { width: 100%; color: #8c8c8c; font-size: 12px; }
.skill-actions { margin-top: 14px; }
.discovered-list { display: flex; flex-direction: column; gap: 12px; }
.discovered-card .ant-alert { margin: 10px 0; }
.discovered-source { align-items: center; padding: 10px 0; border-top: 1px solid #f0f0f0; }
.skills-path, .skills-mono { font-family: 'Cascadia Code', Consolas, monospace; font-size: 12px; word-break: break-all; }
.skills-path { color: #8c8c8c; margin-top: 5px; }
.skills-picker-actions { margin-top: 8px; }
.source-preview { margin: 14px 0; }
.source-preview p { margin: 4px 0; color: #595959; }
.drawer-footer { display: flex; justify-content: flex-end; gap: 8px; }
.detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f0f0f0; }
h4 { margin: 20px 0 8px; }
@media (max-width: 900px) { .skills-filters { grid-template-columns: 1fr 1fr; } }
</style>
