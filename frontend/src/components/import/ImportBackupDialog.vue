<script setup lang="ts">
/**
 * 整库备份导入对话框（/report 页入口）：
 * 选择/粘贴备份 → 预检（结构版本、必填字段、跨表引用、旧结构回填）→ 隔离待修不写库
 * → 导入前自动留底 → 分批写入带进度 → 失败自动回滚、可重试；预检后台账有改动则作废重来。
 */
import { onBeforeUnmount, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { UploadFilled, WarningFilled, RefreshLeft, Download } from '@element-plus/icons-vue'
import type { UploadRequestOptions } from 'element-plus'
import { useImportStore } from '@/stores/importStore'
import ImportPrecheckPanel from './ImportPrecheckPanel.vue'
import ImportProgressPanel from './ImportProgressPanel.vue'
import { getPreImportSnapshot } from '@/utils/importRunner'
import type { PreImportSnapshot } from '@/types/importDraft'
import { downloadJson } from '@/utils/export'
import { nowIso } from '@/utils/uuid'

const importStore = useImportStore()

const emit = defineEmits<{
  /** 对话框完全关闭后通知页面刷新报告 */
  finished: []
}>()

const draftLoaded = ref(false)
const snapshot = ref<PreImportSnapshot | null>(null)

async function refreshSnapshot(): Promise<void> {
  snapshot.value = await getPreImportSnapshot()
}

async function onOpen(): Promise<void> {
  importStore.startPolling()
  await refreshSnapshot()
  if (!draftLoaded.value) {
    const draft = await importStore.loadDraft()
    if (draft) {
      await importStore.resumeDraft(draft)
      ElMessage.info(`已恢复上次未完成的导入草稿：${draft.fileName || '未命名备份'}`)
    }
    draftLoaded.value = true
  }
}

function onDialogClosed(): void {
  importStore.stopPolling()
  emit('finished')
}

function onVisibleChange(visible: boolean): void {
  if (!visible) void importStore.closeDialog()
}

async function readFile(options: UploadRequestOptions): Promise<void> {
  const file = options.file as File
  try {
    const text = await file.text()
    await importStore.setFile(file.name, text)
  } catch {
    ElMessage.error('读取备份文件失败')
  }
}

async function applyPasted(text: string): Promise<void> {
  await importStore.setFile(importStore.fileName || '粘贴的备份内容', text)
}

async function onConfirm(): Promise<void> {
  await importStore.confirmImport()
  await refreshSnapshot()
}

async function onRetry(): Promise<void> {
  await importStore.retryImport()
  await refreshSnapshot()
}

async function onRestore(): Promise<void> {
  await importStore.restoreFromSnapshot()
  await refreshSnapshot()
}

async function onDiscardDraft(): Promise<void> {
  await importStore.discardDraft()
  draftLoaded.value = false
}

async function recheck(): Promise<void> {
  await importStore.runCheck()
}

function downloadQuarantine(): void {
  const rows = importStore.exportQuarantined()
  if (rows.length === 0) return
  const payload = {
    name: 'gbcontinuity-quarantine',
    exportedAt: nowIso(),
    description: '预检隔离待修行：修好 issues 中标阻断的问题后，可把 raw 行合并回备份重新导入',
    rows
  }
  downloadJson(`隔离待修-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2))
  ElMessage.success('隔离清单已下载，修好后作为新备份重新导入即可')
}

function downloadSnapshotCopy(): void {
  if (!snapshot.value) return
  downloadJson(`导入前留底-${new Date(snapshot.value.savedAt).toISOString().slice(0, 10)}.json`, JSON.stringify(snapshot.value, null, 2))
  ElMessage.success('导入前整套数据已另存下载')
}

onBeforeUnmount(() => {
  importStore.stopPolling()
})
</script>

<template>
  <el-dialog
    :model-value="importStore.dialogVisible"
    title="导入整库备份"
    width="820px"
    top="6vh"
    :close-on-click-modal="false"
    :close-on-press-escape="!importStore.importing"
    :show-close="!importStore.importing"
    @update:model-value="onVisibleChange"
    @open="onOpen"
    @closed="onDialogClosed"
  >
    <!-- 步骤 1：选择备份 -->
    <div v-if="importStore.step === 'select'">
      <el-upload drag :auto-upload="false" :show-file-list="false" accept=".json,application/json" :http-request="readFile">
        <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
        <div class="el-upload__text">拖拽备份 JSON 到这里，或<em>点击选择文件</em></div>
        <template #tip>
          <div class="el-upload__tip">仅预检本应用导出的整库备份 / 核对报告 JSON，预检通过前不会改动本机数据。</div>
        </template>
      </el-upload>
      <el-divider content-position="center">或直接粘贴备份文本</el-divider>
      <el-input
        :model-value="importStore.backupText"
        type="textarea"
        :rows="5"
        placeholder='{"name":"gbcontinuity-db","schemaVersion":…}'
        @update:model-value="applyPasted"
      />
    </div>

    <!-- 步骤 2：预检前 -->
    <div v-else-if="importStore.step === 'precheck'">
      <el-descriptions :column="1" border size="small" class="gap-bottom">
        <el-descriptions-item label="备份文件">{{ importStore.fileName }}</el-descriptions-item>
      </el-descriptions>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="预检为只读操作：会核对结构版本、逐表必填字段与跨表引用，坏数据隔离待修，不写库。"
      />
      <el-alert
        v-if="importStore.errorMessage"
        type="error"
        :closable="false"
        show-icon
        class="gap-top"
        :title="importStore.errorMessage"
      />
    </div>

    <!-- 步骤 3：预检结果 / 确认导入 -->
    <div v-else-if="importStore.step === 'apply' && !importStore.importing && !importStore.progress">
      <template v-if="importStore.precheck">
        <ImportPrecheckPanel :precheck="importStore.precheck" />

        <el-alert
          v-if="importStore.stale"
          type="error"
          show-icon
          :closable="false"
          :icon="WarningFilled"
          class="gap-top"
          title="本机台账在预检之后发生过改动，预检结果已作废"
          description="为避免拿过期核对结果覆盖新改动，请重新预检；重新预检通过后才能导入。"
        />
        <el-alert
          v-else-if="importStore.rolledBack"
          type="warning"
          show-icon
          :closable="false"
          :icon="RefreshLeft"
          class="gap-top"
          title="上次写入中途失败，本机已自动恢复到导入前"
          description="可直接重试写入；重试前不要再改动台账。草稿与预检结果保留在本机。"
        />
        <el-alert
          v-else-if="importStore.errorMessage"
          type="error"
          show-icon
          :closable="false"
          class="gap-top"
          :title="importStore.errorMessage"
        />
      </template>
    </div>

    <!-- 写入 / 回滚进度 -->
    <div v-else-if="importStore.importing || importStore.progress">
      <ImportProgressPanel v-if="importStore.progress" :progress="importStore.progress" />
      <el-skeleton v-else animated :rows="3" />
    </div>

    <!-- 完成 -->
    <div v-else-if="importStore.step === 'done'">
      <el-result icon="success" title="备份导入完成" :sub-title="importStore.successMessage">
        <template #extra>
          <el-button v-if="snapshot" plain :icon="Download" @click="downloadSnapshotCopy">另存导入前留底</el-button>
          <el-button v-if="snapshot" type="warning" plain :icon="RefreshLeft" @click="onRestore">反悔：恢复到导入前</el-button>
        </template>
      </el-result>
    </div>

    <el-alert
      v-if="snapshot && importStore.step !== 'done'"
      type="info"
      :closable="false"
      show-icon
      class="gap-top"
      title="本机存在上一次导入的导入前留底"
      :description="`留底时间 ${new Date(snapshot.savedAt).toLocaleString('zh-CN')}（${snapshot.reason}）。新导入会替换该留底。`"
    >
      <div class="snapshot-actions">
        <el-button size="small" plain :icon="Download" @click="downloadSnapshotCopy">下载留底文件</el-button>
        <el-button size="small" type="warning" plain :icon="RefreshLeft" @click="onRestore">用留底恢复本机</el-button>
      </div>
    </el-alert>

    <template #footer>
      <div class="footer">
        <el-button
          v-if="importStore.hasFile && importStore.step !== 'done' && !importStore.importing"
          text
          type="danger"
          @click="onDiscardDraft"
        >
          丢弃草稿
        </el-button>
        <div class="footer__right">
          <el-button :disabled="importStore.importing" @click="importStore.closeDialog()">
            {{ importStore.step === 'done' ? '关闭' : '取消' }}
          </el-button>

          <el-button
            v-if="importStore.step === 'precheck'"
            type="primary"
            :loading="importStore.busy"
            @click="recheck"
          >
            开始预检
          </el-button>

          <template v-if="importStore.step === 'apply' && importStore.precheck && !importStore.importing">
            <el-button
              v-if="importStore.precheck.quarantined.length > 0"
              :icon="Download"
              @click="downloadQuarantine"
            >
              下载隔离待修清单（{{ importStore.precheck.quarantined.length }}）
            </el-button>
            <el-button
              v-if="importStore.rolledBack && !importStore.stale"
              type="warning"
              :loading="importStore.busy"
              @click="onRetry"
            >
              重试写入
            </el-button>
            <el-button
              v-else
              type="primary"
              :disabled="importStore.precheck.phase === 'fail' || importStore.stale"
              @click="onConfirm"
            >
              {{ importStore.stale ? '请重新预检' : `确认导入（先留底再分批写入）` }}
            </el-button>
            <el-button
              v-if="importStore.stale || importStore.precheck.phase === 'fail'"
              type="primary"
              plain
              @click="recheck"
            >
              重新预检
            </el-button>
          </template>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.gap-bottom {
  margin-bottom: 12px;
}
.gap-top {
  margin-top: 10px;
}
.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.footer__right {
  display: flex;
  gap: 8px;
}
.snapshot-actions {
  margin-top: 6px;
  display: flex;
  gap: 8px;
}
</style>
