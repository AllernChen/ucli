<template>
  <div class="skill-cli-state-matrix">
    <div v-for="cell in cells" :key="cell.adapterId" class="skill-cli-state-cell">
      <strong>{{ cell.displayName }}</strong>
      <a-tag :color="tagColor(cell)">{{ stateLabel(cell) }}</a-tag>
      <span v-if="cell.reasonCode" class="skills-muted">{{ reasonLabel(cell.reasonCode) }}</span>
      <a-switch
        :checked="cell.desiredState !== 'disabled'"
        :disabled="cell.enforcementStatus === 'blocked' || saving || !cell.packageId"
        @change="$emit('preview-change', { packageId: cell.packageId, scopeType: cell.scopeType, scopeKey: cell.scopeKey, adapterId: cell.adapterId, desiredState: $event ? 'enabled' : 'disabled' })"
      />
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

import { buildSkillCliStateCells } from '../../skillsPresentation.js'

const props = defineProps({ entry: { type: Object, required: true }, adapters: { type: Array, default: () => [] }, saving: Boolean })
defineEmits(['preview-change'])
const cells = computed(() => buildSkillCliStateCells(props.entry, props.adapters))
function stateLabel(cell) {
  if (cell.enforcementStatus === 'blocked') return '无法隔离'
  if (cell.enforcementStatus === 'migration_required') return '需要迁移'
  if (cell.actualState === 'inherited') return '继承可用'
  return cell.desiredState === 'disabled' ? '已停用' : '已直接启用'
}
function tagColor(cell) { return cell.enforcementStatus === 'blocked' ? 'red' : cell.actualState === 'inherited' ? 'cyan' : cell.desiredState === 'disabled' ? 'default' : 'green' }
function reasonLabel(reasonCode) {
  return reasonCode === 'SKILL_CLI_ISOLATION_UNSUPPORTED' ? '当前 CLI 无法可靠隔离继承目录' : reasonCode || ''
}
</script>

<style scoped>
.skill-cli-state-matrix { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.skill-cli-state-cell { min-height: 96px; padding: 10px; border: 1px solid #f0f0f0; border-radius: 8px; background: #fafafa; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
.skills-muted { color: #8c8c8c; font-size: 12px; }
@media (max-width: 1000px) { .skill-cli-state-matrix { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
