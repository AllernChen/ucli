<template>
  <div class="skills-center">
    <div class="skills-heading">
      <div>
        <h2>Skills</h2>
        <p>统一管理 Claude Code、Codex、OpenCode、U-Code 和 DeepSeek Harness 的可复用能力。</p>
      </div>
      <a-space>
        <a-button :loading="skills.loading" @click="reload">重新扫描</a-button>
        <a-button type="primary" @click="openInstall">安装 Skill</a-button>
      </a-space>
    </div>

    <a-alert
      v-if="skills.error"
      type="error"
      show-icon
      closable
      :message="skills.error.message"
      @close="skills.error = null"
    />

    <a-card class="skills-project-card" :bordered="false">
      <div class="skills-project-row">
        <div>
          <strong>当前查看范围</strong>
          <div class="skills-muted">{{ projectPath || '用户级 Skills（所有项目）' }}</div>
        </div>
        <a-space>
          <a-button @click="chooseProject">选择项目</a-button>
          <a-button v-if="projectPath" type="link" @click="clearProject">返回用户级</a-button>
        </a-space>
      </div>
    </a-card>

    <a-card v-if="serverConnection.status !== 'disconnected'" title="组织 Skills" class="skills-project-card server-skills-catalog" :bordered="false">
      <template #extra>
        <a-space>
          <span v-if="serverConnection.skillsSyncState.lastSyncedAt" class="skills-muted">目录已同步</span>
          <a-button size="small" :loading="serverConnection.skillsSyncState.status === 'syncing'" @click="syncOrganizationSkills">同步组织目录</a-button>
        </a-space>
      </template>
      <a-alert
        v-if="serverConnection.skillsCatalogError"
        type="warning"
        show-icon
        closable
        :message="serverConnection.skillsCatalogError.message"
        @close="serverConnection.skillsCatalogError = null"
      />
      <a-empty v-if="!serverConnection.skills.length" description="当前没有可用的组织 Skills" />
      <a-list v-else :data-source="serverConnection.skills" item-layout="horizontal">
        <template #renderItem="{ item }">
          <a-list-item>
            <template #actions>
              <a-button
                size="small"
                type="primary"
                :disabled="item.lifecycleStatus === 'REVOKED' || serverConnection.busy || !canUseServerSkillTargets"
                @click="installOrganizationSkill(item)"
              >安装</a-button>
              <a-button
                size="small"
                :disabled="item.lifecycleStatus === 'REVOKED' || serverConnection.busy || !canUseServerSkillTargets"
                @click="updateOrganizationSkill(item)"
              >更新</a-button>
            </template>
            <a-list-item-meta :title="item.name || item.skill?.name || item.slug || item.id">
              <template #description>
                <a-space wrap>
                  <a-tag color="blue">组织提供</a-tag>
                  <span>{{ item.organizationName || serverConnection.organization?.name || '组织' }}</span>
                  <span>版本：{{ item.version || '未知' }}</span>
                  <a-tag>{{ item.lifecycleStatus || 'AVAILABLE' }}</a-tag>
                </a-space>
                <a-alert v-if="item.lifecycleStatus === 'REVOKED'" type="error" show-icon message="REVOKED：已撤销，不能安装或更新；已安装副本仍保留，请尽快处理风险。" />
                <a-alert v-else-if="item.lifecycleStatus === 'DEPRECATED'" type="warning" show-icon message="DEPRECATED：仍可按目录可用性继续使用、安装或更新，请计划迁移。" />
              </template>
            </a-list-item-meta>
          </a-list-item>
        </template>
      </a-list>
      <div class="skills-muted">选择目标 AI CLI 后再安装；断开连接只会移除在线目录，已安装副本仍在普通列表中显示。</div>
      <a-select v-model:value="serverSkillTargets.targetAdapterIds" mode="multiple" :options="targetOptions" style="width: 100%; margin-top: 8px" />
      <a-radio-group v-model:value="serverSkillTargets.scopeType" style="margin-top: 8px">
        <a-radio value="user">用户级</a-radio>
        <a-radio value="project">项目级</a-radio>
      </a-radio-group>
      <a-space v-if="serverSkillTargets.scopeType === 'project'" style="margin-top: 8px">
        <a-input v-model:value="serverSkillTargets.projectPath" placeholder="选择项目目录" readonly />
        <a-button @click="chooseServerSkillProject">选择项目</a-button>
      </a-space>
    </a-card>

    <a-row :gutter="12">
      <a-col v-for="metric in metrics" :key="metric.label" :xs="12" :lg="6">
        <a-card class="skills-metric" :bordered="false">
          <div class="skills-metric-value">{{ metric.value }}</div>
          <div class="skills-muted">{{ metric.label }}</div>
        </a-card>
      </a-col>
    </a-row>

    <a-card :bordered="false">
      <div class="skills-filters">
        <a-input v-model:value="search" allow-clear placeholder="搜索名称或说明" />
        <a-select v-model:value="cliFilter" :options="cliOptions" style="width: 130px" />
        <a-select v-model:value="statusFilter" :options="statusOptions" style="width: 130px" />
        <a-select v-model:value="scopeFilter" :options="scopeOptions" style="width: 130px" />
        <label class="skills-built-in-toggle">
          <a-switch v-model:checked="showBuiltIn" size="small" />
          <span>显示内置 Skills</span>
        </label>
        <a-button :loading="skills.checking" @click="checkUpdates">检查更新</a-button>
      </div>
    </a-card>

    <a-spin :spinning="skills.loading">
      <div class="skills-catalog-heading">
        <div>
          <strong>Skills 聚合视图</strong>
          <div class="skills-muted">默认显示用户安装的 Skills；同名 Skill 的多 CLI 投放合并展示。</div>
        </div>
        <span class="skills-muted">{{ visibleSkillCount }} 个 Skill</span>
      </div>

      <div v-if="sourceProjects.length" class="skills-source-projects">
        <a-card
          v-for="sourceProject in sourceProjects"
          :key="sourceProject.key"
          class="skills-source-project skill-aggregate-card"
          hoverable
          @click="openSourceProjectDetail(sourceProject)"
        >
          <div class="skills-source-project-heading">
            <div>
              <strong>{{ sourceProject.label }}</strong>
              <div class="skills-muted">
                {{ sourceProject.kind === 'github' ? 'GitHub 源项目' : sourceProject.kind === 'gitlab' ? 'GitLab 源项目' : '本地、接管与已发现的 Skills' }}
                · {{ sourceProject.entries.length }} 个 Skill
              </div>
            </div>
            <a-button
              v-if="sourceProject.repositoryUrl"
              size="small"
              @click.stop="openSourceProject(sourceProject)"
            >打开项目</a-button>
          </div>

          <div class="skill-aggregate-cli-summary">
            <strong>AI CLI 使用情况</strong>
            <div class="skill-aggregate-cli-grid">
              <div
                v-for="item in buildSourceProjectCliSummary(sourceProject, skills.adapters)"
                :key="item.adapterId"
                class="skill-aggregate-cli-cell"
                :class="`is-${item.state}`"
              >
                <span>{{ item.displayName }}</span>
                <strong>{{ item.used }}/{{ item.total }}</strong>
              </div>
            </div>
          </div>
          <div class="skill-card-open-hint">点击查看聚合详情</div>

          <a-drawer
            v-if="detailSourceProject === sourceProject"
            v-model:open="sourceProjectDetailOpen"
            :title="`${sourceProject.label} · Skills 聚合详情`"
            width="1100"
            :destroy-on-close="true"
            @click.stop
          >
          <div class="skills-source-project-heading">
            <div>
              <strong>包含的 Skills</strong>
              <div class="skills-muted">{{ sourceProject.entries.length }} 个 Skill，点击 Skill 卡片可继续管理</div>
            </div>
            <a-button
              v-if="sourceProject.repositoryUrl"
              size="small"
              @click="openSourceProject(sourceProject)"
            >打开原项目</a-button>
          </div>

          <div class="skills-grid">
            <a-card
              v-for="entry in sourceProject.entries"
              :key="entry.key"
              class="skill-card skill-card-summary"
              hoverable
              @click="openSkillDetail(sourceProject.key, entry)"
            >
          <template #title>
            <div class="skill-card-title">
              <span>{{ entry.name }}</span>
              <a-tag :color="skillStatusPresentation(entry.status).color">{{ skillStatusPresentation(entry.status).label }}</a-tag>
              <a-tag v-if="entry.builtinOnly">CLI 内置</a-tag>
            </div>
          </template>

          <p class="skill-description">{{ entry.description }}</p>
          <div class="skill-meta-row">
            <span>{{ entry.installations.length + entry.sources.length }} 个位置</span>
            <span v-if="entry.packages.length">{{ entry.packages.length }} 个 UCLI 受管包</span>
          </div>

          <div class="skill-card-cli-summary">
            <strong>AI CLI 使用情况</strong>
            <div class="skill-card-cli-grid">
              <div
                v-for="cell in buildSkillCliMatrix(entry, skills.adapters)"
                :key="cell.adapterId"
                class="skill-card-cli-cell"
                :class="`is-${cell.state}`"
              >
                <span>{{ cell.displayName }}</span>
                <a-tag :color="cliCellColor(cell.state)">{{ cell.label }}</a-tag>
              </div>
            </div>
          </div>
          <div class="skill-card-open-hint">点击查看详情与管理</div>

          <a-alert
            v-if="entry.status === 'conflict'"
            type="warning"
            show-icon
            message="发现同名但内容不同的 Skill；请分别核对来源，UCLI 不会自动覆盖。"
          />

          <a-drawer
            v-if="detailEntry === entry"
            v-model:open="skillDetailOpen"
            :title="`${entry.name} · Skill 详情`"
            width="760"
            :destroy-on-close="true"
            @click.stop
          >
          <p class="skill-description">{{ entry.description }}</p>
          <div class="skill-meta-row">
            <span>{{ entry.installations.length + entry.sources.length }} 个位置</span>
            <span v-if="entry.packages.length">{{ entry.packages.length }} 个 UCLI 受管包</span>
          </div>

          <div class="skill-installations">
            <div v-for="item in entry.installations" :key="item.id" class="skill-location">
              <div class="skill-installation-row">
                <div>
                  <a-tag>{{ skillCliName(item.targetAdapterId) }}</a-tag>
                  <a-tag color="purple">UCLI 托管</a-tag>
                  <a-tag v-if="item.sourceKind">{{ skillSourceKindLabel(item.sourceKind) }}</a-tag>
                  <a-tag v-if="item.dshSource" color="blue">{{ dshSkillSourcePresentation(item).badge }}</a-tag>
                  <a-tag v-if="item.dshSource" :color="item.effective ? 'green' : 'orange'">
                    {{ dshSkillSourcePresentation(item).status }}
                  </a-tag>
                  <a-tag v-if="item.health" :color="sourceHealthColor(item.health)">{{ sourceHealthLabel(item.health, item.link) }}</a-tag>
                  <span>{{ scopeLabel(item.scopeType) }} · {{ skillStatusPresentation(item.status).label }}</span>
                  <div v-if="item.plugin" class="skill-plugin-id">
                    插件：{{ item.plugin.id }}@{{ item.plugin.marketplace }}
                  </div>
                  <div v-if="!item.dshSource" class="skills-path"><span>入口：</span>{{ item.entryPath || item.targetPath }}</div>
                  <div v-if="!item.dshSource && hasDistinctPhysicalPath(item)" class="skills-path">
                    <span>物理位置：</span>{{ item.resolvedPath }}
                  </div>
                </div>
                <a-space v-if="!item.dshSource || !dshSkillSourcePresentation(item).readOnly">
                  <a-switch
                    :checked="item.enabled"
                    :loading="skills.saving"
                    :disabled="['drifted', 'invalid', 'broken_link'].includes(item.status)"
                    @change="toggleInstallation(item, $event)"
                  />
                  <a-button size="small" danger @click="confirmRemove(item)">移除</a-button>
                </a-space>
              </div>
              <a-alert
                v-if="item.health === 'broken_link'"
                class="skill-source-alert"
                type="error"
                show-icon
                message="链接目标已失效，此受管入口当前不可用。"
              />
              <div v-if="item.status === 'drifted'" class="skill-drift-actions">
                <a-alert type="warning" show-icon message="投放内容已在 UCLI 外部修改。" />
                <a-space>
                  <a-button size="small" @click="confirmResolveDrift(item, 'restore')">恢复 UCLI 版本</a-button>
                  <a-button size="small" @click="confirmResolveDrift(item, 'adopt')">接纳当前修改</a-button>
                </a-space>
              </div>
            </div>

            <div v-if="entry.sources.length" class="skill-source-heading">来源与入口</div>
            <div v-for="source in entry.sources" :key="source.key" class="skill-installation-row skill-source-row">
              <div class="skill-source-details">
                <div>
                  <a-tag>{{ skillSourceKindLabel(source.sourceKind) }}</a-tag>
                  <a-tag>{{ skillOriginLabel(source.origin) }}</a-tag>
                  <a-tag v-if="source.dshSource" color="blue">{{ dshSkillSourcePresentation(source).badge }}</a-tag>
                  <a-tag v-if="source.dshSource" :color="source.effective ? 'green' : 'orange'">
                    {{ dshSkillSourcePresentation(source).status }}
                  </a-tag>
                  <a-tag :color="sourceHealthColor(source.health)">
                    {{ sourceHealthLabel(source.health, source.link) }}
                  </a-tag>
                  <span>{{ scopeLabel(source.scopeType) }}</span>
                </div>
                <div v-if="source.plugin" class="skill-plugin-id">
                  插件：{{ source.plugin.id }}@{{ source.plugin.marketplace }}
                </div>
                <div v-if="!source.dshSource" class="skills-path"><span>入口：</span>{{ source.entryPath || source.path }}</div>
                <div v-if="!source.dshSource && hasDistinctPhysicalPath(source)" class="skills-path">
                  <span>物理位置：</span>{{ source.resolvedPath }}
                </div>
                <a-alert
                  v-if="source.health === 'broken_link'"
                  class="skill-source-alert"
                  type="error"
                  show-icon
                  message="链接目标已失效，此入口当前不会被对应 AI CLI 使用。"
                />
              </div>
              <a-button
                v-if="source.origin === 'external' && source.health === 'ready' && source.manageable !== false && (!source.dshSource || !dshSkillSourcePresentation(source).readOnly)"
                size="small"
                @click="confirmAdopt(source)"
              >接管</a-button>
            </div>
          </div>

          <div class="skill-cli-section">
            <div class="skill-cli-heading">
              <strong>AI CLI 使用情况</strong>
              <span class="skills-muted">已应用 / 可用（兼容继承） / 已发现 / 已停用 / 未应用；支持应用、直接应用和纳入管理</span>
            </div>
            <div class="skill-cli-matrix">
              <a-tooltip
                v-for="cell in buildSkillCliMatrix(entry, skills.adapters)"
                :key="cell.adapterId"
                :title="cell.disabledReason || (cell.state === 'inherited' ? `通过 ${cell.inheritedFrom.map(skillCliName).join('、')} 兼容可用` : '')"
              >
                <div class="skill-cli-cell" :class="`is-${cell.state}`">
                  <span class="skill-cli-name">{{ cell.displayName }}</span>
                  <a-tag :color="cliCellColor(cell.state)">{{ cell.label }}</a-tag>
                  <span v-if="cell.state === 'inherited'" class="skills-muted">
                    来自 {{ cell.inheritedFrom.map(skillCliName).join('、') }}
                  </span>
                  <a-button
                    v-if="cell.action"
                    size="small"
                    type="link"
                    :loading="skills.saving"
                    @click="handleCliAction(entry, cell)"
                  >{{ cell.actionLabel }}</a-button>
                </div>
              </a-tooltip>
            </div>
          </div>

          <div v-if="entry.packages.length" class="skill-package-actions">
            <div v-for="pkg in entry.packages" :key="pkg.id" class="skill-package-action-row">
              <div class="skill-meta-row">
                <a-tag>{{ skillSourceLabel(pkg) }}</a-tag>
                <a-tag v-if="pkg.server" color="blue">组织提供</a-tag>
                <span v-if="pkg.sourceRef">{{ pkg.sourceRefType }} · {{ pkg.sourceRef }}</span>
                <span v-if="pkg.resolvedRevision" class="skills-mono">{{ pkg.resolvedRevision.slice(0, 8) }}</span>
              </div>
              <a-alert v-if="pkg.server?.warning === 'unavailable'" type="warning" show-icon message="组织目录当前不可用；已安装副本仍可继续使用。" />
              <a-alert v-else-if="pkg.server?.warning === 'revoked'" type="error" show-icon message="此组织 Skill 已 REVOKED；已安装副本保留，但请尽快处理风险。" />
              <a-alert v-else-if="pkg.server?.warning === 'deprecated'" type="warning" show-icon message="此组织 Skill 已 DEPRECATED；请计划迁移。" />
              <a-space>
                <a-dropdown v-if="entry.packages.length > 1 && packageApplyTargets(pkg, entry).length">
                  <a-button size="small">应用到 CLI</a-button>
                  <template #overlay>
                    <a-menu>
                      <a-menu-item
                        v-for="adapter in packageApplyTargets(pkg, entry)"
                        :key="adapter.id"
                        @click="applyPackageToAdapter(entry, pkg, adapter.id)"
                      >{{ adapter.displayName }}</a-menu-item>
                    </a-menu>
                  </template>
                </a-dropdown>
                <a-button size="small" @click="openDetail(pkg)">详情</a-button>
                <a-button size="small" @click="previewAndUpdate(pkg)">查看更新</a-button>
                <a-button
                  v-if="pkg.installations.some(item => item.status === 'update_available')"
                  size="small"
                  type="primary"
                  @click="previewAndUpdate(pkg)"
                >更新</a-button>
              </a-space>
            </div>
          </div>
          </a-drawer>
            </a-card>
          </div>
          </a-drawer>
        </a-card>
      </div>
      <a-empty v-else description="当前范围没有用户安装的 Skills">
        <a-button type="primary" @click="openInstall">安装 Skill</a-button>
      </a-empty>
    </a-spin>

    <a-drawer
      v-model:open="installOpen"
      title="安装 Skill"
      width="540"
      :destroy-on-close="true"
      :closable="!skills.saving"
      :mask-closable="!skills.saving"
      :keyboard="!skills.saving"
    >
      <a-form layout="vertical">
        <a-form-item label="来源">
          <a-radio-group v-model:value="installDraft.sourceType" :disabled="skills.saving" @change="clearPreview">
            <a-radio-button value="local">本地目录 / ZIP</a-radio-button>
            <a-radio-button value="git">GitHub / GitLab</a-radio-button>
          </a-radio-group>
        </a-form-item>

        <template v-if="installDraft.sourceType === 'local'">
          <a-form-item label="本地位置">
            <a-input v-model:value="installDraft.localPath" readonly placeholder="选择 Skill 目录或 ZIP 文件" />
            <a-space class="skills-picker-actions">
              <a-button :disabled="skills.saving" @click="chooseLocalDirectory">选择目录</a-button>
              <a-button :disabled="skills.saving" @click="chooseArchive">选择 ZIP</a-button>
            </a-space>
          </a-form-item>
        </template>
        <template v-else>
          <a-form-item label="GitHub / GitLab 仓库地址">
            <a-input v-model:value="installDraft.gitUrl" :disabled="skills.saving" placeholder="https://github.com/owner/repository.git 或 https://gitlab.com/group/project.git" @input="clearPreview" />
            <div class="skills-help">支持 GitHub、GitLab 与自建 GitLab；HTTP 仅支持私网或本机地址。私有仓库复用本机 Git 登录状态，UCLI 不保存令牌。</div>
          </a-form-item>
          <a-row :gutter="12">
            <a-col :span="8">
              <a-form-item label="引用类型">
                <a-select v-model:value="installDraft.refType" :options="refTypeOptions" :disabled="skills.saving" @change="clearPreview" />
              </a-form-item>
            </a-col>
            <a-col :span="16">
              <a-form-item label="分支 / 标签 / 提交">
                <a-input v-model:value="installDraft.ref" :disabled="installDraft.refType === 'default' || skills.saving" @input="clearPreview" />
              </a-form-item>
            </a-col>
          </a-row>
          <a-form-item label="仓库内子目录（可选）">
            <a-input v-model:value="installDraft.subdir" :disabled="skills.saving" placeholder="skills/my-skill" @input="clearPreview" />
          </a-form-item>
        </template>

        <a-button :loading="inspecting" :disabled="!sourceReady || skills.saving" @click="inspectSource">检查来源</a-button>

        <a-card v-if="sourcePreview && sourcePreview.kind === 'collection'" class="source-preview" size="small">
          <strong>发现 {{ sourcePreview.skills.length }} 个 Skills</strong>
          <p>这个仓库是 Skill 集合，可以选择一个或多个 Skill，也可以全选。</p>
          <div class="skills-collection-controls">
            <a-checkbox
              :checked="collectionSelectionState.allSelected"
              :indeterminate="collectionSelectionState.partiallySelected"
              :disabled="inspecting || skills.saving"
              @change="toggleCollectionSelectAll"
            >全选</a-checkbox>
            <span class="skills-muted">
              已选择 {{ collectionSelectionState.selectedSkills.length }}/{{ sourcePreview.skills.length }}
            </span>
          </div>
          <a-select
            v-model:value="collectionSelectedSubdirs"
            mode="multiple"
            :options="collectionSkillOptions"
            placeholder="选择要安装的 Skills"
            style="width: 100%"
            :loading="inspecting"
            :disabled="inspecting || skills.saving"
          />
          <a-alert
            v-if="collectionSelectionState.blockedSkills.length"
            class="skills-inline-alert"
            type="error"
            show-icon
            :message="`${collectionSelectionState.blockedSkills.length} 个所选 Skill 暂不可安装`"
            :description="collectionBlockedDescription"
          />
          <a-alert
            v-if="sourcePreview.invalidSkills?.length"
            class="skills-inline-alert"
            type="warning"
            show-icon
            :message="`${sourcePreview.invalidSkills.length} 个无效 Skill 已跳过`"
          />
          <a-alert
            v-if="batchInstallResult && (batchInstallResult.failed.length || batchInstallResult.aborted || batchInstallResult.refreshError)"
            class="skills-inline-alert"
            type="warning"
            show-icon
            message="批量安装结果"
          >
            <template #description>
              <div
                v-for="success in batchInstallResult.installed"
                :key="`success:${success.request.source.subdir}`"
                class="skills-batch-result skills-batch-result-success"
              >
                ✓ {{ collectionSkillName(success.request.source.subdir) }} · {{ success.request.source.subdir }}
              </div>
              <div
                v-for="failure in batchInstallResult.failed"
                :key="`failure:${failure.request.source.subdir}`"
                class="skills-batch-result skills-batch-result-failure"
              >
                ✕ {{ collectionSkillName(failure.request.source.subdir) }} · {{ failure.request.source.subdir }} ·
                {{ failure.error.code }} · {{ failure.error.message }}
              </div>
              <div v-if="batchInstallResult.refreshError" class="skills-batch-result skills-batch-result-failure">
                状态刷新失败 · {{ batchInstallResult.refreshError.code }} · {{ batchInstallResult.refreshError.message }}
              </div>
              <div v-if="batchInstallResult.aborted" class="skills-batch-result skills-batch-result-failure">
                批次已中止，{{ collectionSkillName(batchInstallResult.aborted.request.source.subdir) }} 的保存状态待确认 ·
                {{ batchInstallResult.aborted.error.code }} · {{ batchInstallResult.aborted.error.message }}；
                已跳过 {{ batchInstallResult.aborted.skippedRequests.length }} 个 Skill
              </div>
            </template>
          </a-alert>
        </a-card>

        <a-card v-else-if="sourcePreview" class="source-preview" size="small">
          <strong>{{ sourcePreview.name }}</strong>
          <p>{{ sourcePreview.description }}</p>
          <div>{{ sourcePreview.fileList.length }} 个文件 · {{ formatBytes(sourcePreview.totalBytes) }}</div>
        </a-card>

        <a-alert
          v-if="installPreflight.kind === 'already_installed'"
          type="info"
          show-icon
          message="该 Skill 已安装，可直接应用到其他 CLI"
          :description="installPreflight.missingAdapterIds.length
            ? `确认后仅补充当前不可用的 CLI：${installPreflightMissingNames}`
            : '所选 CLI 已经可以使用该 Skill，重复确认不会创建副本。'"
        />
        <a-alert
          v-else-if="installPreflight.kind === 'source_changed'"
          type="warning"
          show-icon
          message="该来源已安装，但内容发生了变化"
          description="请在已安装 Skill 中使用更新或重新同步，UCLI 不会创建第二份重复安装。"
        />
        <a-alert
          v-else-if="installPreflight.kind === 'existing_target'"
          type="info"
          show-icon
          message="目标 CLI 已存在相同内容的 Skill"
          description="确认后 UCLI 只登记并接管现有目录，不会覆盖文件或创建重复副本。"
        />
        <a-alert
          v-else-if="installPreflight.kind === 'target_conflict'"
          type="error"
          show-icon
          message="目标 CLI 已存在同名但不同内容的 Skill"
          description="UCLI 不会覆盖该目录。请取消选择对应 CLI，或先处理现有冲突。"
        />

        <a-form-item label="确保可用于">
          <a-checkbox-group v-model:value="installDraft.targets" :options="targetOptions" :disabled="skills.saving" @change="clearPreview" />
          <div class="skills-help">OpenCode 和 U-Code 可能通过兼容目录继承，不会重复投放相同内容。</div>
        </a-form-item>
        <a-form-item label="安装范围">
          <a-radio-group v-model:value="installDraft.scopeType" :disabled="skills.saving" @change="clearPreview">
            <a-radio value="user">用户级（所有项目）</a-radio>
            <a-radio value="project">项目级</a-radio>
          </a-radio-group>
        </a-form-item>
        <a-form-item v-if="installDraft.scopeType === 'project'" label="项目">
          <a-input v-model:value="installDraft.projectPath" readonly placeholder="请选择项目目录" />
          <a-button class="skills-picker-actions" :disabled="skills.saving" @click="chooseInstallProject">选择项目</a-button>
        </a-form-item>
      </a-form>
      <template #footer>
        <div class="drawer-footer">
          <a-button :disabled="skills.saving" @click="installOpen = false">取消</a-button>
          <a-button type="primary" :loading="skills.saving" :disabled="!canInstall || skills.saving" @click="install">{{ installActionLabel }}</a-button>
        </div>
      </template>
    </a-drawer>

    <a-drawer v-model:open="detailOpen" title="Skill 详情" width="620">
      <template v-if="detailPackage">
        <a-descriptions :column="1" bordered size="small">
          <a-descriptions-item label="名称">{{ detailPackage.name }}</a-descriptions-item>
          <a-descriptions-item label="说明">{{ detailPackage.description }}</a-descriptions-item>
          <a-descriptions-item label="来源">{{ detailPackage.sourceLocator }}</a-descriptions-item>
          <a-descriptions-item label="提交" v-if="detailPackage.resolvedRevision"><span class="skills-mono">{{ detailPackage.resolvedRevision }}</span></a-descriptions-item>
        </a-descriptions>
        <h4>兼容性与实际可见性</h4>
        <div v-for="adapter in skills.adapters" :key="adapter.id" class="detail-row">
          <strong>{{ adapter.displayName }}</strong>
          <span>{{ skillVisibilitySummary(detailPackage.visibility[adapter.id]) }}</span>
        </div>
        <h4>投放位置</h4>
        <div v-for="item in detailPackage.installations" :key="item.id" class="skills-path">{{ item.targetPath }}</div>
        <h4>文件</h4>
        <a-list size="small" bordered :data-source="detailPackage.fileList">
          <template #renderItem="{ item }"><a-list-item><span class="skills-mono">{{ item }}</span></a-list-item></template>
        </a-list>
        <a-alert type="info" show-icon message="UCLI 只管理投放副本，不会执行 Skill 中的脚本。" />
      </template>
    </a-drawer>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { message, Modal } from 'ant-design-vue'

