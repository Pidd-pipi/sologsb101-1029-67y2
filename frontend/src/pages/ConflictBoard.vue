<script setup lang="ts">
/** /conflicts 连戏差异比对与冲突提示：并排展示两次记录、标记严重程度与解决状态 */
import { computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import ConflictTag from '@/components/common/ConflictTag.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { db, type ConflictRow, type ElementRow, type RecordRow, type SceneRow, type ShootDayRow } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useContinuityDiff } from '@/hooks/useContinuityDiff'
import { useConflictStore } from '@/stores/conflictStore'
import { CONFLICT_SEVERITIES, CONFLICT_STATES } from '@/types/conflict'
import { SEVERITY_WEIGHT } from '@/utils/diff'
import type { FilterSelectConfig, FilterModel } from '@/types/filter'
import { filtersToQuery } from '@/utils/query'

const route = useRoute()
const router = useRouter()
const store = useConflictStore()

const { rows: conflicts, ready } = useIdbTable<ConflictRow>(() => db.conflicts, {
  compare: (a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]
})
const { rows: records } = useIdbTable<RecordRow>(() => db.records)
const { rows: elements } = useIdbTable<ElementRow>(() => db.elements)
const { rows: scenes } = useIdbTable<SceneRow>(() => db.scenes, { compare: (a, b) => a.shootOrder - b.shootOrder })
const { rows: shootDays } = useIdbTable<ShootDayRow>(() => db.shootDays)

/** 现场记录的字段级比对结果（差异页与现场记录页共用） */
const diff = useContinuityDiff(records, elements, shootDays)

const selects: FilterSelectConfig[] = [
  { key: 'severities', label: '严重程度', options: CONFLICT_SEVERITIES.map((item) => ({ label: item, value: item })) },
  { key: 'states', label: '处理状态', options: CONFLICT_STATES.map((item) => ({ label: item, value: item })) }
]

function recordOf(id: string): RecordRow | null {
  return records.value.find((item) => item.id === id) ?? null
}

function elementOf(elementId: string): ElementRow | null {
  return elements.value.find((item) => item.id === elementId) ?? null
}

function sceneLabelOf(elementId: string): string {
  const element = elementOf(elementId)
  if (!element) return '要素已删除'
  const scene = scenes.value.find((item) => item.id === element.sceneId)
  return scene ? `第 ${scene.sceneNo} 场 · ${scene.location}` : '场次已删除'
}

function dayLabelOf(record: RecordRow | null): string {
  if (!record) return '记录已删除'
  return shootDays.value.find((item) => item.id === record.shootDayId)?.date ?? '未知拍摄日'
}

const filtered = computed(() => {
  const keyword = String(store.filters.keyword ?? '').trim().toLowerCase()
  const severities = Array.isArray(store.filters.severities) ? store.filters.severities : []
  const states = Array.isArray(store.filters.states) ? store.filters.states : []
  return conflicts.value
    .filter((conflict) => {
      const element = elementOf(conflict.elementId)
      const label = `${element ? element.name : ''} ${conflict.diffDesc}`.toLowerCase()
      if (keyword && !label.includes(keyword)) return false
      if (severities.length > 0 && !severities.includes(conflict.severity)) return false
      if (states.length > 0 && !states.includes(conflict.state)) return false
      return true
    })
    .sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity])
})

const totals = computed(() => {
  const open = conflicts.value.filter((item) => item.state === '待确认')
  return {
    total: conflicts.value.length,
    open: open.length,
    resolved: conflicts.value.filter((item) => item.state === '已解决').length,
    blocking: open.filter((item) => item.severity === '阻断').length,
    criticalElementCount: elements.value.filter((item) => item.critical).length,
    pendingCandidates: diff.diffCount.value
  }
})

/** 重新比对：把当前所有要素最近两次记录的差异写入差异表（已存在的不重复生成） */
async function regenerate(): Promise<void> {
  if (diff.candidates.value.length === 0) {
    ElMessage.info('当前没有可生成的差异（每个要素至少需要两次现场记录）')
    return
  }
  const created = await store.generate(diff.candidates.value)
  ElMessage.success(created > 0 ? `本次新生成 ${created} 条差异` : '差异已是新的，无需重复生成')
}

async function resolve(conflict: ConflictRow): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('请填写处理说明，确认后会把要素初始状态回写为最新现场状态', '消解冲突', {
      inputValue: '已按现场实际状态统一并留痕',
      confirmButtonText: '确认解决',
      cancelButtonText: '取消'
    })
    await store.resolve(conflict.id, value)
    ElMessage.success('冲突已解决并回写要素状态')
  } catch (error) {
    if (error instanceof Error && error.message) ElMessage.error(error.message)
  }
}

