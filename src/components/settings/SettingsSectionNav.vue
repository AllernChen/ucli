<template>
  <nav class="settings-section-nav" aria-label="设置分区">
    <a-menu
      class="settings-section-nav__desktop"
      mode="inline"
      :selected-keys="[model]"
      @select="selectDesktopSection"
    >
      <a-menu-item
        v-for="section in SETTINGS_SECTIONS"
        :key="section.id"
      >
        {{ section.label }}
      </a-menu-item>
    </a-menu>

    <a-select
      v-model:value="model"
      class="settings-section-nav__mobile"
      aria-label="选择设置分区"
    >
      <a-select-option
        v-for="section in SETTINGS_SECTIONS"
        :key="section.id"
        :value="section.id"
      >
        {{ section.label }}
      </a-select-option>
    </a-select>
  </nav>
</template>

<script setup>
import { SETTINGS_SECTIONS } from '../../settingsSections.js'

const model = defineModel({ type: String, required: true })

function selectDesktopSection({ key }) {
  model.value = key
}
</script>

<style scoped>
.settings-section-nav {
  position: sticky;
  top: 0;
  z-index: 2;
  align-self: start;
  background: #f5f5f5;
}

.settings-section-nav__desktop {
  border-inline-end: 0;
  background: transparent;
}

.settings-section-nav__mobile {
  display: none;
  width: 100%;
}

@media (max-width: 899px) {
  .settings-section-nav {
    padding-bottom: 12px;
  }

  .settings-section-nav__desktop {
    display: none;
  }

  .settings-section-nav__mobile {
    display: block;
  }
}
</style>
