<template>
  <a-modal
    :open="open"
    title="导出 HTML"
    ok-text="选择位置并生成"
    cancel-text="取消"
    :confirm-loading="confirmLoading"
    :ok-button-props="{ disabled: selectedMode === 'ai-custom' && !requirement.trim() }"
    :mask-closable="!confirmLoading"
    :closable="!confirmLoading"
    width="760px"
    @update:open="$emit('update:open', $event)"
    @ok="submit"
  >
    <div class="theme-gallery">
      <button
        v-for="theme in themes"
        :key="theme.id"
        type="button"
        class="theme-card"
        :class="{ selected: selectedMode === 'theme' && selectedThemeId === theme.id }"
        :data-theme-id="theme.id"
        @click="selectTheme(theme.id)"
      >
        <span class="theme-preview" :class="`preview-${theme.id}`" aria-hidden="true">
          <i /><i /><i />
        </span>
        <strong>{{ theme.label }}</strong>
        <small>{{ theme.description }}</small>
        <a-tag color="green">即时生成 · 不调用 AI</a-tag>
      </button>
      <button
        type="button"
        class="theme-card ai-card"
        :class="{ selected: selectedMode === 'ai-custom' }"
        @click="selectedMode = 'ai-custom'"
      >
        <span class="theme-preview preview-ai" aria-hidden="true"><i /><i /><i /></span>
        <strong>AI 自定义</strong>
        <small>根据文字要求设计专属页面</small>
        <a-tag color="orange">较慢 · 产生 AI 用量</a-tag>
      </button>
    </div>
    <a-form-item v-if="selectedMode === 'ai-custom'" label="自定义风格要求" class="requirement">
      <a-textarea
        v-model:value="requirement"
        :maxlength="1000"
        :auto-size="{ minRows: 3, maxRows: 8 }"
        show-count
        placeholder="例如：深蓝色科技风，重点数字使用青色"
      />
      <a-alert
        type="warning"
        show-icon
        message="AI 自定义生成较慢，并会产生 AI 用量"
        description="将再次调用所选 AI CLI；只有通过安全校验后才会写入文件。"
      />
    </a-form-item>
  </a-modal>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { SUMMARY_THEMES } from '../../summaryThemes.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  confirmLoading: { type: Boolean, default: false }
})
const emit = defineEmits(['update:open', 'submit'])
const DEFAULT_STYLE = Object.freeze({ mode: 'theme', themeId: 'executive' })
const details = Object.freeze({
  executive: '简洁重点，适合管理层阅读',
  engineering: '技术信息密集，适合研发复盘',
  timeline: '按进度节点呈现项目演进',
  dashboard: '突出使用量和关键数字',
  print: '黑白友好，适合打印归档'
})
const themes = computed(() => SUMMARY_THEMES.map(theme => ({ ...theme, description: details[theme.id] })))
const selectedMode = ref(DEFAULT_STYLE.mode)
const selectedThemeId = ref(DEFAULT_STYLE.themeId)
const requirement = ref('')

watch(() => props.open, value => {
  if (!value) return
  selectedMode.value = DEFAULT_STYLE.mode
  selectedThemeId.value = DEFAULT_STYLE.themeId
  requirement.value = ''
})

function selectTheme(themeId) {
  selectedMode.value = 'theme'
  selectedThemeId.value = themeId
}

function submit() {
  if (props.confirmLoading) return
  if (selectedMode.value === 'theme') {
    emit('submit', { mode: 'theme', themeId: selectedThemeId.value })
    return
  }
  const trimmed = requirement.value.trim()
  if (trimmed) emit('submit', { mode: 'ai-custom', requirement: trimmed })
}
</script>

<style scoped>
.theme-gallery{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.theme-card{display:flex;min-height:178px;padding:12px;border:1px solid #d9d9d9;border-radius:8px;background:#fff;text-align:left;cursor:pointer;flex-direction:column;gap:7px}.theme-card:hover,.theme-card.selected{border-color:#1677ff;box-shadow:0 0 0 2px rgba(22,119,255,.12)}.theme-card small{min-height:40px;color:#667085}.theme-preview{display:grid;height:58px;padding:7px;border-radius:5px;background:#f1f4f8;grid-template-columns:22% 1fr;grid-template-rows:repeat(2,1fr);gap:4px}.theme-preview i{display:block;border-radius:2px;background:#8da2b6}.theme-preview i:first-child{grid-row:1/3}.preview-engineering{background:#142635}.preview-timeline{grid-template-columns:10px 1fr;background:#fff5e8}.preview-dashboard{grid-template-columns:repeat(3,1fr);grid-template-rows:1fr}.preview-print{background:#fff;border:1px solid #bbb}.preview-ai{background:linear-gradient(135deg,#efe7ff,#e5f4ff)}.requirement{margin-top:16px}.requirement :deep(.ant-alert){margin-top:12px}@media(max-width:700px){.theme-gallery{grid-template-columns:1fr 1fr}}
</style>