import { ipc } from '../ipc.js'
import {
  aggregateSkillCatalog,
  buildPluginCopyInstallRequest,
  buildSkillCollectionInstallRequests,
  buildSkillInstallRequest,
  buildSourceProjectCliSummary,
  buildSkillCliMatrix,
  canConfirmSkillInstall,
  createLatestRequestGuard,
  dshSkillSourcePresentation,
  filterSkillCatalog,
  groupSkillCatalogBySourceProject,
  resolveSkillCollectionInstallSelection,
  resolveSkillInstallPreflight,
  skillCliName,
  skillInstallAffectedInstallationIds,
  skillOriginLabel,
  skillPackageApplyTargets,
  skillSourceKindLabel,
  skillSourceLabel,
  skillStatusPresentation
} from '../skillsPresentation.js'
import { useSkillsStore } from '../stores/skills.js'
import { useServerConnectionStore } from '../stores/serverConnection.js'

const skills = useSkillsStore()
const serverConnection = useServerConnectionStore()
const projectPath = ref('')
const search = ref('')
const cliFilter = ref('all')
const statusFilter = ref('all')
const scopeFilter = ref('all')
const showBuiltIn = ref(false)
const installOpen = ref(false)
const detailOpen = ref(false)
const detailPackage = ref(null)
const sourceProjectDetailKey = ref(null)
const skillDetailSelection = ref(null)
const sourcePreview = ref(null)
const inspecting = ref(false)
const collectionSelectedSubdirs = ref([])
const batchInstallResult = ref(null)
const inspectionGuard = createLatestRequestGuard()

