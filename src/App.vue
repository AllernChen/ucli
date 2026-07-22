<template>
  <a-layout class="app-layout">
    <a-layout-sider width="184" class="sider" :collapsed="false">
      <div class="logo">UCLI</div>
      <a-menu
        v-model:selectedKeys="selectedKeys"
        mode="inline"
        theme="light"
        @click="onMenuClick"
      >
        <a-menu-item key="/session">
          <DesktopOutlined />
          <span>工作台</span>
        </a-menu-item>
        <a-menu-item key="/stats">
          <BarChartOutlined />
          <span>统计</span>
        </a-menu-item>
        <a-menu-item key="/rules">
          <SafetyOutlined />
          <span>规则</span>
        </a-menu-item>
        <a-menu-item key="/settings">
          <SettingOutlined />
          <span>设置</span>
        </a-menu-item>
      </a-menu>
      <div class="sider-footer">
        <a-tag v-if="waitingCount > 0" color="orange">待确认 {{ waitingCount }}</a-tag>
        <span class="version">v0.1.0</span>
      </div>
    </a-layout-sider>
    <a-layout>
      <a-layout-header class="header">
        <span>{{ title }}</span>
        <a-space size="small">
          <a-tag color="purple">Claude Code</a-tag>
          <a-tag color="green">Codex</a-tag>
        </a-space>
      </a-layout-header>
      <a-layout-content class="content">
        <router-view />
      </a-layout-content>
    </a-layout>
  </a-layout>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { DesktopOutlined, BarChartOutlined, SafetyOutlined, SettingOutlined } from '@ant-design/icons-vue'
import { useSessionsStore } from './stores/sessions.js'

const route = useRoute()
const router = useRouter()
const sessions = useSessionsStore()

const selectedKeys = ref([route.path])
watch(() => route.path, (p) => {
  if (p.startsWith('/session')) selectedKeys.value = ['/session']
  else selectedKeys.value = [p]
})

const waitingCount = computed(() => sessions.totalWaiting)
const title = computed(() => {
  if (route.path.startsWith('/session')) return '会话工作台'
  if (route.path === '/stats') return '运行统计'
  if (route.path === '/rules') return '安全规则'
  if (route.path === '/settings') return '设置'
  return '工作台'
})

function onMenuClick({ key }) {
  router.push(key)
}
</script>

<style scoped>
.sider-footer {
  margin-top: auto;
  padding: 10px 16px;
  border-top: 1px solid #f0f0f0;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.version { font-size: 11px; color: #bfbfbf; }
:deep(.ant-layout-sider-children) { display: flex; flex-direction: column; }
</style>
