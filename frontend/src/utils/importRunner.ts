/**
 * 预检通过后的落地执行器：
 * - 正式写入前先把本机五张表整套数据留底（importMeta 表，也可另存下载）；
 * - 写入前再算一次台账指纹，与预检时不一致则拒绝落地（预检结果作废重来）；
 * - 清空放在单个事务里先完成；写入按表顺序分批、每批独立事务并让出主线程，
 *   避免一次 bulkPut 数据量大时事务超时；
 * - 任一批失败：自动用留底恢复到导入前，并抛出带「已回滚」说明的错误；
 * - 留底在导入成功后保留，供人工反悔时一键恢复；草稿由调用方删除。
 */
import {
  BACKUP_TABLE_KEYS,
  type BackupTableKey,
  type ImportProgress,
  type PreImportSnapshot,
  type PrecheckResult,
  type PreparedRows
} from '@/types/importDraft'
import {
  db,
  deleteImportMeta,
  getImportMeta,
  readAllBusinessRows,
  setImportMeta,
  type ConflictRow,
  type ElementRow,
  type RecordRow,
  type SceneRow,
  type ShootDayRow
} from './db'
import { currentFingerprint, fingerprintOf } from './hash'

/** 单批写入行数：每批一个独立事务，避免长事务超时 */
export const IMPORT_BATCH_SIZE = 100

const SNAPSHOT_KEY = 'pre-import-snapshot'

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** 写入前保存导入前的整套本机数据 */
export async function savePreImportSnapshot(reason: string): Promise<PreImportSnapshot> {
  const data = await readAllBusinessRows()
  const snapshot: PreImportSnapshot = { savedAt: Date.now(), reason, fingerprint: fingerprintOf(data), data }
  await setImportMeta(SNAPSHOT_KEY, snapshot)
  return snapshot
}

export async function getPreImportSnapshot(): Promise<PreImportSnapshot | null> {
  return getImportMeta<PreImportSnapshot>(SNAPSHOT_KEY)
}

export async function clearPreImportSnapshot(): Promise<void> {
  await deleteImportMeta(SNAPSHOT_KEY)
}

function totalRowsOf(rows: PreparedRows): number {
  return BACKUP_TABLE_KEYS.reduce((sum, table) => sum + rows[table].length, 0)
}

/** 清空五张业务表（单个事务，要么全清要么不动；importMeta 留底不在清空范围内） */
async function clearBusinessTables(onProgress?: (p: ImportProgress) => void): Promise<void> {
  await db.transaction('rw', [db.scenes, db.elements, db.shootDays, db.records, db.conflicts], async () => {
    for (let i = 0; i < BACKUP_TABLE_KEYS.length; i += 1) {
      const table = BACKUP_TABLE_KEYS[i]
      await db.table(table).clear()
      onProgress?.({
        stage: 'clearing',
        table,
        tableIndex: i,
        tableCount: BACKUP_TABLE_KEYS.length,
        doneRows: i + 1,
        totalRows: BACKUP_TABLE_KEYS.length,
        percent: Math.round(((i + 1) / BACKUP_TABLE_KEYS.length) * 4)
      })
    }
  })
}

type AnyRow = SceneRow | ElementRow | ShootDayRow | RecordRow | ConflictRow

