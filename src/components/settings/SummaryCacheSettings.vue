<template>
  <a-card title="总结存储策略" class="settings-card">
    <a-form layout="vertical">
      <a-form-item label="启用结果缓存">
        <a-switch v-model:checked="settings.cacheEnabled" />
      </a-form-item>
      <a-form-item label="缓存上限">
        <a-select v-model:value="settings.cacheMaxBytes">
          <a-select-option v-for="option in quotaOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </a-select-option>
        </a-select>
      </a-form-item>
      <a-form-item label="并行分析数">
        <a-select v-model:value="settings.mapConcurrency">
          <a-select-option v-for="value in [1, 2, 3]" :key="value" :value="value">{{ value }}</a-select-option>
        </a-select>
      </a-form-item>
      <a-form-item label="失败工作区保留天数">
        <a-select v-model:value="settings.failedWorkspaceRetentionDays">
          <a-select-option v-for="value in [1, 3, 7, 14, 30]" :key="value" :value="value">
            {{ value }} 天
          </a-select-option>
        </a-select>
      </a-form-item>
    </a-form>
  </a-card>
</template>

<script setup>
defineProps({ settings: { type: Object, required: true } })

const quotaOptions = [
  { value: 268435456, label: '256 MiB' },
  { value: 536870912, label: '512 MiB' },
  { value: 1073741824, label: '1 GiB' },
  { value: 2147483648, label: '2 GiB' },
  { value: 5368709120, label: '5 GiB' }
]
</script>
