<script setup lang="ts">
/**
 * 导入写入进度：清空 → 五表分批写入的总进度与当前表状态；
 * 失败回滚阶段同组件复用（stage=restoring）。
 */
import { computed } from 'vue'
import { TABLE_LABELS } from '@/types/importDraft'
import type { ImportProgress } from '@/types/importDraft'

const props = defineProps<{
  progress: ImportProgress
}>()

const stageText = computed(() => {
  switch (props.progress.stage) {
    case 'clearing':
      return '正在清空旧数据（单事务，失败不会动本机数据）'
    case 'writing':
      return props.progress.table
        ? `正在写入${TABLE_LABELS[props.progress.table]}（第 ${props.progress.tableIndex + 1}/${props.progress.tableCount} 张表）`
        : '正在写入'
    case 'restoring':
      return props.progress.table
        ? `正在用导入前留底恢复${TABLE_LABELS[props.progress.table]}（第 ${props.progress.tableIndex + 1}/${props.progress.tableCount} 张表）`
        : '正在恢复导入前数据'
  }
})

const statusType = computed(() => (props.progress.stage === 'restoring' ? 'warning' : 'success'))
</script>

<template>
  <div class="import-progress">
    <el-progress
      :percentage="Math.min(progress.percent, 100)"
      :status="statusType"
      :stroke-width="18"
      text-inside
    />
    <p class="import-progress__text">{{ stageText }}</p>
    <p v-if="progress.stage !== 'clearing' && progress.totalRows > 0" class="import-progress__sub muted">
      本表 {{ progress.doneRows }} / {{ progress.totalRows }} 行 · 每批 100 行独立事务
    </p>
  </div>
</template>

<style scoped>
.import-progress {
  padding: 8px 0;
}
.import-progress__text {
  margin: 10px 0 2px;
  font-size: 13px;
}
.import-progress__sub {
  margin: 0;
  font-size: 12px;
}
.muted {
  color: var(--el-text-color-secondary);
}
</style>
