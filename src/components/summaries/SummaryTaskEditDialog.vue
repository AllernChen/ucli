<template>
  <a-modal
    :open="open"
    title="编辑总结任务"
    :confirm-loading="confirmLoading"
    ok-text="保存"
    cancel-text="取消"
    @ok="submit"
    @cancel="emit('update:open', false)"
  >
    <a-form layout="vertical">
      <a-form-item label="任务名称">
        <a-input v-model:value="form.title" :maxlength="120" data-testid="summary-task-title" aria-label="任务名称" />
      </a-form-item>
      <a-form-item label="备注">
        <a-textarea v-model:value="form.taskNote" :maxlength="1000" :rows="4" data-testid="summary-task-note" aria-label="备注" />
      </a-form-item>
    </a-form>
    <button type="button" hidden data-testid="summary-task-edit-submit" @click="submit" />
  </a-modal>
</template>

<script setup>
import { reactive, watch } from 'vue'

const props = defineProps({ open: Boolean, report: Object, confirmLoading: Boolean })
const emit = defineEmits(['update:open', 'submit'])
const form = reactive({ title: '', taskNote: '' })

watch(() => [props.open, props.report?.id], () => {
  if (!props.open) return
  form.title = props.report?.title || ''
  form.taskNote = props.report?.taskNote || ''
}, { immediate: true })

function submit() {
  emit('submit', { title: form.title.trim(), taskNote: form.taskNote.replace(/\r\n?/g, '\n') })
}
</script>