const installDraft = reactive({
  sourceType: 'local', localPath: '', gitUrl: '', refType: 'default', ref: '', subdir: '',
  targets: ['claude', 'codex', 'opencode', 'ucode', 'deepseek-harness'], scopeType: 'user', projectPath: ''
})
const serverSkillTargets = reactive({ targetAdapterIds: ['codex'], scopeType: 'user', projectPath: '' })
const canUseServerSkillTargets = computed(() => serverSkillTargets.targetAdapterIds.length > 0 &&
  (serverSkillTargets.scopeType === 'user' || Boolean(serverSkillTargets.projectPath.trim())))

const catalog = computed(() => aggregateSkillCatalog({
  packages: skills.packages,
  discovered: skills.discovered,
  includeBuiltIn: showBuiltIn.value
}))
const userInstalledCatalog = computed(() => aggregateSkillCatalog({
  packages: skills.packages,
  discovered: skills.discovered
}))
const visibleCatalog = computed(() => filterSkillCatalog(catalog.value, {
  search: search.value,
  adapterId: cliFilter.value,
  status: 'all',
  scopeType: scopeFilter.value
}))
const sourceProjects = computed(() => groupSkillCatalogBySourceProject(visibleCatalog.value, { status: statusFilter.value }))
const detailSourceProject = computed(() =>
  sourceProjects.value.find(item => item.key === sourceProjectDetailKey.value) || null
)
const sourceProjectDetailOpen = computed({
  get: () => Boolean(detailSourceProject.value),
  set: (open) => {
    if (!open) {
      sourceProjectDetailKey.value = null
      skillDetailSelection.value = null
    }
  }
})
const detailEntry = computed(() => {
  const selection = skillDetailSelection.value
  if (!selection) return null
  const group = sourceProjects.value.find(item => item.key === selection.sourceProjectKey)
  return group?.entries.find(item => item.key === selection.entryKey) || null
})
const skillDetailOpen = computed({
  get: () => Boolean(detailEntry.value),
  set: (open) => {
    if (!open) skillDetailSelection.value = null
  }
})
const visibleSkillCount = computed(() => sourceProjects.value.reduce((count, group) => count + group.entries.length, 0))
const metrics = computed(() => [
  { label: '用户安装', value: userInstalledCatalog.value.length },
  { label: '受管 Skills', value: skills.summary.managedPackages },
  { label: '可用更新', value: skills.summary.updates },
  { label: '待处理冲突', value: skills.summary.conflicts }
])
const cliOptions = computed(() => [{ value: 'all', label: '全部 CLI' }, ...skills.adapters.map(item => ({ value: item.id, label: item.displayName }))])
const statusOptions = [
  { value: 'all', label: '全部状态' },
  { value: 'ready', label: '可用' },
  { value: 'update_available', label: '有更新' },
  { value: 'drifted', label: '外部修改' },
  { value: 'conflict', label: '冲突' },
  { value: 'disabled', label: '已停用' },
  { value: 'missing', label: '文件缺失' },
  { value: 'mirror', label: '兼容镜像' },
  { value: 'invalid', label: 'Skill 无效' },
  { value: 'broken_link', label: '链接失效' }
]
const scopeOptions = [
  { value: 'all', label: '全部范围' },
  { value: 'user', label: '用户级' },
  { value: 'project', label: '项目级' },
  { value: 'system', label: '系统' }
]
const refTypeOptions = [
  { value: 'default', label: '默认分支' },
  { value: 'branch', label: '分支' },
  { value: 'tag', label: '标签（固定）' },
  { value: 'commit', label: '提交（固定）' }
]
const targetOptions = computed(() => skills.adapters
  .filter(item => !item.virtual)
  .map(item => ({ value: item.id, label: item.displayName })))
