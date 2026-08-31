<template>
  <a-card class="server-service-profile-card">
    <template #title>
      <div class="profile-card-title">
        <span>{{ serviceProfileLabel(profile) }}</span>
        <a-tag :color="availability.color">{{ availability.label }}</a-tag>
      </div>
    </template>

    <div class="profile-card-body">
      <div class="profile-kind">组织服务档案 · 只读</div>
      <div><span>组织</span><strong>{{ profile.organization?.name || '未命名组织' }}</strong></div>
      <div><span>服务端</span><strong>{{ profile.serverOrigin || '未设置' }}</strong></div>
    </div>

    <div class="service-model-list">
      <div v-for="model in profile.models" :key="model.id" class="service-model-row">
        <div>
          <strong>{{ model.displayName || model.id }}</strong>
          <span>{{ describeModelProtocols(model.protocols) }}</span>
        </div>
        <div>
          <span>上下文 {{ model.contextSize || '未知' }}</span>
          <a-tag :color="modelAvailability(model.availabilityStatus).color">
            {{ modelAvailability(model.availabilityStatus).label }}
          </a-tag>
        </div>
      </div>
    </div>

    <div class="profile-card-actions">
      <a-button size="small" :disabled="!canSelectDefault" @click="emit('select-default', { profileId: profile.id, scopeType: 'app' })">
        设置应用默认
      </a-button>
      <a-button size="small" :disabled="!canSelectDefault || !projectDefaultEnabled" @click="emit('select-default', { profileId: profile.id, scopeType: 'project' })">
        设置项目默认
      </a-button>
    </div>
  </a-card>
</template>

<script setup>
import { computed } from 'vue'

import { describeModelProtocols } from '../../serviceProfileSelection.js'
import {
  serviceProfileAvailabilityPresentation,
  serviceProfileLabel
} from '../../profilePresentation.js'

const props = defineProps({
  profile: { type: Object, required: true },
  canSelectDefault: { type: Boolean, default: false },
  projectDefaultEnabled: { type: Boolean, default: false }
})

const emit = defineEmits(['select-default'])
const availability = computed(() => serviceProfileAvailabilityPresentation(props.profile.availabilityStatus))
const modelAvailability = serviceProfileAvailabilityPresentation
</script>

<style scoped>
.service-model-list { display: grid; gap: 8px; margin-top: 14px; }
.service-model-row { display: flex; justify-content: space-between; gap: 12px; padding-top: 8px; border-top: 1px solid #f0f0f0; }
.service-model-row > div { display: grid; gap: 3px; }
.service-model-row > div:last-child { justify-items: end; color: #666; }
</style>
