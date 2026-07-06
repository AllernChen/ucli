import { createRouter, createWebHashHistory } from 'vue-router'
import Workbench from './views/Workbench.vue'
import SessionDetail from './views/SessionDetail.vue'
import Stats from './views/Stats.vue'
import Rules from './views/Rules.vue'
import Settings from './views/Settings.vue'

const routes = [
  { path: '/', name: 'workbench', component: Workbench },
  { path: '/session/:id', name: 'session', component: SessionDetail, props: true },
  { path: '/stats', name: 'stats', component: Stats },
  { path: '/rules', name: 'rules', component: Rules },
  { path: '/settings', name: 'settings', component: Settings }
]

export default createRouter({
  history: createWebHashHistory(),
  routes
})
