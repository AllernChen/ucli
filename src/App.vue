<template>
  <a-layout class="app-layout">
    <a-layout-sider
      width="184"
      :collapsed-width="64"
      class="sider"
      :collapsed="navCollapsed"
    >
      <div :class="['logo', { collapsed: navCollapsed }]">
        <img :src="ucliLogo" alt="" />
        <span v-if="!navCollapsed">UCLI</span>
      </div>
      <a-menu
        v-model:selectedKeys="selectedKeys"
        mode="inline"
        theme="light"
        @click="onMenuClick"
      >
        <a-menu-item key="/">
          <AppstoreOutlined />
          <span>会话</span>
        </a-menu-item>
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
      <div :class="['sider-footer', { collapsed: navCollapsed }]">
        <a-badge v-if="navCollapsed && waitingCount > 0" :count="waitingCount" />
        <a-tag v-else-if="waitingCount > 0" color="orange">待确认 {{ waitingCount }}</a-tag>
        <span v-if="!navCollapsed" class="version">v{{ appVersion }}</span>
      </div>
    </a-layout-sider>
    <a-layout class="main-layout">
      <a-layout-header class="header">
        <div class="header-main">
          <a-button
            size="small"
            type="text"
            :title="navCollapsed ? '展开菜单导航' : '收缩菜单导航'"
            @click="navCollapsed = !navCollapsed"
          >
            <MenuUnfoldOutlined v-if="navCollapsed" />
            <MenuFoldOutlined v-else />
          </a-button>
          <span>{{ title }}</span>
        </div>
      </a-layout-header>
      <a-layout-content class="content">
        <router-view v-slot="{ Component }">
          <keep-alive include="SessionDetail">
            <component :is="Component" />
          </keep-alive>
        </router-view>
      </a-layout-content>
    </a-layout>
  </a-layout>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  AppstoreOutlined,
  DesktopOutlined,
  BarChartOutlined,
  SafetyOutlined,
  SettingOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined
} from '@ant-design/icons-vue'
import { useSessionsStore } from './stores/sessions.js'
import { ipc } from './ipc.js'
import ucliLogo from '../resources/icons/ucli.png'

const route = useRoute()
const router = useRouter()
const sessions = useSessionsStore()
const navCollapsed = ref(false)
watch(navCollapsed, (v) => sessions.setNavCollapsed(v))
const appVersion = __UCLI_VERSION__

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
  return '会话'
})

function onMenuClick({ key }) {
  router.push(key)
}

let stopSessionFocus = null
onMounted(async () => {
  // Load persisted workbench state to decide initial route
  await sessions.init()
  await sessions.loadWorkbench()
  navCollapsed.value = sessions.workbench.navCollapsed
  const hasSavedPanes = sessions.workbench.paneSessionIds.some(id => id != null)
  if (hasSavedPanes) {
    router.replace('/session')
  }

  stopSessionFocus = ipc.on('session:focus-session', ({ sessionId }) => {
    sessions.pendingAssign = sessionId
    router.push('/session')
  })
})
onBeforeUnmount(() => stopSessionFocus?.())
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
.sider-footer.collapsed { justify-content: center; padding: 10px 0; }
.version { font-size: 11px; color: #bfbfbf; }
.logo img { width: 30px; height: 30px; object-fit: contain; margin-right: 8px; }
.logo.collapsed img { margin-right: 0; }
.header-main { display: flex; align-items: center; gap: 8px; }
:deep(.ant-layout-sider-children) { display: flex; flex-direction: column; }
</style>
