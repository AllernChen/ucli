<template>
  <div :class="['update-sider-footer', { collapsed }]">
    <template v-if="!collapsed">
      <div class="update-sider-footer__version">v{{ appVersion }}</div>
      <div v-if="updates.status === 'available'" class="update-sider-footer__action">
        <button type="button" class="update-link" @click="openDetails">
          发现 v{{ updates.availableVersion }}
        </button>
        <a-button size="small" type="link" @click="updates.download()">下载</a-button>
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
    </template>

    <a-popover v-else trigger="click" placement="rightBottom">
      <template #content>
        <div class="update-popover">
          <div>v{{ appVersion }}</div>
          <template v-if="actionable">
            <div v-if="updates.status === 'available'">发现 v{{ updates.availableVersion }}</div>
            <a-progress
              v-if="updates.status === 'downloading'"
              :percent="updates.progressPercent ?? 0"
              size="small"
            />
            <div v-if="updates.status === 'downloaded'">更新已就绪</div>
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
          <a-button v-else size="small" type="link" @click="openDetails">查看软件更新</a-button>
        </div>
      </template>
      <a-button
        type="text"
        class="update-sider-footer__collapsed"
        aria-label="查看软件更新"
      >
        <a-badge :dot="actionable">
          <CloudDownloadOutlined />
        </a-badge>
      </a-button>
    </a-popover>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { CloudDownloadOutlined } from '@ant-design/icons-vue'
import { useUpdatesStore } from '../../stores/updates.js'

defineProps({
  collapsed: { type: Boolean, default: false },
  appVersion: { type: String, required: true }
})

const router = useRouter()
const updates = useUpdatesStore()
const actionable = computed(() =>
  ['available', 'downloading', 'downloaded', 'installing'].includes(updates.status)
)

function openDetails() {
  router.push({ name: 'settings', query: { section: 'updates' } })
}
</script>

<style scoped>
.update-sider-footer { display: grid; gap: 4px; min-width: 0; }
.update-sider-footer.collapsed { display: flex; justify-content: center; }
.update-sider-footer__version { font-size: 11px; color: #bfbfbf; }
.update-sider-footer__action { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
.update-sider-footer__progress { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 5px; font-size: 10px; color: #8c8c8c; }
.update-sider-footer__note { color: #1677ff; font-size: 11px; }
.update-link { min-width: 0; padding: 0; border: 0; background: none; color: #1677ff; font-size: 11px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.update-popover { width: 210px; display: grid; gap: 8px; }
.update-sider-footer__collapsed { width: 36px; }
</style>
