<template>
  <div :class="['update-sider-footer', { collapsed }]">
    <template v-if="!collapsed">
      <div class="update-sider-footer__version">v{{ appVersion }}</div>
      <div v-if="updates.status === 'idle'" class="update-sider-footer__action">
        <span class="update-sider-footer__muted">尚未检查</span>
        <a-button size="small" type="link" @click="checkNow">检查更新</a-button>
      </div>
      <div v-if="updates.status === 'checking'" class="update-sider-footer__note">正在检查更新…</div>
      <div v-if="updates.status === 'not-available'" class="update-sider-footer__note">已是最新版本</div>
      <div v-if="updates.status === 'unsupported'" class="update-sider-footer__muted">当前环境不支持自动更新</div>
      <div v-if="updates.status === 'available'" class="update-sider-footer__available">
        <div class="update-sider-footer__action">
          <button type="button" class="update-link" @click="openDetails">
            发现 v{{ updates.availableVersion }}
          </button>
          <a-button size="small" type="link" @click="updates.download()">下载</a-button>
        </div>
        <button
          v-if="updates.releaseNotes"
          type="button"
          class="update-link"
          @click="notesExpanded = !notesExpanded"
        >
          {{ notesExpanded ? '收起升级说明' : '查看升级说明' }}
        </button>
        <pre v-if="notesExpanded && updates.releaseNotes" class="update-sider-footer__notes-body">{{ updates.releaseNotes }}</pre>
      </div>
      <div v-if="updates.status === 'downloading'" class="update-sider-footer__progress">
        <a-progress :percent="updates.progressPercent ?? 0" :show-info="false" size="small" />
        <span>{{ updates.progressPercent ?? 0 }}%</span>
      </div>
      <div v-if="updates.status === 'downloaded'" class="update-sider-footer__action">
        <button type="button" class="update-link" @click="openDetails">更新已就绪</button>
        <a-button size="small" type="link" @click="updates.install()">重启安装</a-button>
      </div>
      <div v-if="updates.status === 'installing'" class="update-sider-footer__note">正在启动安装</div>
      <div v-if="updates.status === 'error'" class="update-sider-footer__error">
        {{ updateStatusLabel(updates.status) }}
        <a-button size="small" type="link" @click="checkNow">重试</a-button>
      </div>
    </template>

    <a-popover v-else trigger="click" placement="rightBottom">
      <template #content>
        <div class="update-popover">
          <div>v{{ appVersion }}</div>
          <template v-if="actionable">
            <div v-if="updates.status === 'available'">
              <div>发现 v{{ updates.availableVersion }}</div>
              <div v-if="updates.releaseNotes" class="update-popover__notes">{{ releaseNotesSummary }}</div>
            </div>
            <a-progress
              v-if="updates.status === 'downloading'"
              :percent="updates.progressPercent ?? 0"
              size="small"
            />
            <div v-if="updates.status === 'downloaded'">更新已就绪</div>
            <div v-if="updates.status === 'installing'">{{ updateStatusLabel(updates.status) }}</div>
            <a-space>
              <a-button
                v-if="updates.status === 'available'"
                size="small"
                type="primary"
                @click="updates.download()"
              >下载</a-button>
              <a-button
                v-if="updates.status === 'downloaded'"
                size="small"
                type="primary"
                @click="updates.install()"
              >重启安装</a-button>
              <a-button size="small" @click="openDetails">查看详情</a-button>
            </a-space>
          </template>
          <div v-if="updates.status === 'checking'">正在检查更新…</div>
          <div v-if="updates.status === 'not-available'">已是最新版本</div>
          <div v-if="updates.status === 'unsupported'">当前环境不支持自动更新</div>
          <div v-if="updates.status === 'idle'" class="update-popover__action">
            <a-button size="small" @click="checkNow">检查更新</a-button>
          </div>
          <div v-if="updates.status === 'error'" class="update-popover__error">
            {{ updateStatusLabel(updates.status) }}
            <a-button size="small" @click="checkNow">重试</a-button>
          </div>
          <a-button
            v-if="!actionable && updates.status !== 'error'"
            size="small"
            type="link"
            @click="openDetails"
          >查看软件更新</a-button>
        </div>
      </template>
      <a-button
        type="text"
        class="update-sider-footer__collapsed"
        :aria-label="collapsedLabel"
      >
        <a-badge :dot="actionable">
          <CloudDownloadOutlined />
        </a-badge>
      </a-button>
    </a-popover>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { CloudDownloadOutlined } from '@ant-design/icons-vue'
import { useUpdatesStore } from '../../stores/updates.js'
import { updateFooterLabel, updateStatusLabel } from '../../updatePresentation.js'

const props = defineProps({
  collapsed: { type: Boolean, default: false },
  appVersion: { type: String, required: true }
})

const router = useRouter()
const updates = useUpdatesStore()
const notesExpanded = ref(false)
const actionable = computed(() =>
  ['available', 'downloading', 'downloaded', 'installing'].includes(updates.status)
)
const releaseNotesSummary = computed(() => {
  const notes = String(updates.releaseNotes || '').trim()
  if (!notes) return ''
  return notes.length <= 160 ? notes : `${notes.slice(0, 160)}…`
})
const collapsedLabel = computed(() => {
  const footerLabel = updateFooterLabel(updates.status, updates.availableVersion)
  const statusLabel = footerLabel || updateStatusLabel(updates.status)
  const progress = updates.status === 'downloading' && Number.isFinite(updates.progressPercent)
    ? ` ${Math.round(updates.progressPercent)}%`
    : ''
  return `UCLI v${props.appVersion}，${statusLabel}${progress}`
})

function openDetails() {
  router.push({
    name: 'settings',
    query: { ...router.currentRoute.value.query, section: 'updates' }
  })
}

function checkNow() {
  updates.check()
}
</script>

<style scoped>
.update-sider-footer { display: grid; gap: 4px; min-width: 0; }
.update-sider-footer.collapsed { display: flex; justify-content: center; }
.update-sider-footer__version { font-size: 11px; color: #bfbfbf; }
.update-sider-footer__action { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
.update-sider-footer__available { display: grid; gap: 2px; }
.update-sider-footer__notes-body { margin: 0; padding: 4px 6px; max-height: 120px; overflow: auto; background: rgba(0, 0, 0, 0.04); border-radius: 4px; font-size: 10px; line-height: 1.5; color: #595959; white-space: pre-wrap; word-break: break-word; }
.update-popover__notes { font-size: 11px; color: #8c8c8c; line-height: 1.5; }
.update-sider-footer__progress { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 5px; font-size: 10px; color: #8c8c8c; }
.update-sider-footer__note { color: #1677ff; font-size: 11px; }
.update-sider-footer__muted { color: #8c8c8c; font-size: 11px; }
.update-sider-footer__error { color: #ff7875; font-size: 11px; }
.update-link { min-width: 0; padding: 0; border: 0; background: none; color: #1677ff; font-size: 11px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.update-popover { width: 210px; display: grid; gap: 8px; }
.update-popover__error { color: #ff7875; font-size: 11px; display: grid; gap: 4px; }
.update-sider-footer__collapsed { width: 36px; }
</style>