const collectionSkillOptions = computed(() => sourcePreview.value?.kind === 'collection'
  ? sourcePreview.value.skills.map((item) => ({
      value: item.subdir,
      label: `${item.name} · ${item.subdir}`
    }))
  : [])
const collectionSelectionState = computed(() => resolveSkillCollectionInstallSelection({
  preview: sourcePreview.value,
  selectedSubdirs: collectionSelectedSubdirs.value,
  inspecting: inspecting.value,
  sourceType: installDraft.sourceType,
  targetAdapterIds: installDraft.targets,
  scopeType: installDraft.scopeType,
  projectPath: installDraft.projectPath
}))
const collectionBlockedDescription = computed(() => collectionSelectionState.value.blockedSkills
  .map(({ skill, reason }) => {
    const label = {
      duplicate_name: '集合中存在同名 Skill',
      incompatible: '与所选 CLI 不兼容',
      target_conflict: '目标位置存在冲突',
      source_changed: '已安装来源内容发生变化',
      inspecting: '正在检查'
    }[reason] || '未通过安装预检'
    return `${skill.name}：${label}`
  })
  .join('；'))

const sourceReady = computed(() => installDraft.sourceType === 'local' ? Boolean(installDraft.localPath) : Boolean(installDraft.gitUrl))
const installPreflight = computed(() => resolveSkillInstallPreflight(sourcePreview.value || {}, {
  scopeType: installDraft.scopeType,
  projectPath: installDraft.projectPath,
  targetAdapterIds: installDraft.targets
}))
const installPreflightMissingNames = computed(() => installPreflight.value.missingAdapterIds
  .map((adapterId) => skills.adapters.find((item) => item.id === adapterId)?.displayName || adapterId)
  .join('、'))
