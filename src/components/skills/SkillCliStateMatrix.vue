<template>
  <div class="skill-cli-state-matrix">
    <div v-for="cell in cells" :key="`${cell.scopeType}:${cell.scopeKey}:${cell.adapterId}`" class="skill-cli-state-cell">
      <strong>{{ cell.displayName }}</strong>
      <span class="skills-muted">作用范围：{{ scopeLabel(cell) }}</span>
      <span>期望状态：<a-tag :color="tagColor(cell)">{{ desiredLabel(cell.desiredState) }}</a-tag></span>
      <span>实际状态：<a-tag :color="actualColor(cell)">{{ actualLabel(cell.actualState) }}</a-tag></span>
      <span>执行状态：<a-tag :color="enforcementColor(cell)">{{ enforcementLabel(cell.enforcementStatus) }}</a-tag></span>
      <span v-if="cell.reasonCode" class="skills-muted">{{ reasonLabel(cell.reasonCode) }}</span>
      <a-switch
        :checked="cell.desiredState !== 'disabled'"
        :disabled="cell.actionability === 'blocked' || saving || !cell.packageId"
        :aria-label="`${cell.displayName} ${scopeLabel(cell)}：${cell.desiredState === 'disabled' ? '启用' : '停用'} Skill`"
        @change="$emit('preview-change', { packageId: cell.packageId, scopeType: cell.scopeType, scopeKey: cell.scopeKey, adapterId: cell.adapterId, desiredState: $event ? 'enabled' : 'disabled' })"
      />
      <a-button
        v-if="cell.desiredState === 'inherit'"
        size="small"
        :disabled="cell.actionability === 'blocked' || saving || !cell.packageId"
        :aria-label="`${cell.displayName} ${scopeLabel(cell)}：独立启用 Skill`"
        @click="$emit('preview-change', { packageId: cell.packageId, scopeType: cell.scopeType, scopeKey: cell.scopeKey, adapterId: cell.adapterId, desiredState: 'enabled' })"
      >独立启用</a-button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

import { buildSkillCliStateCells } from '../../skillsPresentation.js'

const props = defineProps({ entry: { type: Object, required: true }, adapters: { type: Array, default: () => [] }, saving: Boolean })
defineEmits(['preview-change'])
const cells = computed(() => buildSkillCliStateCells(props.entry, props.adapters))
function scopeLabel(cell) { return cell.scopeType === 'project' ? `项目 · ${cell.scopeKey}` : '用户级' }
function desiredLabel(value) { return { enabled: '已启用', disabled: '已停用', inherit: '继承' }[value] || value }
function actualLabel(value) { return { enabled: '已直接启用', disabled: '已停用', inherited: '继承可用', drifted: '外部修改', missing: '投放缺失', invalid: '投放无效', broken_link: '链接失效', conflict: '内容冲突' }[value] || value }
function enforcementLabel(value) { return { satisfied: '已满足', migration_required: '需要迁移', blocked: '无法隔离', error: '状态异常', recovery_required: '需要恢复' }[value] || value }
function tagColor(cell) { return cell.desiredState === 'disabled' ? 'default' : cell.desiredState === 'inherit' ? 'cyan' : 'green' }
function actualColor(cell) { return ['drifted', 'missing', 'invalid', 'broken_link', 'conflict'].includes(cell.actualState) ? 'red' : cell.actualState === 'inherited' ? 'cyan' : cell.actualState === 'disabled' ? 'default' : 'green' }
function enforcementColor(cell) { return ['blocked', 'error', 'recovery_required'].includes(cell.enforcementStatus) ? 'red' : cell.enforcementStatus === 'migration_required' ? 'orange' : 'green' }
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
