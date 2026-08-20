import { createRouter, createWebHashHistory } from 'vue-router'
import Workbench from './views/Workbench.vue'
import SessionDetail from './views/SessionDetail.vue'
import Stats from './views/Stats.vue'
import Rules from './views/Rules.vue'
import Settings from './views/Settings.vue'
import ProfileCenter from './views/ProfileCenter.vue'
import SkillsCenter from './views/SkillsCenter.vue'
import ArtifactPreviewWindow from './views/ArtifactPreviewWindow.vue'

const routes = [
  { path: '/', name: 'workbench', component: Workbench },
  { path: '/session', name: 'session', component: SessionDetail },
  { path: '/stats', name: 'stats', component: Stats },
  { path: '/rules', name: 'rules', component: Rules },
  { path: '/profiles', name: 'profiles', component: ProfileCenter },
  { path: '/skills', name: 'skills', component: SkillsCenter },
  { path: '/settings', name: 'settings', component: Settings },
  { path: '/preview', name: 'preview', component: ArtifactPreviewWindow }
]

export default createRouter({
  history: createWebHashHistory(),
  routes
})
