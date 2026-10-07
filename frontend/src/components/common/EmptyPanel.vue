<script setup lang="ts">
/** EmptyPanel：空数据引导与新建入口，被全部列表页消费 */
import { Plus } from '@element-plus/icons-vue'

withDefaults(
  defineProps<{
    title?: string
    description?: string
    showCreate?: boolean
    createText?: string
  }>(),
  {
    title: '暂无数据',
    description: '先新建一条记录，或调整筛选条件后再试。',
    showCreate: true,
    createText: '新建'
  }
)

const emit = defineEmits<{ (event: 'create'): void }>()
</script>

<template>
  <div class="empty-panel">
    <div class="empty-panel__icon">🎬</div>
    <h3 class="empty-panel__title">{{ title }}</h3>
    <p class="empty-panel__desc">{{ description }}</p>
    <div class="empty-panel__actions">
      <el-button v-if="showCreate" type="primary" :icon="Plus" @click="emit('create')">{{ createText }}</el-button>
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.empty-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 40px 16px;
  background: #fbfcfe;
  border: 1px dashed #cfdce8;
  border-radius: 12px;
  text-align: center;
}

.empty-panel__icon {
  font-size: 30px;
}

.empty-panel__title {
  margin: 0;
  font-size: 16px;
  color: #2b3a47;
}

.empty-panel__desc {
  margin: 0;
  font-size: 13px;
  color: #8c8479;
}

.empty-panel__actions {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}
</style>