/** 分批写入：每批独立事务，批间让出事件循环；失败时抛出由上层触发回滚 */
async function writeBatched(
  rows: PreparedRows,
  startPercent: number,
  spanPercent: number,
  stage: ImportProgress['stage'],
  onProgress?: (p: ImportProgress) => void
): Promise<void> {
  const total = Math.max(totalRowsOf(rows), 1)
  let done = 0
  for (let tableIndex = 0; tableIndex < BACKUP_TABLE_KEYS.length; tableIndex += 1) {
    const table: BackupTableKey = BACKUP_TABLE_KEYS[tableIndex]
    const list = rows[table] as AnyRow[]
    for (let offset = 0; offset < list.length; offset += IMPORT_BATCH_SIZE) {
      const batch = list.slice(offset, offset + IMPORT_BATCH_SIZE)
      await db.transaction('rw', db.table(table), async () => {
        await (db.table(table).bulkPut(batch) as Promise<unknown>)
      })
      done += batch.length
      await yieldToEventLoop()
      onProgress?.({
        stage,
        table,
        tableIndex,
        tableCount: BACKUP_TABLE_KEYS.length,
        doneRows: Math.min(offset + IMPORT_BATCH_SIZE, list.length),
        totalRows: list.length,
        percent: startPercent + Math.round((done / total) * spanPercent)
      })
    }
    if (list.length === 0) {
      onProgress?.({
        stage,
        table,
        tableIndex,
        tableCount: BACKUP_TABLE_KEYS.length,
        doneRows: 0,
        totalRows: 0,
        percent: startPercent + Math.round((done / total) * spanPercent)
      })
    }
  }
}

/** 用导入前留底恢复本机数据（先清空再分批写回），返回恢复后的实际指纹 */
async function restoreBusinessRows(snapshot: PreImportSnapshot, onProgress?: (p: ImportProgress) => void): Promise<string> {
  await clearBusinessTables(() => undefined)
  await writeBatched(snapshot.data, 0, 100, 'restoring', onProgress)
  return fingerprintOf(await readAllBusinessRows())
}

export class StalePrecheckError extends Error {
  constructor() {
    super('本机台账在预检之后发生过改动，预检结果已作废，请重新预检后再导入')
    this.name = 'StalePrecheckError'
  }
}

export class ApplyImportError extends Error {
  /** 是否已成功回滚到导入前 */
  rolledBack: boolean
  constructor(message: string, rolledBack: boolean) {
    super(message)
    this.name = 'ApplyImportError'
    this.rolledBack = rolledBack
  }
}

/**
 * 正式落地预检通过的备份。
 * @returns 导入后的本机指纹
 */
export async function applyImport(
  precheck: PrecheckResult,
  onProgress?: (p: ImportProgress) => void
): Promise<string> {
  // 写入前再看本机有没有新改动：指纹变了预检直接作废（在覆盖旧留底之前就拒绝）
  const fingerprintNow = await currentFingerprint()
  if (fingerprintNow !== precheck.localFingerprint) throw new StalePrecheckError()

  let snapshot: PreImportSnapshot
  try {
    snapshot = await savePreImportSnapshot(
      `导入备份（备份结构 v${precheck.sourceSchemaVersion}，预检于 ${new Date(precheck.checkedAt).toLocaleString('zh-CN')}）`
    )
  } catch (error) {
    throw new ApplyImportError(
      `保存导入前留底失败，已中止导入（本机数据未改动）：${error instanceof Error ? error.message : String(error)}`,
      false
    )
  }
  try {
    await clearBusinessTables(onProgress)
    await writeBatched(precheck.validRows, 4, 96, 'writing', onProgress)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    let rolledBack = false
    let restoreNote = ''
    try {
      await restoreBusinessRows(snapshot)
      rolledBack = true
    } catch (restoreError) {
      restoreNote = `；自动回滚也失败了：${restoreError instanceof Error ? restoreError.message : String(restoreError)}，请使用留底文件手动恢复`
    }
    throw new ApplyImportError(`写入中途失败，已${rolledBack ? '恢复到导入前' : '未能恢复'}：${reason}${restoreNote}`, rolledBack)
  }

  return fingerprintOf(await readAllBusinessRows())
}

/** 手动用留底恢复（「恢复到导入前」按钮），返回恢复后指纹与留底指纹是否一致 */
export async function rollbackToSnapshot(
  snapshot: PreImportSnapshot,
  onProgress?: (p: ImportProgress) => void
): Promise<{ fingerprint: string; consistent: boolean }> {
  const fingerprint = await restoreBusinessRows(snapshot, onProgress)
  return { fingerprint, consistent: fingerprint === snapshot.fingerprint }
}