async function reopen(conflict: ConflictRow): Promise<void> {
  await store.reopen(conflict.id)
  ElMessage.success('已重新打开为待确认')
}

async function remove(conflict: ConflictRow): Promise<void> {
  try {
    await ElMessageBox.confirm('删除该差异条目不改变现场记录，是否继续？', '删除确认', { type: 'warning' })
  } catch {
    return
  }
  await store.remove(conflict.id)
  ElMessage.success('差异条目已删除')
}

function onFilterChange(next: FilterModel): void {
  store.setFilters(next)
}

onMounted(() => {
  store.applyQuery(route.query)
})

watch(
  () => store.filters,
  (value) => {
    void router.replace({ path: route.path, query: filtersToQuery(value) })
  },
  { deep: true }
)
</script>

<template>
  <div class="page">
    <div class="page__head">
      <div>
        <h2 class="page__title">连戏差异比对与冲突提示</h2>
        <p class="page__subtitle">同一要素取最近两次现场记录做字段级比对（状态文本会做颜色/款式同义归一）。</p>
      </div>
      <el-button type="primary" :icon="Refresh" @click="regenerate">重新比对生成差异</el-button>
    </div>

    <div class="badge-row">
      <StatBadge label="差异条目" :value="totals.total" suffix="条" icon="Files" tone="primary" />
      <StatBadge label="待确认" :value="totals.open" suffix="条" icon="WarningFilled" tone="danger" />
      <StatBadge label="已解决" :value="totals.resolved" suffix="条" icon="Grid" tone="success" />
      <StatBadge label="阻断级" :value="totals.blocking" suffix="条" icon="WarningFilled" tone="warning" />
      <StatBadge label="可比对候选" :value="totals.pendingCandidates" suffix="条" icon="DataLine" tone="info" />
    </div>

    <FilterBar
      :model-value="store.filters"
      :selects="selects"
      keyword-placeholder="搜索要素 / 差异描述…"
      @update:model-value="onFilterChange"
      @reset="store.resetFilters()"
    />

    <EmptyPanel
      v-if="ready && filtered.length === 0"
      title="还没有差异条目"
      description="先在现场记录页为同一要素留下至少两次记录，然后点「重新比对生成差异」。"
      :show-create="false"
    />

    <el-table v-else :data="filtered" border stripe row-key="id">
      <el-table-column label="连戏要素" min-width="170">
        <template #default="{ row }">
          <div>{{ elementOf(row.elementId)?.name ?? '要素已删除' }}</div>
          <div class="muted">
            {{ elementOf(row.elementId)?.category ?? '—' }} ·
            {{ elementOf(row.elementId)?.critical ? '关键要素' : '一般要素' }}
          </div>
          <div class="muted">{{ sceneLabelOf(row.elementId) }}</div>
        </template>
      </el-table-column>
      <el-table-column label="记录 A（较早）" min-width="190">
        <template #default="{ row }">
          <div class="muted">{{ dayLabelOf(recordOf(row.recordIdA)) }} · 镜次 {{ recordOf(row.recordIdA)?.takeNo ?? '—' }}</div>
          <div>{{ recordOf(row.recordIdA)?.currentState ?? '记录已删除' }}</div>
        </template>
      </el-table-column>
      <el-table-column label="记录 B（较晚）" min-width="190">
        <template #default="{ row }">
          <div class="muted">{{ dayLabelOf(recordOf(row.recordIdB)) }} · 镜次 {{ recordOf(row.recordIdB)?.takeNo ?? '—' }}</div>
          <div>{{ recordOf(row.recordIdB)?.currentState ?? '记录已删除' }}</div>
        </template>
      </el-table-column>
      <el-table-column prop="diffDesc" label="差异描述" min-width="240" />
      <el-table-column label="严重程度 / 状态" width="170">
        <template #default="{ row }">
          <ConflictTag :severity="row.severity" :state="row.state" />
        </template>
      </el-table-column>
      <el-table-column label="解决留痕" min-width="180">
        <template #default="{ row }">
          <template v-if="row.state === '已解决'">
            <div>{{ row.resolvedNote }}</div>
            <div class="muted">{{ row.resolvedAt ? row.resolvedAt.slice(0, 19).replace('T', ' ') : '' }}</div>
          </template>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="180" fixed="right">
        <template #default="{ row }">
          <el-button v-if="row.state === '待确认'" link type="success" size="small" @click="resolve(row)">解决</el-button>
          <el-button v-else link type="warning" size="small" @click="reopen(row)">重开</el-button>
          <el-button link type="danger" size="small" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>
