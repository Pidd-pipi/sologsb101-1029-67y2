/**
 * 整库备份导入 store：解析 → 预检 → 留底 → 分批写入 →（失败）回滚/重试。
 * 可重试草稿（备份原文 + 预检结果）持久化在 importMeta 表，刷新或换页面后可继续；
 * 对话框打开期间轮询本机台账指纹，预检后任何一改动都会把预检标记为作废，必须重新预检。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ImportDraft, ImportProgress, PrecheckResult, QuarantinedRow } from '@/types/importDraft'
import { deleteImportMeta, getImportMeta, readAllBusinessRows, setImportMeta } from '@/utils/db'
import { currentFingerprint } from '@/utils/hash'
import { parseBackup, runPrecheck } from '@/utils/importPrecheck'
import {
  ApplyImportError,
  StalePrecheckError,
  applyImport,
  getPreImportSnapshot,
  rollbackToSnapshot
} from '@/utils/importRunner'

const DRAFT_KEY = 'import-draft'
/** 台账指纹轮询间隔：预检后台账被改动则预检立即作废 */
const FINGERPRINT_POLL_MS = 2500

export type ImportStep = 'select' | 'precheck' | 'apply' | 'done'

export const useImportStore = defineStore('import', () => {
  const dialogVisible = ref(false)
  const fileName = ref('')
  const backupText = ref('')
  const precheck = ref<PrecheckResult | null>(null)
  const busy = ref(false)
  const importing = ref(false)
  const progress = ref<ImportProgress | null>(null)
  const errorMessage = ref('')
  const successMessage = ref('')
  /** 预检之后本机台账被改动 */
  const stale = ref(false)
  /** 导入失败且已回滚，允许直接重试写入（草稿仍在） */
  const rolledBack = ref(false)
  /** 回滚后数据与留底不一致（需人工介入） */
  const restoreInconsistent = ref(false)

  let pollTimer: ReturnType<typeof setInterval> | null = null

  const hasFile = computed(() => backupText.value.trim().length > 0)
  const blockingIssueCount = computed(() => precheck.value?.issues.filter((item) => !item.repaired).length ?? 0)
  const repairedIssueCount = computed(() => precheck.value?.issues.filter((item) => item.repaired).length ?? 0)

  const step = computed<ImportStep>(() => {
    if (importing.value || progress.value) return 'apply'
    if (successMessage.value) return 'done'
    if (precheck.value) return 'apply'
    return hasFile.value ? 'precheck' : 'select'
  })

  async function persistDraft(): Promise<void> {
    if (!hasFile.value) return
    const existing = await getImportMeta<ImportDraft>(DRAFT_KEY)
    const now = Date.now()
    const draft: ImportDraft = {
      draftId: existing?.draftId ?? `draft-${now}`,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      fileName: fileName.value,
      backupText: backupText.value,
      precheck: precheck.value
    }
    await setImportMeta(DRAFT_KEY, draft)
  }

  async function loadDraft(): Promise<ImportDraft | null> {
    return getImportMeta<ImportDraft>(DRAFT_KEY)
  }

  async function resumeDraft(draft: ImportDraft): Promise<void> {
    fileName.value = draft.fileName
    backupText.value = draft.backupText
    precheck.value = draft.precheck
    stale.value = false
    rolledBack.value = false
    restoreInconsistent.value = false
    errorMessage.value = ''
    successMessage.value = ''
    if (draft.precheck) await verifyFingerprint()
  }

  async function discardDraft(): Promise<void> {
    await deleteImportMeta(DRAFT_KEY)
    resetState()
  }

  function resetState(): void {
    fileName.value = ''
    backupText.value = ''
    precheck.value = null
    busy.value = false
    importing.value = false
    progress.value = null
    errorMessage.value = ''
    successMessage.value = ''
    stale.value = false
    rolledBack.value = false
    restoreInconsistent.value = false
  }

  function openDialog(): void {
    dialogVisible.value = true
    startPolling()
  }

  async function closeDialog(): Promise<void> {
    dialogVisible.value = false
    stopPolling()
    // 导入已完成：草稿已删除，连文件缓存一并清掉，避免下次打开又带回
    if (successMessage.value) {
      resetState()
      return
    }
    // 预检/写入中途退出：把备份原文与预检结果留存为可重试草稿
    await persistDraft().catch(() => undefined)
  }

  async function setFile(name: string, text: string): Promise<void> {
    fileName.value = name
    backupText.value = text
    precheck.value = null
    stale.value = false
    rolledBack.value = false
    errorMessage.value = ''
    successMessage.value = ''
    await persistDraft()
  }

  /** 重新核对本机指纹；预检后指纹变化则作废 */
  async function verifyFingerprint(): Promise<void> {
    if (!precheck.value || importing.value || successMessage.value) return
    const fingerprint = await currentFingerprint()
    if (fingerprint !== precheck.value.localFingerprint) stale.value = true
  }

  function startPolling(): void {
    stopPolling()
    pollTimer = setInterval(() => {
      void verifyFingerprint()
    }, FINGERPRINT_POLL_MS)
  }

  function stopPolling(): void {
    if (pollTimer !== null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  async function runCheck(): Promise<void> {
    errorMessage.value = ''
    stale.value = false
    rolledBack.value = false
    busy.value = true
    try {
      const parsed = parseBackup(backupText.value)
      const local = await readAllBusinessRows()
      const fingerprint = await currentFingerprint()
      precheck.value = runPrecheck(parsed, { local, localFingerprint: fingerprint })
      if (precheck.value.phase === 'fail') {
        errorMessage.value = precheck.value.fatalErrors.join('；')
      }
      await persistDraft()
    } catch (error) {
      precheck.value = null
      errorMessage.value = error instanceof Error ? error.message : '预检失败'
    } finally {
      busy.value = false
    }
  }

  async function confirmImport(): Promise<void> {
    if (!precheck.value) return
    errorMessage.value = ''
    // 写入前最后一道：本机有新改动则预检作废
    const fingerprint = await currentFingerprint()
    if (fingerprint !== precheck.value.localFingerprint) {
      stale.value = true
      return
    }
    importing.value = true
    progress.value = null
    try {
      await applyImport(precheck.value, (next) => {
        progress.value = next
      })
      successMessage.value = `导入完成：新增 ${precheck.value.totals.added} 条、覆盖 ${precheck.value.totals.overwritten} 条${
        precheck.value.totals.quarantined > 0 ? `，隔离待修 ${precheck.value.totals.quarantined} 条` : ''
      }`
      await deleteImportMeta(DRAFT_KEY)
    } catch (error) {
      if (error instanceof StalePrecheckError) {
        stale.value = true
      } else if (error instanceof ApplyImportError) {
        rolledBack.value = error.rolledBack
        errorMessage.value = error.message
      } else {
        errorMessage.value = error instanceof Error ? error.message : '导入失败'
      }
    } finally {
      importing.value = false
      progress.value = null
    }
  }

  /** 失败回滚后直接重试写入：台账若已与留底一致就沿用预检结果，否则作废重来 */
  async function retryImport(): Promise<void> {
    if (!precheck.value) return
    const fingerprint = await currentFingerprint()
    if (fingerprint !== precheck.value.localFingerprint) {
      stale.value = true
      rolledBack.value = false
      return
    }
    await confirmImport()
  }

  /** 用导入前留底一键恢复本机台账 */
  async function restoreFromSnapshot(): Promise<void> {
    busy.value = true
    errorMessage.value = ''
    try {
      const snapshot = await getPreImportSnapshot()
      if (!snapshot) throw new Error('找不到导入前留底，无法恢复')
      const result = await rollbackToSnapshot(snapshot, (next) => {
        progress.value = next
      })
      restoreInconsistent.value = !result.consistent
      successMessage.value = result.consistent
        ? '已恢复到导入前的整套数据'
        : '已按留底恢复，但恢复后指纹与留底不一致，请人工核对'
    } catch (error) {
      errorMessage.value = `恢复失败：${error instanceof Error ? error.message : String(error)}`
    } finally {
      busy.value = false
      progress.value = null
    }
  }

  /** 导出隔离区坏行（连同问题说明），修好后作为新备份再导入 */
  function exportQuarantined(): QuarantinedRow[] {
    return precheck.value?.quarantined ?? []
  }

  return {
    dialogVisible,
    fileName,
    backupText,
    precheck,
    busy,
    importing,
    progress,
    errorMessage,
    successMessage,
    stale,
    rolledBack,
    restoreInconsistent,
    step,
    hasFile,
    blockingIssueCount,
    repairedIssueCount,
    openDialog,
    closeDialog,
    setFile,
    runCheck,
    confirmImport,
    retryImport,
    restoreFromSnapshot,
    loadDraft,
    resumeDraft,
    discardDraft,
    exportQuarantined,
    startPolling,
    stopPolling
  }
})
