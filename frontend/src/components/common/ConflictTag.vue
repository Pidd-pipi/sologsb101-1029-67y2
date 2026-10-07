<script setup lang="ts">
/**
 * ConflictTag：按轻微 / 需处理 / 阻断与待确认 / 已解决渲染底色与图标。
 * 同时兼容场次状态（未拍 / 拍摄中 / 已过），被现场记录页、差异比对页与报告页消费。
 */
import { computed } from 'vue'
import type { Component } from 'vue'
import { CircleCheck, Clock, Flag, WarningFilled } from '@element-plus/icons-vue'

type Tone = 'primary' | 'success' | 'warning' | 'danger' | 'info'

interface TagStyle {
  tone: Tone
  icon: Component
  color: string
}

const props = withDefaults(
  defineProps<{
    /** 严重程度（轻微 / 需处理 / 阻断） */
    severity?: string
    /** 处理状态（待确认 / 已解决）或任意状态文案 */
    state?: string
    /** 是否显示图标 */
    showIcon?: boolean
  }>(),
  { severity: '', state: '', showIcon: true }
)

const STYLES: Record<string, TagStyle> = {
  轻微: { tone: 'info', icon: Flag, color: '#6b7c8c' },
  需处理: { tone: 'warning', icon: WarningFilled, color: '#d68910' },
  阻断: { tone: 'danger', icon: WarningFilled, color: '#c0392b' },
  待确认: { tone: 'warning', icon: Clock, color: '#d68910' },
  已解决: { tone: 'success', icon: CircleCheck, color: '#1e8449' },
  未拍: { tone: 'info', icon: Clock, color: '#6b7c8c' },
  拍摄中: { tone: 'warning', icon: Flag, color: '#d68910' },
  已过: { tone: 'success', icon: CircleCheck, color: '#1e8449' }
}

const severityStyle = computed<TagStyle>(() => STYLES[props.severity] ?? STYLES['轻微'])
const stateStyle = computed<TagStyle>(() => STYLES[props.state] ?? { tone: 'info', icon: Flag, color: '#6b7c8c' })
</script>

<template>
  <span class="conflict-tag">
    <el-tag v-if="severity" :type="severityStyle.tone" size="small" effect="dark" round>
      <el-icon v-if="showIcon" class="conflict-tag__icon"><component :is="severityStyle.icon" /></el-icon>
      {{ severity }}
    </el-tag>
    <el-tag v-if="state" :type="stateStyle.tone" size="small" effect="plain" round>
      <el-icon v-if="showIcon" class="conflict-tag__icon"><component :is="stateStyle.icon" /></el-icon>
      {{ state }}
    </el-tag>
  </span>
</template>

<style scoped>
.conflict-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.conflict-tag__icon {
  margin-right: 3px;
  font-size: 12px;
}
</style>
