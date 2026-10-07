<script setup lang="ts">
/** /report 连戏核对报告与结构版本导出：本地库版本查看与 JSON 导入导出 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Download } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import ConflictTag from '@/components/common/ConflictTag.vue'
import ImportBackupDialog from '@/components/import/ImportBackupDialog.vue'
import { db, countAll, exportSnapshot, resetDatabase, DB_NAME, DB_SCHEMA_VERSION, type ConflictRow } from '@/utils/db'
import {
  TABLE_KEYS,
  TABLE_LABEL,
  deleteImportJob,
  listImportJobs,
  recoverInterruptedJobs,
  type ImportJobRow
} from '@/utils/importFlow'
import { useIdbTable } from '@/hooks/useIdbTable'
import { buildReport, downloadJson, riskScore, serializeReport, type ContinuityReport } from '@/utils/export'
import type { FilterModel } from '@/types/filter'
import { filtersToQuery } from '@/utils/query'

const route = useRoute()
const router = useRouter()

const { rows: conflicts } = useIdbTable<ConflictRow>(() => db.conflicts)
const report = ref<ContinuityReport | null>(null)
const dbCounts = ref<Record<string, number>>({})
const filters = ref<FilterModel>({ keyword: '' })
const preview = ref('')
const importDialogVisible = ref(false)
const activeJobId = ref<string | null>(null)
const importJobs = ref<ImportJobRow[]>([])

const JOB_STATUS_LABEL: Record<ImportJobRow['status'], string> = {
  prechecked: '预检通过待导入',
  writing: '写入中',
  succeeded: '已导入（可回滚）',
  rolled_back: '已回滚（可重试）',
  failed: '失败待处理'
}

const JOB_STATUS_TYPE: Record<ImportJobRow['status'], 'info' | 'warning' | 'success' | 'danger' | 'primary'> = {
  prechecked: 'warning',
  writing: 'primary',
  succeeded: 'success',
  rolled_back: 'info',
  failed: 'danger'
}

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

function openImportDialog(jobId?: string): void {
  activeJobId.value = jobId ?? null
  importDialogVisible.value = true
}

async function refreshJobs(): Promise<void> {
  importJobs.value = await listImportJobs()
}

async function removeJob(jobId: string): Promise<void> {
  await deleteImportJob(jobId)
  await refreshJobs()
}

function jobQuarantineCount(job: ImportJobRow): number {
  return job.quarantined.length
}

function jobAcceptedCount(job: ImportJobRow): number {
  return TABLE_KEYS.reduce((sum, key) => sum + job.acceptedCount[key], 0)
}

function jobTableSummary(): string {
  return TABLE_KEYS.map((key) => TABLE_LABEL[key]).join(' / ')
}

async function importLibrary(): Promise<void> {
  openImportDialog()
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

onMounted(async () => {
  void refresh()
  // 恢复上次因关闭页面 / 浏览器崩溃而停在写入中途的导入（自动回滚到导入前，保留草稿）
  const recovered = await recoverInterruptedJobs()
  await refreshJobs()
  if (recovered.length > 0) {
    ElMessage.warning(`检测到 ${recovered.length} 个导入中途退出，已恢复到导入前，可在草稿中重试`)
  }
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

    <!-- 导入草稿：预检通过待导入 / 写入中 / 失败回滚后可重试 / 已导入可回滚 -->
    <el-card v-if="importJobs.length > 0" shadow="never" class="jobs-card">
      <template #header>
        <div class="card-title">
          <span>备份导入草稿</span>
          <span class="muted">预检结论与导入前快照都在本机留档，刷新页面也不丢</span>
        </div>
      </template>
      <el-table :data="importJobs" border size="small">
        <el-table-column prop="fileName" label="备份文件" min-width="180" show-overflow-tooltip />
        <el-table-column label="结构版本" width="90" align="center">
          <template #default="{ row }">v{{ row.sourceSchemaVersion }}</template>
        </el-table-column>
        <el-table-column label="可写入 / 隔离" width="120" align="center">
          <template #default="{ row }">
            {{ jobAcceptedCount(row) }} /
            <span :class="jobQuarantineCount(row) > 0 ? 'danger-text' : ''">{{ jobQuarantineCount(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="150">
          <template #default="{ row }">
            <el-tag :type="JOB_STATUS_TYPE[row.status as ImportJobRow['status']]" size="small">
              {{ JOB_STATUS_LABEL[row.status as ImportJobRow['status']] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="lastError" label="最近信息" min-width="200" show-overflow-tooltip />
        <el-table-column label="操作" width="180" align="center">
          <template #default="{ row }">
            <el-button link type="primary" @click="openImportDialog(row.id)">
              {{ row.status === 'succeeded' ? '查看 / 回滚' : row.status === 'prechecked' ? '继续导入' : '查看 / 重试' }}
            </el-button>
            <el-button link type="danger" @click="removeJob(row.id)">删除草稿</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="muted jobs-hint">分表：{{ jobTableSummary() }}</div>
    </el-card>

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
            <el-button type="primary" @click="importLibrary">导入备份（预检后分批落地）</el-button>
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

    <ImportBackupDialog
      v-model="importDialogVisible"
      :job-id="activeJobId"
      @imported="refresh"
      @job-changed="refreshJobs"
    />
  </div>
</template>

<style scoped>
.btn-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.jobs-card {
  margin: 16px 0;
}
.jobs-hint {
  margin-top: 8px;
}
.danger-text {
  color: var(--el-color-danger);
  font-weight: 600;
}
</style>
