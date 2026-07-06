<template>
  <div class="rules">
    <a-alert
      type="info"
      show-icon
      message="规则语法：Bash(rm:*) 前缀匹配；Bash(re:正则) 正则；Edit(src/**) / Write(~/.ssh/**) 路径 glob；WebFetch(host) 域名。硬黑名单不可编辑、所有模式都强制拦截。"
      style="margin-bottom: 14px"
    />

    <a-row :gutter="14">
      <a-col :span="8">
        <a-card title="拒绝（deny）">
          <a-textarea v-model:value="denyText" :rows="10" placeholder="每行一条，如 Bash(rm -rf /:*)" />
        </a-card>
      </a-col>
      <a-col :span="8">
        <a-card title="高危（需确认）">
          <a-textarea v-model:value="highRiskText" :rows="10" placeholder="每行一条，如 Bash(git push:*)" />
        </a-card>
      </a-col>
      <a-col :span="8">
        <a-card title="允许（自动放行）">
          <a-textarea v-model:value="allowText" :rows="10" placeholder="每行一条，如 Bash(git status:*)" />
        </a-card>
      </a-col>
    </a-row>

    <div class="actions">
      <a-button type="primary" @click="save">保存规则</a-button>
    </div>

    <a-card title="模式测试器" style="margin-top: 14px">
      <a-space>
        <a-input v-model:value="testPattern_" style="width: 280px" placeholder="如 Bash(git push:*)" />
        <a-input v-model:value="testCommand" style="width: 320px" placeholder="样例命令，如 git push origin main" />
        <a-button @click="runTest" :loading="testing">测试</a-button>
        <a-tag v-if="testResult !== null" :color="testResult?.matches ? 'green' : 'default'">
          {{ testResult?.matches ? '匹配' : '不匹配' }}
        </a-tag>
        <span v-if="testResult?.error" class="err">{{ testResult.error }}</span>
      </a-space>
    </a-card>

    <a-card title="硬黑名单（只读）" style="margin-top: 14px">
      <div class="bl-section">命令：</div>
      <pre class="bl">{{ rules.blacklist.commands.join('\n') }}</pre>
      <div class="bl-section">路径：</div>
      <pre class="bl">{{ rules.blacklist.paths.join('\n') }}</pre>
    </a-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { message } from 'ant-design-vue'
import { useRulesStore } from '../stores/rules.js'

const rules = useRulesStore()
const denyText = ref('')
const highRiskText = ref('')
const allowText = ref('')
const testPattern_ = ref('')
const testCommand = ref('')
const testing = ref(false)
const testResult = ref(null)

onMounted(async () => {
  await rules.load()
  syncText()
})

function syncText() {
  const rs = rules.rulesets.default || { deny: [], highRisk: [], allow: [] }
  denyText.value = (rs.deny || []).join('\n')
  highRiskText.value = (rs.highRisk || []).join('\n')
  allowText.value = (rs.allow || []).join('\n')
}

function splitLines(s) {
  return s.split('\n').map((x) => x.trim()).filter(Boolean)
}

async function save() {
  rules.rulesets.default = {
    id: 'default', name: '默认规则集',
    deny: splitLines(denyText.value),
    highRisk: splitLines(highRiskText.value),
    allow: splitLines(allowText.value)
  }
  await rules.save()
  message.success('规则已保存')
}

async function runTest() {
  if (!testPattern_.value) return
  testing.value = true
  try {
    testResult.value = await rules.testPattern(testPattern_.value, testCommand.value, undefined)
  } catch (e) {
    testResult.value = { matches: false, error: String(e) }
  } finally {
    testing.value = false
  }
}
</script>

<style scoped>
.actions { margin-top: 14px; }
.bl-section { font-weight: 600; margin-top: 6px; color: #595959; }
.bl { background: #fafafa; padding: 8px; border-radius: 4px; font-size: 12px; max-height: 160px; overflow: auto; white-space: pre-wrap; }
.err { color: #ff4d4f; }
</style>
