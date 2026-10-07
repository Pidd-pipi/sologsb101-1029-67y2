<script setup lang="ts">
/**
 * 整库备份导入向导（换设备交接用）：
 * 第 1 步选择/粘贴备份；第 2 步预检结论（版本升级、新增/覆盖/删除计数、
 * 悬空现场记录等隔离清单、本机指纹）；第 3 步分批写入进度，失败自动回滚并保留可重试草稿。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Download, UploadFilled } from '@element-plus/icons-vue'
import {
  TABLE_KEYS,
  TABLE_LABEL,
  beginImport,
  createImportJob,
  currentFingerprint,
  deleteImportJob,
  getImportJob,
  precheckBackup,
  refreshJobPrecheck,
  retryImport,
  rollbackImport,
  BackupFormatError,
  StalePrecheckError,
  type ImportJobRow,
  type ImportProgress,
  type PrecheckResult,
  type QuarantineEntry,
  type TableKey
} from '@/utils/importFlow'
import { downloadJson } from '@/utils/export'

const props = defineProps<{ modelValue: boolean; jobId?: string | null }>()
const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'imported'): void
  (e: 'jobChanged'): void
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
})

const step = ref(0)
const loading = ref(false)
const rawText = ref('')
const fileName = ref('')
const parseError = ref('')
const job = ref<ImportJobRow | null>(null)
const result = ref<PrecheckResult | null>(null)
const fingerprintFresh = ref(true)
const importing = ref(false)
const progress = ref<ImportProgress | null>(null)
const failedMessage = ref('')
const confirmReplace = ref(false)
const openQuarantineGroups = ref<TableKey[]>([])

const totalAccepted = computed(() => TABLE_KEYS.reduce((sum, key) => sum + (result.value?.acceptedCount[key] ?? 0), 0))
const totalAdded = computed(() => TABLE_KEYS.reduce((sum, key) => sum + (result.value?.addedCount[key] ?? 0), 0))
const totalUpdated = computed(() => TABLE_KEYS.reduce((sum, key) => sum + (result.value?.updatedCount[key] ?? 0), 0))
const totalDeleted = computed(() => TABLE_KEYS.reduce((sum, key) => sum + (result.value?.deletedCount[key] ?? 0), 0))
const totalQuarantined = computed(() => result.value?.quarantined.length ?? job.value?.quarantined.length ?? 0)

const dangerIssues = computed(() => (result.value ?? job.value)?.issues.filter((item) => item.level === 'danger') ?? [])
const warningIssues = computed(() => (result.value ?? job.value)?.issues.filter((item) => item.level === 'warning') ?? [])

const countTable = computed(() =>
  TABLE_KEYS.map((key) => ({
    key,
    local: result.value?.localCount[key] ?? 0,
    accepted: result.value?.acceptedCount[key] ?? job.value?.acceptedCount[key] ?? 0,
    added: result.value?.addedCount[key] ?? job.value?.addedCount[key] ?? 0,
    updated: result.value?.updatedCount[key] ?? job.value?.updatedCount[key] ?? 0,
    deleted: result.value?.deletedCount[key] ?? job.value?.deletedCount[key] ?? 0
  }))
)

const groupedQuarantine = computed<Array<{ table: TableKey; label: string; items: QuarantineEntry[] }>>(() => {
  const list = result.value?.quarantined ?? job.value?.quarantined ?? []
  return TABLE_KEYS.map((table) => ({
    table,
    label: TABLE_LABEL[table],
    items: list.filter((item) => item.table === table)
  })).filter((group) => group.items.length > 0)
})

watch(groupedQuarantine, (groups) => {
  openQuarantineGroups.value = groups.map((group) => group.table)
})

const phaseLabel = computed(() => {
  const p = progress.value
  if (!p) return ''
  switch (p.phase) {
    case 'snapshot':
      return '正在留存导入前整套数据…'
    case 'clearing':
      return '正在清空待替换的本机台账…'
    case 'writing':
      return `正在写入${p.table ? TABLE_LABEL[p.table] : ''}（${p.written}/${p.total}）`
    case 'rolling-back':
      return `写入失败，正在恢复导入前数据（${p.written}/${p.total}）…`
    case 'done':
      return '写入完成'
  }
})

function resetState(): void {
  step.value = 0
  loading.value = false
  rawText.value = ''
  fileName.value = ''
  parseError.value = ''
  job.value = null
  result.value = null
  fingerprintFresh.value = true
  importing.value = false
  progress.value = null
  failedMessage.value = ''
  confirmReplace.value = false
}

watch(visible, async (open) => {
  if (!open) return
  if (props.jobId) {
    await loadJob(props.jobId)
  } else {
    resetState()
  }
})

watch(
  () => props.jobId,
  async (id) => {
    if (visible.value && id) await loadJob(id)
  }
)

function resultFromJob(row: ImportJobRow): PrecheckResult {
  return {
    sourceSchemaVersion: row.sourceSchemaVersion,
    upgraded: false,
    accepted: row.accepted,
    acceptedCount: row.acceptedCount,
    addedCount: row.addedCount,
    updatedCount: row.updatedCount,
    deletedCount: row.deletedCount,
    quarantined: row.quarantined,
    issues: row.issues,
    localFingerprint: row.localFingerprint,
    localCount: { ...{ scenes: 0, elements: 0, shootDays: 0, records: 0, conflicts: 0 } }
  }
}

async function loadJob(id: string): Promise<void> {
  resetState()
  loading.value = true
  try {
    const row = await getImportJob(id)
    if (!row) {
      ElMessage.error('导入草稿已不存在')
      visible.value = false
      return
    }
    job.value = row
    result.value = resultFromJob(row)
    rawText.value = row.rawText
    fileName.value = row.fileName
    await refreshFingerprint()
    if (row.status === 'succeeded' || row.status === 'rolled_back' || row.status === 'failed') {
      step.value = 2
      if (row.status !== 'succeeded') failedMessage.value = row.lastError
      progress.value = row.status === 'succeeded'
        ? { phase: 'done', table: '', written: 0, total: 0, percent: 100 }
        : null
    } else {
      step.value = 1
    }
  } finally {
    loading.value = false
  }
}

async function refreshFingerprint(): Promise<void> {
  const fingerprint = job.value?.localFingerprint ?? result.value?.localFingerprint
  if (!fingerprint) {
    fingerprintFresh.value = true
    return
  }
  fingerprintFresh.value = (await currentFingerprint()) === fingerprint
}

function onFilePicked(uploadFile: { raw: File }): void {
  parseError.value = ''
  const reader = new FileReader()
  reader.onload = () => {
    rawText.value = String(reader.result ?? '')
    fileName.value = uploadFile.raw.name
  }
  reader.onerror = () => {
    parseError.value = '读取备份文件失败，请重试或改用粘贴'
  }
  reader.readAsText(uploadFile.raw, 'utf-8')
}

async function runPrecheck(): Promise<void> {
  if (!rawText.value.trim()) {
    parseError.value = '请先选择备份文件或粘贴备份 JSON 内容'
    return
  }
  loading.value = true
  parseError.value = ''
  try {
    const pre = await precheckBackup(rawText.value)
    result.value = pre
    fingerprintFresh.value = true
    step.value = 1
    if (job.value) {
      await refreshJobPrecheck(job.value.id, pre)
      job.value = await getImportJob(job.value.id) ?? job.value
    }
  } catch (error) {
    if (error instanceof BackupFormatError) {
      parseError.value = error.message
    } else {
      parseError.value = error instanceof Error ? error.message : '预检失败'
    }
  } finally {
    loading.value = false
  }
}

async function rePrecheck(): Promise<void> {
  await runPrecheck()
}

const startButtonEnabled = computed(() => {
  if (!result.value || totalAccepted.value === 0) return false
  if (!fingerprintFresh.value) return false
  if ((totalDeleted.value > 0 || totalUpdated.value > 0) && !confirmReplace.value) return false
  return true
})

async function confirmAndStart(): Promise<void> {
  if (!result.value) return
  if (!job.value) {
    const jobId = await createImportJob(fileName.value || '粘贴的备份内容', rawText.value, result.value)
    job.value = (await getImportJob(jobId)) ?? null
  }
  emit('jobChanged')
  await startImport()
}

async function startImport(): Promise<void> {
  if (!job.value) return
  await refreshFingerprint()
  if (!fingerprintFresh.value) {
    ElMessage.error('本机台账在预检后发生过改动，请先重新预检')
    return
  }
  step.value = 2
  importing.value = true
  failedMessage.value = ''
  progress.value = { phase: 'snapshot', table: '', written: 0, total: 0, percent: 0 }
  try {
    await beginImport(job.value.id, (p) => {
      progress.value = p
    })
    job.value = (await getImportJob(job.value.id)) ?? job.value
    result.value = job.value ? resultFromJob(job.value) : result.value
    ElMessage.success('备份已整库导入，导入前数据已留存，可在需要时回滚')
    emit('imported')
    emit('jobChanged')
  } catch (error) {
    job.value = (await getImportJob(job.value.id)) ?? job.value
    if (error instanceof StalePrecheckError) {
      fingerprintFresh.value = false
      failedMessage.value = error.message
    } else {
      failedMessage.value = job.value?.lastError || (error instanceof Error ? error.message : '导入失败')
    }
    ElMessage.error(`导入失败，已恢复到导入前：${failedMessage.value}`)
    emit('jobChanged')
  } finally {
    importing.value = false
  }
}

async function doRetry(): Promise<void> {
  if (!job.value) return
  importing.value = true
  failedMessage.value = ''
  progress.value = { phase: 'snapshot', table: '', written: 0, total: 0, percent: 0 }
  try {
    await retryImport(job.value.id, (p) => {
      progress.value = p
    })
    job.value = (await getImportJob(job.value.id)) ?? job.value
    ElMessage.success('重试成功，备份已整库导入')
    emit('imported')
    emit('jobChanged')
  } catch (error) {
    job.value = (await getImportJob(job.value.id)) ?? job.value
    failedMessage.value = error instanceof StalePrecheckError
      ? error.message
      : job.value?.lastError || (error instanceof Error ? error.message : '重试失败')
    if (error instanceof StalePrecheckError) fingerprintFresh.value = false
    ElMessage.error(`重试失败：${failedMessage.value}`)
    emit('jobChanged')
  } finally {
    importing.value = false
  }
}

async function doRollback(): Promise<void> {
  if (!job.value) return
  importing.value = true
  failedMessage.value = ''
  try {
    await rollbackImport(job.value.id, (p) => {
      progress.value = p
    })
    job.value = (await getImportJob(job.value.id)) ?? job.value
    ElMessage.success('已恢复到导入前的数据')
    emit('imported')
    emit('jobChanged')
  } catch (error) {
    failedMessage.value = error instanceof Error ? error.message : '回滚失败'
    ElMessage.error(failedMessage.value)
  } finally {
    importing.value = false
  }
}

async function discardJob(): Promise<void> {
  if (job.value) await deleteImportJob(job.value.id)
  visible.value = false
  emit('jobChanged')
}

function downloadQuarantine(): void {
  const entries = result.value?.quarantined ?? job.value?.quarantined ?? []
  downloadJson(
    `gbcontinuity-隔离待修-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(
      entries.map((item) => ({ table: item.table, index: item.index, id: item.id, label: item.label, reason: item.reason, raw: item.raw })),
      null,
      2
    )
  )
}

const statusTagType: Record<ImportJobRow['status'], 'info' | 'warning' | 'success' | 'danger' | 'primary'> = {
  prechecked: 'warning',
  writing: 'primary',
  succeeded: 'success',
  rolled_back: 'info',
  failed: 'danger'
}

const statusLabel: Record<ImportJobRow['status'], string> = {
  prechecked: '预检通过，待导入',
  writing: '正在写入',
  succeeded: '已导入',
  rolled_back: '已回滚到导入前（可重试）',
  failed: '失败（草稿待处理）'
}
</script>

<template>
  <el-dialog
    v-model="visible"
    title="导入整库备份（预检 → 留档 → 分批落地）"
    width="860px"
    top="6vh"
    :close-on-click-modal="false"
  >
    <el-steps :active="step" align-center finish-status="success" class="steps">
      <el-step title="选择备份" description="文件或粘贴 JSON" />
      <el-step title="预检" description="版本/必填/引用核对" />
      <el-step title="导入" description="分批写入·失败回滚" />
    </el-steps>

    <!-- 第 1 步：选择备份 -->
    <div v-if="step === 0" class="panel">
      <el-upload drag :auto-upload="false" :show-file-list="false" accept=".json,application/json" :on-change="onFilePicked">
        <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
        <div class="el-upload__text">把备份 JSON 拖到这里，或<em>点击选择文件</em></div>
      </el-upload>
      <el-input
        v-model="rawText"
        type="textarea"
        :rows="8"
        class="mt-12"
        placeholder="也可以直接粘贴整库备份 JSON 文本"
      />
      <div v-if="fileName" class="muted mt-8">已选择：{{ fileName }}</div>
      <div v-if="parseError" class="error-text mt-8">{{ parseError }}</div>
      <div class="mt-12 tip-box">
        预检只读不写：读取结构版本、逐表核对必填字段与跨表引用，对不上的行只隔离不入库；
        旧数据缺少修订号会按当前结构回填。确认无误后才会留存本机数据并分批写入。
      </div>
    </div>

    <!-- 第 2 步：预检结果 -->
    <div v-else-if="step === 1 && result" class="panel">
      <div class="pre-head">
        <el-tag type="success" effect="dark">预检完成</el-tag>
        <el-tag v-if="job" :type="statusTagType[job.status]">{{ statusLabel[job.status] }}</el-tag>
        <span class="muted">
          备份结构版本 v{{ result.sourceSchemaVersion }}
          <template v-if="result.upgraded">（旧版，落地时升级到当前结构）</template>
          · 文件：{{ fileName }}
        </span>
      </div>

      <el-alert
        v-if="!fingerprintFresh"
        type="error"
        :closable="false"
        show-icon
        title="本机台账在预检之后发生过改动，这份预检结果已作废"
        description="请用原始备份内容重新预检（不需要关窗口），确认与当前台账的差异后再导入。"
        class="mt-12"
      >
        <el-button type="primary" size="small" :loading="loading" @click="rePrecheck">重新预检</el-button>
      </el-alert>

      <el-table :data="countTable" border size="small" class="mt-12">
        <el-table-column label="表" width="110">
          <template #default="{ row }">{{ TABLE_LABEL[row.key as TableKey] }}</template>
        </el-table-column>
        <el-table-column prop="local" label="本机现有" width="90" align="right" />
        <el-table-column prop="accepted" label="可写入" width="90" align="right" />
        <el-table-column label="其中新增" width="90" align="right">
          <template #default="{ row }"><span class="num-add">+{{ row.added }}</span></template>
        </el-table-column>
        <el-table-column label="其中覆盖" width="90" align="right">
          <template #default="{ row }"><span class="num-update">{{ row.updated }}</span></template>
        </el-table-column>
        <el-table-column label="本机将删" width="90" align="right">
          <template #default="{ row }"><span :class="row.deleted > 0 ? 'num-del' : ''">{{ row.deleted }}</span></template>
        </el-table-column>
      </el-table>

      <div class="summary-line mt-12">
        合计可写入 <b>{{ totalAccepted }}</b> 条（新增 <b class="num-add">{{ totalAdded }}</b>，覆盖 {{ totalUpdated }}），
        本机 {{ totalDeleted }} 条不在备份内将被替换；
        <b :class="totalQuarantined > 0 ? 'num-del' : ''">{{ totalQuarantined }}</b> 条隔离待修，不会写入。
      </div>

      <el-alert
        v-for="issue in dangerIssues"
        :key="issue.code + issue.message"
        type="error"
        :closable="false"
        show-icon
        :title="issue.message"
        class="mt-8"
      />
      <el-alert
        v-for="issue in warningIssues"
        :key="issue.code + issue.message"
        type="warning"
        :closable="false"
        show-icon
        :title="issue.message"
        class="mt-8"
      />

      <template v-if="groupedQuarantine.length > 0">
        <div class="quar-head mt-12">
          <span>隔离待修清单（这些行不会写入本机，修好后重新预检即可）</span>
          <el-button text type="primary" :icon="Download" @click="downloadQuarantine">下载隔离清单</el-button>
        </div>
        <el-collapse v-model="openQuarantineGroups" class="quar-collapse">
          <el-collapse-item
            v-for="group in groupedQuarantine"
            :key="group.table"
            :name="group.table"
            :title="`${group.label}（${group.items.length} 条）`"
          >
            <el-table :data="group.items" border size="small" max-height="220">
              <el-table-column prop="index" label="备份行号" width="80" align="right">
                <template #default="{ row }">{{ row.index + 1 }}</template>
              </el-table-column>
              <el-table-column prop="label" label="记录" min-width="160" />
              <el-table-column prop="reason" label="隔离原因" min-width="240" show-overflow-tooltip />
            </el-table>
          </el-collapse-item>
        </el-collapse>
      </template>

      <el-checkbox v-if="totalDeleted > 0 || totalUpdated > 0" v-model="confirmReplace" class="mt-12">
        我已知晓：导入会替换本机台账（覆盖 {{ totalUpdated }} 条、删除 {{ totalDeleted }} 条），落地前会自动留存导入前整套数据，可随时回滚
      </el-checkbox>
    </div>

    <!-- 第 3 步：导入 / 结果 -->
    <div v-else-if="step === 2" class="panel">
      <div v-if="job?.status === 'succeeded'" class="result-box success">
        <el-result icon="success" title="整库导入完成" sub-title="导入前的整套数据已随草稿留存，在删除草稿前随时可以回滚。">
          <template #extra>
            <el-button type="warning" plain :loading="importing" @click="doRollback">恢复到导入前</el-button>
          </template>
        </el-result>
      </div>

      <div v-else-if="job?.status === 'rolled_back' || job?.status === 'failed'" class="result-box">
        <el-result
          :icon="job?.status === 'failed' ? 'error' : 'warning'"
          :title="job?.status === 'failed' ? '导入失败' : '已恢复到导入前'"
          :sub-title="failedMessage || '本机数据完好，草稿已保留，修复问题后可直接重试（指纹仍一致时无需重新预检）。'"
        >
          <template #extra>
            <el-button type="primary" :loading="importing" :disabled="!fingerprintFresh" @click="doRetry">重试写入</el-button>
            <el-button @click="step = 1">回看预检结果</el-button>
            <el-button v-if="!fingerprintFresh" type="warning" :loading="loading" @click="rePrecheck">台账已变，重新预检</el-button>
          </template>
        </el-result>
      </div>

      <div v-else class="result-box">
        <p class="pre-head">
          <el-tag type="warning" effect="dark">待导入</el-tag>
          <span class="muted">共 {{ totalAccepted }} 条，分 {{ Math.max(1, Math.ceil(totalAccepted / 100)) }} 批写入</span>
        </p>
        <div v-if="!fingerprintFresh" class="error-text mt-8">
          本机台账在预检后发生过改动，请先
          <el-button link type="primary" :loading="loading" @click="rePrecheck">重新预检</el-button>
        </div>
      </div>

      <el-progress
        v-if="progress"
        :percentage="progress.percent"
        :status="progress.phase === 'rolling-back' ? 'warning' : progress.phase === 'done' ? 'success' : undefined"
        :stroke-width="18"
        text-inside
        class="mt-12"
      />
      <div v-if="progress" class="muted mt-8">{{ phaseLabel }}</div>
    </div>

    <template #footer>
      <div class="footer-row">
        <el-button v-if="job && step !== 0 && !importing" type="danger" plain @click="discardJob">放弃并删除草稿</el-button>
        <div class="footer-spacer" />
        <el-button @click="visible = false">{{ step === 2 && importing ? '后台继续' : '关闭' }}</el-button>
        <template v-if="step === 0">
          <el-button type="primary" :loading="loading" @click="runPrecheck">开始预检</el-button>
        </template>
        <template v-else-if="step === 1">
          <el-button @click="step = 0">重选备份</el-button>
          <el-button type="primary" :loading="loading" :disabled="!startButtonEnabled" @click="confirmAndStart">
            留存本机数据并开始分批导入
          </el-button>
        </template>
        <template v-else-if="!importing && job?.status === 'prechecked'">
          <el-button type="primary" :disabled="!fingerprintFresh" @click="startImport">开始写入</el-button>
        </template>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.steps {
  margin: 8px 0 20px;
}
.panel {
  min-height: 260px;
}
.mt-8 {
  margin-top: 8px;
}
.mt-12 {
  margin-top: 12px;
}
.muted {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.tip-box {
  background: var(--el-fill-color-light);
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  line-height: 1.6;
}
.error-text {
  color: var(--el-color-danger);
  font-size: 13px;
}
.pre-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.summary-line {
  font-size: 14px;
  line-height: 1.8;
}
.num-add {
  color: var(--el-color-success);
}
.num-update {
  color: var(--el-color-primary);
}
.num-del {
  color: var(--el-color-danger);
}
.quar-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
}
.quar-collapse {
  margin-top: 4px;
  border-top: 1px solid var(--el-border-color-lighter);
}
.result-box :deep(.el-result) {
  padding: 8px 0;
}
.footer-row {
  display: flex;
  align-items: center;
}
.footer-spacer {
  flex: 1;
}
</style>
