<script setup lang="ts">
/** /report 连戏核对报告与结构版本导出：本地库版本查看与 JSON 导入导出 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Download, Upload } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import ConflictTag from '@/components/common/ConflictTag.vue'
import { db, countAll, exportSnapshot, resetDatabase, DB_NAME, DB_SCHEMA_VERSION, type ConflictRow } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { buildReport, downloadJson, riskScore, serializeReport, type ContinuityReport } from '@/utils/export'
import ImportBackupDialog from '@/components/import/ImportBackupDialog.vue'
import { useImportStore } from '@/stores/importStore'
import type { FilterModel } from '@/types/filter'
import { filtersToQuery } from '@/utils/query'

const route = useRoute()
const router = useRouter()
const importStore = useImportStore()

const { rows: conflicts } = useIdbTable<ConflictRow>(() => db.conflicts)
const report = ref<ContinuityReport | null>(null)
const dbCounts = ref<Record<string, number>>({})
const filters = ref<FilterModel>({ keyword: '' })
const preview = ref('')

const totals = computed(() => {
  const open = conflicts.value.filter((item) => item.state === '待确认')
  return {
    total: conflicts.value.length,
    open: open.length,
    resolved: conflicts.value.filter((item) => item.state === '已解决').length,
    blocking: open.filter((item) => item.severity === '阻断').length,
    risk: riskScore(open)
  }
})

const rows = computed(() => {
  const list = report.value?.summary.rows ?? []
  const keyword = String(filters.value.keyword ?? '').trim().toLowerCase()
  if (!keyword) return list
  return list.filter((row) =>
    `${row.sceneNo} ${row.location} ${row.place} ${row.timeOfDay}`.toLowerCase().includes(keyword)
  )
})

async function refresh(): Promise<void> {
  report.value = await buildReport()
  dbCounts.value = await countAll()
  preview.value = serializeReport(report.value)
}

async function exportReport(): Promise<void> {
  const current = await buildReport()
  downloadJson(`连戏核对报告-${current.exportedAt.slice(0, 10)}.json`, serializeReport(current))
  ElMessage.success('连戏核对报告已下载')
}

async function exportLibrary(): Promise<void> {
  const snapshot = await exportSnapshot()
  downloadJson(`gbcontinuity-备份-${snapshot.exportedAt.slice(0, 10)}.json`, JSON.stringify(snapshot, null, 2))
  ElMessage.success('本地库已导出为 JSON')
}

async function importLibrary(): Promise<void> {
  // 导入全程在对话框内完成：预检 → 隔离待修 → 导入前留底 → 分批写入 → 失败回滚/重试
  importStore.openDialog()
}

async function onImportClosed(): Promise<void> {
  // liveQuery 会自动刷新差异列表，报告小结需手动重算
  await refresh()
}

async function resetDemo(): Promise<void> {
  try {
    await ElMessageBox.confirm('将清空本地库并重新灌入演示数据，是否继续？', '重置确认', { type: 'warning' })
  } catch {
    return
  }
  await resetDatabase()
  await refresh()
  ElMessage.success('已重置为演示数据')
}

function onFilterChange(next: FilterModel): void {
  filters.value = next
}

onMounted(() => {
  void refresh()
  if (typeof route.query.keyword === 'string') filters.value.keyword = route.query.keyword
})

watch(filters, (value) => {
  void router.replace({ path: route.path, query: filtersToQuery(value) })
}, { deep: true })

</script>

<template>
  <div class="page">
    <div class="page__head">
      <div>
        <h2 class="page__title">连戏核对报告与结构版本导出</h2>
        <p class="page__subtitle">
          本地库 {{ DB_NAME }}（结构版本 v{{ DB_SCHEMA_VERSION }}）· 报告含场次小结、要素清单、现场记录与差异明细。
        </p>
      </div>
      <div>
        <el-button :icon="Download" @click="exportLibrary">导出整库备份</el-button>
        <el-button type="primary" :icon="Download" @click="exportReport">导出核对报告</el-button>
      </div>
    </div>

    <div class="badge-row">
      <StatBadge label="差异条目" :value="totals.total" suffix="条" icon="Files" tone="primary" />
      <StatBadge label="未解决" :value="totals.open" suffix="条" icon="WarningFilled" tone="danger" />
      <StatBadge label="已解决" :value="totals.resolved" suffix="条" icon="Grid" tone="success" />
      <StatBadge label="阻断级" :value="totals.blocking" suffix="条" icon="WarningFilled" tone="warning" />
      <StatBadge label="风险分" :value="totals.risk" suffix="分" icon="TrendCharts" tone="info" />
    </div>

    <FilterBar
      :model-value="filters"
      keyword-placeholder="搜索场号 / 地点 / 内外景…"
      :show-reset="true"
      @update:model-value="onFilterChange"
      @reset="filters = { keyword: '' }"
    />

    <el-card v-if="report" shadow="never">
      <template #header>
        <div class="card-title">
          <span>场次核对小结</span>
          <span class="muted">
            场次 {{ report.summary.sceneCount }} · 要素 {{ report.summary.elementCount }} · 现场记录 {{ report.summary.recordCount }} ·
            风险最高场次 第 {{ report.summary.riskiestSceneNo }} 场
          </span>
        </div>
      </template>
      <EmptyPanel
        v-if="rows.length === 0"
        title="没有匹配的场次"
        description="调整关键字后重试，或先到「剧本场次」页新建场次。"
        :show-create="false"
      />
      <el-table v-else :data="rows" border stripe>
        <el-table-column prop="sceneNo" label="场号" width="90" />
        <el-table-column label="内外景 / 时间" width="130">
          <template #default="{ row }">
            <ConflictTag :state="row.state" />
            <div class="muted">{{ row.place }} · {{ row.timeOfDay }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="location" label="地点" min-width="140" />
        <el-table-column prop="elementCount" label="要素数" width="90" align="right" />
        <el-table-column prop="criticalElementCount" label="关键要素" width="100" align="right" />
        <el-table-column label="未解决冲突" width="120" align="right">
          <template #default="{ row }">
            <el-tag :type="row.openConflictCount > 0 ? 'danger' : 'success'" size="small" effect="plain">
              {{ row.openConflictCount }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="resolvedConflictCount" label="已解决" width="90" align="right" />
        <el-table-column prop="shootDayCount" label="拍摄日" width="90" align="right" />
      </el-table>
    </el-card>

    <el-row :gutter="16">
      <el-col :span="12">
        <el-card shadow="never">
          <template #header>
            <div class="card-title"><span>本地结构版本</span><span class="muted">IndexedDB</span></div>
          </template>
          <el-descriptions :column="2" border size="small">
            <el-descriptions-item label="库名">{{ DB_NAME }}</el-descriptions-item>
            <el-descriptions-item label="结构版本">v{{ DB_SCHEMA_VERSION }}</el-descriptions-item>
            <el-descriptions-item label="场次/要素">{{ dbCounts.scenes ?? 0 }} / {{ dbCounts.elements ?? 0 }}</el-descriptions-item>
            <el-descriptions-item label="拍摄日/记录">{{ dbCounts.shootDays ?? 0 }} / {{ dbCounts.records ?? 0 }}</el-descriptions-item>
            <el-descriptions-item label="差异">{{ dbCounts.conflicts ?? 0 }}</el-descriptions-item>
            <el-descriptions-item label="导出时间">{{ report?.exportedAt.slice(0, 19).replace('T', ' ') ?? '—' }}</el-descriptions-item>
          </el-descriptions>
          <div class="btn-row">
            <el-button :icon="Upload" @click="importLibrary">导入备份</el-button>
            <el-button type="danger" plain @click="resetDemo">重置演示数据</el-button>
            <el-button @click="refresh">刷新报告</el-button>
          </div>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card shadow="never">
          <template #header>
            <div class="card-title"><span>报告 JSON 预览</span><span class="muted">可直接复制</span></div>
          </template>
          <el-input v-model="preview" type="textarea" :rows="12" readonly />
        </el-card>
      </el-col>
    </el-row>

    <ImportBackupDialog @finished="onImportClosed" />
  </div>
</template>

<style scoped>
.btn-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
</style>