const installActionLabel = computed(() => {
  if (sourcePreview.value?.kind === 'collection') {
    if (skills.saving && skills.batchProgress) {
      return `正在安装 ${skills.batchProgress.total} 个 Skills`
    }
    return `安装 ${collectionSelectionState.value.selectedSkills.length} 个 Skills`
  }
  if (installPreflight.value.kind === 'existing_target') return '确认接管'
  if (installPreflight.value.kind !== 'already_installed') return '确认安装'
  return installPreflight.value.missingAdapterIds.length ? '应用到所选 CLI' : '完成'
})
const canInstall = computed(() => sourcePreview.value?.kind === 'collection'
  ? collectionSelectionState.value.canInstall
  : canConfirmSkillInstall({
      preview: sourcePreview.value,
      inspecting: inspecting.value,
      sourceType: installDraft.sourceType,
      subdir: installDraft.subdir,
      targetAdapterIds: installDraft.targets,
      scopeType: installDraft.scopeType,
      projectPath: installDraft.projectPath,
      preflightKind: installPreflight.value.kind
    }))

function sourceRequest() {
  return installDraft.sourceType === 'local'
    ? { type: 'local', path: installDraft.localPath }
    : {
        type: 'git', url: installDraft.gitUrl, refType: installDraft.refType,
        ref: installDraft.refType === 'default' ? '' : installDraft.ref, subdir: installDraft.subdir
      }
}
function clearPreview() {
  inspectionGuard.invalidate()
  sourcePreview.value = null
  collectionSelectedSubdirs.value = []
  batchInstallResult.value = null
  inspecting.value = false
}
function formatBytes(value) { return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB` }
function scopeLabel(scopeType) { return scopeType === 'project' ? '项目级' : scopeType === 'user' ? '用户级' : '系统' }
function sourceHealthColor(health) { return ['broken_link', 'invalid'].includes(health) ? 'red' : 'green' }
function sourceHealthLabel(health, link) {
  if (health === 'broken_link') return '链接失效'
  if (health === 'invalid') return 'Skill 无效'
  return link ? '有效链接' : '正常'
}
function hasDistinctPhysicalPath(source) {
  return Boolean(source.link && source.resolvedPath && source.resolvedPath !== (source.entryPath || source.path))
}
function openSkillDetail(sourceProjectKey, entry) {
  skillDetailSelection.value = { sourceProjectKey, entryKey: entry.key }
}
function openSourceProjectDetail(sourceProject) {
  sourceProjectDetailKey.value = sourceProject.key
}
async function openSourceProject(sourceProject) {
  const opened = await ipc.openExternal(sourceProject.repositoryUrl)
  if (!opened) message.error('无法打开项目地址')
}

async function reload() { await skills.load(projectPath.value) }
async function syncOrganizationSkills() {
  try {
    await serverConnection.ensureSkillsFresh({ force: true })
    await serverConnection.loadCachedSkills()
    await skills.load(projectPath.value)
  } catch { message.error(serverConnection.skillsCatalogError?.message || '无法同步组织 Skills') }
}
async function chooseServerSkillProject() {
  const selected = await ipc.pickDirectory()
  if (selected) serverSkillTargets.projectPath = selected
}
function organizationSkillTargets() {
  return {
    targetAdapterIds: [...serverSkillTargets.targetAdapterIds],
    scopeType: serverSkillTargets.scopeType,
    projectPath: serverSkillTargets.scopeType === 'project' ? serverSkillTargets.projectPath : ''
  }
}
async function installOrganizationSkill(item) {
  try {
    await serverConnection.installSkill(item.versionId, organizationSkillTargets())
    await skills.load(projectPath.value)
  } catch { message.error(serverConnection.skillsCatalogError?.message || '组织 Skill 安装失败') }
}
async function updateOrganizationSkill(item) {
  try {
    await serverConnection.updateSkill(item.versionId, organizationSkillTargets())
    await skills.load(projectPath.value)
  } catch { message.error(serverConnection.skillsCatalogError?.message || '组织 Skill 更新失败') }
}
async function chooseProject() {
  const selected = await ipc.pickDirectory()
  if (!selected) return
  projectPath.value = selected
  await reload()
}
async function clearProject() { projectPath.value = ''; await reload() }
function openInstall() {
  installDraft.scopeType = projectPath.value ? 'project' : 'user'
  installDraft.projectPath = projectPath.value
  sourcePreview.value = null
  collectionSelectedSubdirs.value = []
  batchInstallResult.value = null
  installOpen.value = true
}
async function chooseLocalDirectory() {
  const selected = await ipc.pickDirectory()
  if (selected) { installDraft.localPath = selected; clearPreview() }
}
async function chooseArchive() {
  const selected = await ipc.pickSkillArchive()
  if (selected) { installDraft.localPath = selected; clearPreview() }
}
async function chooseInstallProject() {
  const selected = await ipc.pickDirectory()
  if (selected) { installDraft.projectPath = selected; clearPreview() }
}
async function inspectSource() {
  const requestId = inspectionGuard.begin()
  const source = sourceRequest()
  inspecting.value = true
  try {
    const preview = await skills.inspectSource(source, {
      targetAdapterIds: [...installDraft.targets],
      scopeType: installDraft.scopeType,
      projectPath: installDraft.scopeType === 'project' ? installDraft.projectPath : ''
    })
    if (!inspectionGuard.isCurrent(requestId)) return
    sourcePreview.value = preview
    if (preview.kind === 'collection') {
      const available = new Set(preview.skills.map((item) => item.subdir))
      collectionSelectedSubdirs.value = collectionSelectedSubdirs.value.filter((subdir) => available.has(subdir))
    } else {
      collectionSelectedSubdirs.value = []
    }
  } catch (error) {
    if (!inspectionGuard.isCurrent(requestId)) return
    message.error(error?.message || '无法读取 Skill 来源')
  } finally {
    if (inspectionGuard.isCurrent(requestId)) inspecting.value = false
  }
}
function toggleCollectionSelectAll(event) {
  collectionSelectedSubdirs.value = event.target.checked
    ? sourcePreview.value.skills.map((item) => item.subdir)
    : []
}
function collectionSkillName(subdir) {
  return sourcePreview.value?.skills?.find((item) => item.subdir === subdir)?.name || subdir.split('/').at(-1)
}
async function installCollection() {
  batchInstallResult.value = null
  const requests = buildSkillCollectionInstallRequests({
    preview: sourcePreview.value,
    selectedSubdirs: collectionSelectedSubdirs.value,
    source: sourceRequest(),
    targetAdapterIds: installDraft.targets,
    scopeType: installDraft.scopeType,
    projectPath: installDraft.projectPath
  })
  const result = await skills.installMany(requests)
  batchInstallResult.value = result
  const affectedIds = result.installed.flatMap((item) => skillInstallAffectedInstallationIds(item.result))
  if (result.failed.length || result.aborted || result.refreshError) {
    collectionSelectedSubdirs.value = [
      ...result.failed.map((item) => item.request.source.subdir),
      ...(result.aborted?.skippedRequests || []).map((item) => item.source.subdir)
    ]
    if (result.aborted) {
      message.warning(`已完成 ${result.installed.length} 个 Skill；本地数据保存待确认，批次已中止。`)
      await inspectSource()
    } else if (result.failed.length) {
      message.warning(`已完成 ${result.installed.length} 个 Skill，${result.failed.length} 个安装失败；失败项已保留选择。`)
      await inspectSource()
    } else {
      message.warning(`已完成 ${result.installed.length} 个 Skill，但列表刷新失败；安装结果已保留。`)
    }
  } else {
    installOpen.value = false
    message.success(`已完成 ${result.installed.length} 个 Skills`)
  }
  await promptRestart(affectedIds)
}
async function install() {
  try {
    if (sourcePreview.value?.kind === 'collection') {
      await installCollection()
      return
    }
    const pkg = await skills.install(buildSkillInstallRequest({
      source: sourceRequest(), targetAdapterIds: installDraft.targets,
      scopeType: installDraft.scopeType, projectPath: installDraft.projectPath
    }))
    installOpen.value = false
    if (pkg.installOutcome?.kind === 'already_installed') {
      message.info('Skill 已安装，无需重复安装')
      return
    }
    if (pkg.installOutcome?.kind === 'applied_existing') {
      const applied = pkg.installOutcome.appliedAdapterIds
      const names = applied.map((adapterId) => skills.adapters.find((item) => item.id === adapterId)?.displayName || adapterId)
      message.success(`已复用现有 Skill，并应用到 ${names.join('、')}`)
      await promptRestart(pkg.installations.filter((item) => applied.includes(item.targetAdapterId)).map((item) => item.id))
      return
    }
    if (pkg.installOutcome?.kind === 'adopted_existing') {
      message.success('已识别并接管现有相同 Skill，未重复写入文件')
      const applied = pkg.installOutcome.appliedAdapterIds || []
      if (applied.length) {
        await promptRestart(pkg.installations.filter((item) => applied.includes(item.targetAdapterId)).map((item) => item.id))
      }
      return
    }
    message.success('Skill 已安装')
    await promptRestart(pkg.installations.map(item => item.id))
  } catch (error) { message.error(error?.message || '安装失败') }
}
async function sessionsFor(installationIds) { return skills.getAffectedSessions(installationIds) }
async function promptRestart(installationIds, knownSessions = null) {
  const sessions = knownSessions || await sessionsFor(installationIds)
  if (!sessions.length) return
  Modal.confirm({
    title: '重启受影响会话？',
    content: `有 ${sessions.length} 个会话需要重启后才能可靠使用新的 Skill。当前任务不会自动中断。`,
    okText: '重启会话', cancelText: '稍后处理',
    async onOk() {
      const result = await skills.restartSessions(sessions.map(item => item.id))
      const failed = result.filter(item => !item.restarted).length
      if (failed) message.warning(`${failed} 个会话未能重启`)
      else message.success('会话已重启')
    }
  })
}
async function toggleInstallation(item, enabled) {
  const affected = await sessionsFor([item.id])
  try {
    await skills.setEnabled(item.id, enabled)
    message.success(enabled ? 'Skill 已启用' : 'Skill 已停用')
    await promptRestart([], affected)
  } catch (error) { message.error(error?.message || '操作失败') }
}
function cliCellColor(state) {
  return {
    managed: 'purple', inherited: 'cyan', external: 'blue', disabled: 'default', builtin: 'default',
    drifted: 'orange', missing: 'red', invalid: 'red'
  }[state] || 'default'
}
function handleCliAction(entry, cell) {
  if (cell.action === 'install_copy') {
    confirmInstallPluginCopy(entry, cell)
    return
  }
  if (cell.action === 'enable') {
    toggleInstallation(cell.installation, true)
    return
  }
  confirmApplyToAdapter(entry, cell)
}
function confirmInstallPluginCopy(entry, cell) {
  const request = buildPluginCopyInstallRequest(cell.copySource, cell.adapterId, projectPath.value)
  if (!request) {
    message.error(cell.copySource?.scopeType === 'project' ? '请先选择插件所属项目' : '插件 Skill 的物理目录不可用')
    return
  }
  Modal.confirm({
    title: `为 ${cell.displayName} 安装“${entry.name}”独立副本？`,
    content: 'UCLI 会从当前 Claude 插件目录创建受管快照并投放到目标 CLI；不会修改插件目录，也不会覆盖目标位置已有的同名 Skill。',
    okText: '安装独立副本',
    cancelText: '取消',
    async onOk() {
      try {
        const pkg = await skills.install(request)
        message.success(`独立副本已安装到 ${cell.displayName}`)
        await promptRestart(pkg.installations.map(item => item.id))
      } catch (error) {
        if (error?.code === 'SKILL_TARGET_CONFLICT') {
          message.error(`${cell.displayName} 已存在同名 Skill，UCLI 未进行覆盖`)
          return
        }
        message.error(error?.message || '安装独立副本失败')
      }
    }
  })
}
function packageApplyTargets(pkg, entry) {
  return skillPackageApplyTargets(pkg, skills.adapters)
}
function applyPackageToAdapter(entry, pkg, adapterId) {
  const adapter = skills.adapters.find(item => item.id === adapterId)
  if (!adapter) return
  const visibility = pkg.visibility?.[adapterId]
  confirmApplyToAdapter(entry, {
    adapterId,
    displayName: adapter.displayName,
    packageId: pkg.id,
    state: visibility?.visible ? 'inherited' : 'unavailable',
    actionLabel: visibility?.visible ? '直接应用' : '应用'
  })
}
function confirmApplyToAdapter(entry, cell) {
  const detail = cell.state === 'inherited'
    ? '当前已通过兼容目录可用；继续后会在目标 CLI 的标准目录创建一份直接投放。'
    : cell.state === 'external'
      ? '目标位置已有相同 Skill。内容一致时会纳入当前受管包；内容不同时不会覆盖。'
      : 'UCLI 会在目标 CLI 的标准目录创建受管投放，不会覆盖已有的不同内容。'
  Modal.confirm({
    title: `将“${entry.name}”应用到 ${cell.displayName}？`,
    content: detail,
    okText: cell.actionLabel,
    cancelText: '取消',
    async onOk() {
      try {
        const pkg = await skills.applyToAdapter(cell.packageId, cell.adapterId)
        const installation = pkg.installations.find(item => item.targetAdapterId === cell.adapterId)
        message.success(`已应用到 ${cell.displayName}`)
        if (installation) await promptRestart([installation.id])
      } catch (error) {
        message.error(error?.message || '应用失败')
      }
    }
  })
}
function confirmRemove(item) {
  Modal.confirm({
    title: '移除此投放？',
    content: '只删除 UCLI 管理的投放副本；其他位置的现有 Skills 不会受影响。',
    okText: '移除', okType: 'danger', cancelText: '取消',
    async onOk() {
      const affected = await sessionsFor([item.id])
      await skills.removeInstallation(item.id)
      message.success('投放已移除')
      await promptRestart([], affected)
    }
  })
}
function confirmResolveDrift(item, resolution) {
  Modal.confirm({
    title: resolution === 'restore' ? '恢复 UCLI 保存的版本？' : '接纳当前外部修改？',
    content: resolution === 'restore'
      ? '当前投放目录会恢复为 UCLI 保存的受管原件。'
      : '当前目录将成为新的受管原件，并同步到该 Skill 的其他投放位置。',
    okText: resolution === 'restore' ? '确认恢复' : '确认接纳',
    cancelText: '取消',
    async onOk() {
      const affected = await sessionsFor([item.id])
      await skills.resolveDrift(item.id, resolution)
      message.success(resolution === 'restore' ? '已恢复 UCLI 版本' : '已接纳当前修改')
      await promptRestart([], affected)
    }
  })
}
function confirmAdopt(source) {
  Modal.confirm({
    title: `接管“${source.name}”？`,
    content: 'UCLI 会保存一份受管原件。接管后，启停、更新和卸载将由 UCLI 负责。',
    okText: '确认接管', cancelText: '取消',
    async onOk() {
      const pkg = await skills.adopt({
        path: source.path, targetAdapterId: source.adapterId, scopeType: source.scopeType,
        projectPath: source.scopeType === 'project' ? projectPath.value : ''
      })
      message.success('Skill 已接管')
      await promptRestart(pkg.installations.map(item => item.id))
    }
  })
}
async function checkUpdates() {
  const results = await skills.checkUpdates()
  const count = results.filter(item => item.updateAvailable).length
  message.info(count ? `发现 ${count} 个更新` : '暂未发现更新')
}
async function previewAndUpdate(pkg) {
  try {
    const preview = await skills.previewUpdate(pkg.id)
    if (!preview.updateable) { message.info('该来源不支持更新'); return }
    if (!preview.hasChanges) { message.success('当前已是最新内容'); return }
    Modal.confirm({
      title: `更新“${pkg.name}”？`,
      content: `新增 ${preview.addedFiles.length} 个文件，修改 ${preview.changedFiles.length} 个文件，移除 ${preview.removedFiles.length} 个文件。${preview.skillMdChanged ? 'SKILL.md 已发生变化，请重点核对。' : ''}更新失败时会保留当前版本。`,
      okText: '确认更新', cancelText: '取消',
      async onOk() {
        const affected = await sessionsFor(pkg.installations.map(item => item.id))
        await skills.update(pkg.id, preview.fromRevision)
        message.success('Skill 已更新')
        await promptRestart([], affected)
      }
    })
  } catch (error) { message.error(error?.message || '检查更新失败') }
}
function openDetail(pkg) { detailPackage.value = pkg; detailOpen.value = true }

function refreshOrganizationSkillsOnFocus() {
  void serverConnection.ensureSkillsFresh().catch(() => {})
}

onMounted(async () => {
  await reload()
  refreshOrganizationSkillsOnFocus()
  window.addEventListener('focus', refreshOrganizationSkillsOnFocus)
  if (!skills.lastCheckedAt || Date.now() - skills.lastCheckedAt > 24 * 60 * 60 * 1000) {
    skills.checkUpdates().catch(() => {})
  }
})

onUnmounted(() => window.removeEventListener('focus', refreshOrganizationSkillsOnFocus))
</script>

<style scoped>
.skills-center { max-width: 1240px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
.skills-heading, .skills-project-row, .skills-catalog-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.skills-heading h2 { margin: 0 0 4px; font-size: 22px; }
.skills-heading p { margin: 0; color: #6b7280; }
.skills-project-card, .skills-metric, .skill-card { border-radius: 10px; }
.skills-metric-value { font-size: 26px; font-weight: 700; color: #531dab; }
.skills-muted, .skills-help { color: #8c8c8c; font-size: 12px; }
.skills-filters { display: grid; grid-template-columns: minmax(220px, 1fr) repeat(3, 130px) auto auto; align-items: center; gap: 10px; }
.skills-built-in-toggle { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
.skills-catalog-heading { margin: 2px 0 12px; }
.skills-source-projects { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 16px; }
.skills-source-project { border: 1px solid #f0f0f0; border-radius: 12px; background: #fafafa; }
.skill-aggregate-card { height: 100%; cursor: pointer; transition: transform 0.18s ease, box-shadow 0.18s ease; }
.skill-aggregate-card:hover { transform: translateY(-2px); }
.skills-source-project-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; }
.skill-aggregate-cli-summary { padding-top: 12px; border-top: 1px solid #f0f0f0; }
.skill-aggregate-cli-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 8px; }
.skill-aggregate-cli-cell { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px; border: 1px solid #f0f0f0; border-radius: 7px; background: #fafafa; font-size: 12px; }
.skill-aggregate-cli-cell.is-all { border-color: #b7eb8f; background: #f6ffed; }
.skill-aggregate-cli-cell.is-partial { border-color: #91caff; background: #e6f4ff; }
.skills-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 14px; }
.skill-card-summary { height: 100%; cursor: pointer; transition: transform 0.18s ease, box-shadow 0.18s ease; }
.skill-card-summary:hover { transform: translateY(-2px); }
.skill-card-summary :deep(.ant-card-body) { display: flex; min-height: 236px; flex-direction: column; }
.skill-card-title { display: flex; align-items: center; gap: 8px; }
.skill-description { min-height: 42px; color: #595959; }
.skill-meta-row, .skill-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.skill-meta-row { color: #8c8c8c; font-size: 12px; }
.skill-card-cli-summary { margin-top: 14px; padding-top: 12px; border-top: 1px solid #f0f0f0; }
.skill-card-cli-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 8px; }
.skill-card-cli-cell { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 6px; padding: 7px 8px; border: 1px solid #f0f0f0; border-radius: 7px; background: #fafafa; font-size: 12px; }
.skill-card-cli-cell.is-managed { border-color: #d3adf7; background: #f9f0ff; }
.skill-card-cli-cell.is-inherited { border-color: #87e8de; background: #e6fffb; }
.skill-card-cli-cell.is-external { border-color: #91caff; background: #e6f4ff; }
.skill-card-cli-cell.is-drifted { border-color: #ffd591; background: #fff7e6; }
.skill-card-cli-cell.is-missing, .skill-card-cli-cell.is-invalid, .skill-card-cli-cell.is-broken_link { border-color: #ffa39e; background: #fff1f0; }
.skill-card-open-hint { margin-top: auto; padding-top: 12px; color: #531dab; font-size: 12px; text-align: right; }
.skill-installations { margin: 14px 0; border-top: 1px solid #f0f0f0; }
.skill-source-heading { padding-top: 12px; color: #595959; font-weight: 600; }
.skill-installation-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid #f0f0f0; }
.skill-source-row { align-items: flex-start; }
.skill-source-details { min-width: 0; flex: 1; }
.skill-plugin-id { margin-top: 6px; color: #595959; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.skill-source-alert { margin-top: 8px; }
.skill-location .skill-installation-row { border-bottom: 0; }
.skill-location { border-bottom: 1px solid #f0f0f0; }
.skill-drift-actions { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 8px 0; }
.skill-cli-section { margin-top: 14px; padding-top: 12px; border-top: 1px solid #f0f0f0; }
.skill-cli-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 8px; }
.skill-cli-matrix { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.skill-cli-cell { min-height: 96px; padding: 10px; border: 1px solid #f0f0f0; border-radius: 8px; background: #fafafa; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
.skill-cli-cell.is-managed { border-color: #d3adf7; background: #f9f0ff; }
.skill-cli-cell.is-inherited { border-color: #87e8de; background: #e6fffb; }
.skill-cli-cell.is-external { border-color: #91caff; background: #e6f4ff; }
.skill-cli-name { font-weight: 600; }
.skill-cli-cell .ant-btn { height: auto; padding: 0; margin-top: auto; }
.skill-package-actions { margin-top: 14px; border-top: 1px solid #f0f0f0; }
.skill-package-action-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding-top: 10px; }
.skills-path, .skills-mono { font-family: 'Cascadia Code', Consolas, monospace; font-size: 12px; word-break: break-all; }
.skills-path { color: #8c8c8c; margin-top: 5px; }
.skills-picker-actions { margin-top: 8px; }
.source-preview { margin: 14px 0; }
.source-preview p { margin: 4px 0; color: #595959; }
.skills-collection-controls { display: flex; justify-content: space-between; align-items: center; margin: 10px 0 8px; }
.skills-inline-alert { margin-top: 10px; }
.skills-batch-result { line-height: 1.6; word-break: break-word; }
.skills-batch-result-success { color: #237804; }
.skills-batch-result-failure { color: #a8071a; }
.drawer-footer { display: flex; justify-content: flex-end; gap: 8px; }
.detail-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f0f0f0; }
h4 { margin: 20px 0 8px; }
@media (max-width: 1000px) {
  .skills-filters { grid-template-columns: 1fr 1fr; }
  .skill-cli-matrix { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 520px) {
  .skills-source-projects, .skills-grid { grid-template-columns: 1fr; }
}
</style>
