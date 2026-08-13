<template>
  <a-card title="软件更新" class="settings-card">
    <div class="update-toolbar">
      <span class="muted">当前版本：v{{ updates.currentVersion || '—' }}</span>
      <a-tag :color="statusColor">{{ updateStatusLabel(updates.status) }}</a-tag>
    </div>
    <p v-if="updates.availableVersion">可更新至：v{{ updates.availableVersion }}</p>
    <a-alert
      v-if="updates.status === 'unsupported'"
      type="info"
      show-icon
      message="当前版本不支持应用内更新，请从 GitHub Release 下载新版本。"
    />
    <a-alert
      v-if="updates.status === 'error'"
      type="error"
      show-icon
      :message="updates.error || '更新检查失败'"
    />
    <pre v-if="updates.releaseNotes" class="release-notes">{{ visibleReleaseNotes(updates.releaseNotes) }}</pre>
    <div v-if="updates.status === 'downloading'" class="update-progress">
      <a-progress :percent="updates.progressPercent ?? 0" status="active" />
      <span class="muted">{{ updateProgressText(updates) }}</span>
    </div>
    <a-alert
      v-if="updates.status === 'installing'"
      type="info"
      show-icon
      message="即将重启并启动安装程序，安装进度将在系统安装窗口中显示。"
    />
    <a-space>
      <a-button
        :loading="updates.status === 'checking'"
        :disabled="updates.status === 'downloading' || updates.status === 'installing'"
        @click="run(() => updates.check(), '检查更新失败')"
      >检查更新</a-button>
      <a-button
        v-if="['available', 'downloading'].includes(updates.status)"
        type="primary"
        :loading="updates.status === 'downloading'"
        :disabled="updates.status === 'downloading'"
        @click="run(() => updates.download(), '下载更新失败')"
      >{{ updates.status === 'downloading' ? '正在下载更新' : '下载更新' }}</a-button>
      <a-button
        v-if="['downloaded', 'installing'].includes(updates.status)"
        type="primary"
        :loading="updates.status === 'installing'"
        :disabled="updates.status === 'installing'"
        @click="install"
      >{{ updates.status === 'installing' ? '正在启动安装程序' : '重启并安装' }}</a-button>
    </a-space>
  </a-card>
</template>

<script setup>
import { computed } from 'vue'
import { message } from 'ant-design-vue'
import { useUpdatesStore } from '../../stores/updates.js'
import { updateProgressText, updateStatusLabel, visibleReleaseNotes } from '../../updatePresentation.js'

const updates = useUpdatesStore()
const statusColor = computed(() =>
  updates.status === 'error' ? 'red' : updates.status === 'downloaded' ? 'green' : 'blue'
)

async function run(action, fallback) {
  try { await action() } catch { message.error(fallback) }
}

async function install() {
  try {
    if (!await updates.install()) message.error('更新尚未准备就绪')
  } catch {
    message.error('启动安装失败')
  }
}
</script>

<style scoped>
.update-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.update-progress { margin: 12px 0; }
.update-progress .muted { display: block; margin-top: 6px; font-size: 12px; }
.release-notes { margin: 12px 0; max-height: 180px; overflow: auto; white-space: pre-wrap; font-size: 12px; }
.muted { color: #8c8c8c; }
</style>
