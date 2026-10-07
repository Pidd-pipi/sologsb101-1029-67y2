/**
 * 备份导入预检（只读，不写库）：
 * 1. 读备份的结构版本号：高于本机版本直接判失败，低于当前版本标记升级并逐行回填；
 * 2. 逐表核对主键、必填字段、枚举取值与字段类型，旧数据缺修订号/时间戳按当前结构回填，
 *    填不上的打「待修」问题并隔离；
 * 3. 按 scenes → elements → shootDays → records → conflicts 顺序核对跨表引用，
 *    被引用方被隔离时引用方自然悬空（现场记录找不到连戏要素/拍摄日等），整行隔离；
 * 4. 与本机台账比对，列出每表新增/覆盖条数；拍摄日场次清单中的悬空项只剔除不隔离。
 */
import {
  SCENE_PLACES,
  SCENE_TIMES,
  SCENE_STATES
} from '@/types/scene'
import { ELEMENT_CATEGORIES } from '@/types/element'
import { CONFLICT_SEVERITIES, CONFLICT_STATES } from '@/types/conflict'
import {
  BACKUP_TABLE_KEYS,
  TABLE_LABELS,
  type BackupTableKey,
  type ImportIssue,
  type IssueCode,
  type PrecheckResult,
  type PreparedRows,
  type QuarantinedRow,
  type RawBackup,
  type TableImportStats
} from '@/types/importDraft'
import {
  DB_SCHEMA_VERSION,
  ROW_REVISION,
  type ConflictRow,
  type ElementRow,
  type RecordRow,
  type SceneRow,
  type ShootDayRow
} from './db'

/** 备份根节点必须具备的字段（整库备份与核对报告都包含这些） */
const REQUIRED_ROOT_ARRAYS = BACKUP_TABLE_KEYS

/** 解析并做根级结构校验；行内容的核对在 runPrecheck 中进行 */
export function parseBackup(text: string): RawBackup {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('不是合法的 JSON 文本，请确认粘贴/选择的是完整备份文件')
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('备份根节点必须是对象')
  const candidate = parsed as Record<string, unknown>
  for (const key of REQUIRED_ROOT_ARRAYS) {
    if (!Array.isArray(candidate[key])) throw new Error(`缺少 ${key} 数组字段，不是本应用的整库备份文件`)
  }
  const schemaVersion = candidate.schemaVersion
  if (typeof schemaVersion !== 'number') throw new Error('备份缺少 schemaVersion 结构版本号，无法预检')
  return {
    name: typeof candidate.name === 'string' ? candidate.name : '',
    schemaVersion,
    exportedAt: typeof candidate.exportedAt === 'string' ? candidate.exportedAt : '',
    rows: {
      scenes: candidate.scenes as unknown[],
      elements: candidate.elements as unknown[],
      shootDays: candidate.shootDays as unknown[],
      records: candidate.records as unknown[],
      conflicts: candidate.conflicts as unknown[]
    }
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function asBackfilledString(value: unknown): { ok: true; value: string; repaired: boolean } | { ok: false } {
  if (typeof value === 'string') return { ok: true, value, repaired: false }
  if (value === undefined || value === null) return { ok: true, value: '', repaired: true }
  return { ok: false }
}

interface Ctx {
  table: BackupTableKey
  index: number
  raw: Record<string, unknown>
  issues: ImportIssue[]
  /** 本行是否已有阻断问题（有则隔离，后续引用方不再能引用到它） */
  blocked: boolean
  repaired: boolean
  seq: number
}

function nextIssueId(ctx: Ctx): string {
  ctx.seq += 1
  return `iss-${ctx.seq}`
}

function rowKeyOf(ctx: Ctx, id: unknown): string {
  return isNonEmptyString(id) ? id : `第 ${ctx.index + 1} 行`
}

function addIssue(
  ctx: Ctx,
  id: unknown,
  code: IssueCode,
  message: string,
  field: string | undefined,
  repaired: boolean
): void {
  ctx.issues.push({ id: nextIssueId(ctx), table: ctx.table, rowKey: rowKeyOf(ctx, id), code, field, message, repaired })
  if (!repaired) ctx.blocked = true
  else ctx.repaired = true
}

/** 回填行修订号与时间戳：旧数据 revision 缺失（结构升级场景）时统一补当前修订号 */
function applyRevision(ctx: Ctx, obj: Record<string, unknown>, id: unknown): void {
  const missing: string[] = []
  if (typeof obj.revision !== 'number') missing.push('revision')
  if (typeof obj.createdAt !== 'number') missing.push('createdAt')
  if (typeof obj.updatedAt !== 'number') missing.push('updatedAt')
  if (missing.length === 0) return
  const now = Date.now()
  obj.revision = ROW_REVISION
  if (typeof obj.createdAt !== 'number') obj.createdAt = now
  if (typeof obj.updatedAt !== 'number') obj.updatedAt = now
  addIssue(
    ctx,
    id,
    'backfill-revision',
    `旧数据缺行修订号/时间戳（${missing.join('、')}），已按当前结构 v${DB_SCHEMA_VERSION} 回填`,
    'revision',
    true
  )
}

/** 必填非空文本字段；空则阻断隔离 */
function requireText(ctx: Ctx, obj: Record<string, unknown>, id: unknown, field: string, label: string): void {
  if (!isNonEmptyString(obj[field])) addIssue(ctx, id, 'missing-field', `必填字段「${label}」缺失或为空，无法补齐`, field, false)
}

/** 枚举字段；取值不在当前结构范围内则无法映射，阻断隔离 */
function requireEnum(ctx: Ctx, obj: Record<string, unknown>, id: unknown, field: string, label: string, allowed: readonly string[]): void {
  const value = obj[field]
  if (!isNonEmptyString(value) || !allowed.includes(value)) {
    addIssue(ctx, id, 'invalid-enum', `「${label}」取值 ${JSON.stringify(value ?? null)} 不在当前结构允许范围（${allowed.join(' / ')}）`, field, false)
  }
}

/** 可选文本：缺失补空串（告警），类型不对则无法处理（隔离） */
function optionalText(ctx: Ctx, obj: Record<string, unknown>, id: unknown, field: string, label: string): void {
  const result = asBackfilledString(obj[field])
  if (!result.ok) {
    addIssue(ctx, id, 'invalid-type', `「${label}」应为文本，实际为 ${typeof obj[field]}，无法补齐`, field, false)
    return
  }
  obj[field] = result.value
  if (result.repaired) addIssue(ctx, id, 'backfill-default', `「${label}」缺失，已补为空文本`, field, true)
}

/** 跨表外键：必填且必须能在已通过预检的主键集合中找到 */
function requireRef(
  ctx: Ctx,
  obj: Record<string, unknown>,
  id: unknown,
  field: string,
  label: string,
  validIds: Set<string>,
  targetLabel: string
): void {
  const ref = obj[field]
  if (!isNonEmptyString(ref)) {
    addIssue(ctx, id, 'missing-field', `必填字段「${label}」缺失`, field, false)
    return
  }
  if (!validIds.has(ref)) {
    addIssue(ctx, id, 'missing-reference', `${label} ${ref} 找不到对应的${targetLabel}（可能已随坏行一并隔离），引用悬空`, field, false)
  }
}

/* ------------------------------ 逐表核对 ------------------------------ */

function prepareScenes(ctx: Ctx): SceneRow | null {
  const obj = ctx.raw
  const id = obj.id
  requireText(ctx, obj, id, 'sceneNo', '场号')
  requireEnum(ctx, obj, id, 'place', '内外景', SCENE_PLACES)
  requireEnum(ctx, obj, id, 'timeOfDay', '时间', SCENE_TIMES)
  requireEnum(ctx, obj, id, 'state', '拍摄状态', SCENE_STATES)
  optionalText(ctx, obj, id, 'location', '地点')
  optionalText(ctx, obj, id, 'excerpt', '剧本节选')
  if (typeof obj.shootOrder !== 'number' || !Number.isFinite(obj.shootOrder)) {
    // 占位，顺序号在全部行收集后统一分配，避免与备份内已有序号撞号
    obj.shootOrder = -1
    addIssue(ctx, id, 'backfill-default', '「拍摄顺序」缺失或不是数字，已按现有顺序追加到队尾', 'shootOrder', true)
  }
  if (ctx.blocked) return null
  applyRevision(ctx, obj, id)
  return ctx.blocked ? null : (obj as unknown as SceneRow)
}

function prepareElements(ctx: Ctx, sceneIds: Set<string>): ElementRow | null {
  const obj = ctx.raw
  const id = obj.id
  requireRef(ctx, obj, id, 'sceneId', '所属场次', sceneIds, '场次')
  requireEnum(ctx, obj, id, 'category', '类别', ELEMENT_CATEGORIES)
  requireText(ctx, obj, id, 'name', '要素名称')
  optionalText(ctx, obj, id, 'initialState', '初始状态')
  optionalText(ctx, obj, id, 'owner', '责任人')
  if (obj.critical === undefined || obj.critical === null) {
    obj.critical = false
    addIssue(ctx, id, 'backfill-default', '「是否关键要素」缺失，已补为否', 'critical', true)
  } else if (typeof obj.critical !== 'boolean') {
    addIssue(ctx, id, 'invalid-type', `「是否关键要素」应为布尔值，实际为 ${typeof obj.critical}`, 'critical', false)
  }
  if (ctx.blocked) return null
  applyRevision(ctx, obj, id)
  return ctx.blocked ? null : (obj as unknown as ElementRow)
}

function prepareShootDays(ctx: Ctx, sceneIds: Set<string>): ShootDayRow | null {
  const obj = ctx.raw
  const id = obj.id
  requireText(ctx, obj, id, 'date', '拍摄日期')
  const sceneIdsValue = obj.sceneIds
  if (sceneIdsValue === undefined || sceneIdsValue === null) {
    obj.sceneIds = []
    addIssue(ctx, id, 'backfill-default', '「当日场次清单」缺失，已补为空清单', 'sceneIds', true)
  } else if (!Array.isArray(sceneIdsValue)) {
    addIssue(ctx, id, 'invalid-type', `「当日场次清单」应为数组，实际为 ${typeof sceneIdsValue}`, 'sceneIds', false)
  } else {
    const kept: string[] = []
    const dropped: string[] = []
    for (const ref of sceneIdsValue) {
      if (typeof ref === 'string' && sceneIds.has(ref) && !kept.includes(ref)) kept.push(ref)
      else dropped.push(String(ref))
    }
    obj.sceneIds = kept
    if (dropped.length > 0) {
      addIssue(ctx, id, 'drop-dangling-ref', `当日场次清单中 ${dropped.length} 个场次找不到对应台账行，已剔除：${dropped.join('、')}`, 'sceneIds', true)
    }
  }
  optionalText(ctx, obj, id, 'director', '导演')
  optionalText(ctx, obj, id, 'scripty', '场记')
  optionalText(ctx, obj, id, 'weatherNote', '现场备注')
  if (ctx.blocked) return null
  applyRevision(ctx, obj, id)
  return ctx.blocked ? null : (obj as unknown as ShootDayRow)
}

function prepareRecords(ctx: Ctx, sceneIds: Set<string>, elementIds: Set<string>, shootDayIds: Set<string>): RecordRow | null {
  const obj = ctx.raw
  const id = obj.id
  requireRef(ctx, obj, id, 'shootDayId', '拍摄日', shootDayIds, '拍摄日')
  requireRef(ctx, obj, id, 'elementId', '连戏要素', elementIds, '连戏要素')
  requireRef(ctx, obj, id, 'sceneId', '所属场次', sceneIds, '场次')
  requireText(ctx, obj, id, 'takeNo', '镜次')
  optionalText(ctx, obj, id, 'currentState', '当前状态')
  optionalText(ctx, obj, id, 'photoNote', '照片说明')
  optionalText(ctx, obj, id, 'recordedBy', '记录人')
  if (ctx.blocked) return null
  applyRevision(ctx, obj, id)
  return ctx.blocked ? null : (obj as unknown as RecordRow)
}

function prepareConflicts(ctx: Ctx, elementIds: Set<string>, recordIds: Set<string>): ConflictRow | null {
  const obj = ctx.raw
  const id = obj.id
  requireRef(ctx, obj, id, 'elementId', '连戏要素', elementIds, '连戏要素')
  requireRef(ctx, obj, id, 'recordIdA', '较早记录', recordIds, '现场记录')
  requireRef(ctx, obj, id, 'recordIdB', '较晚记录', recordIds, '现场记录')
  requireEnum(ctx, obj, id, 'severity', '严重程度', CONFLICT_SEVERITIES)
  requireEnum(ctx, obj, id, 'state', '处理状态', CONFLICT_STATES)
  optionalText(ctx, obj, id, 'diffDesc', '差异描述')
  optionalText(ctx, obj, id, 'resolvedNote', '解决留痕')
  optionalText(ctx, obj, id, 'resolvedAt', '解决时间')
  if (ctx.blocked) return null
  applyRevision(ctx, obj, id)
  return ctx.blocked ? null : (obj as unknown as ConflictRow)
}

/* ------------------------------ 行标题 ------------------------------ */

function rowTitle(table: BackupTableKey, raw: Record<string, unknown>): string {
  const text = (key: string): string => (typeof raw[key] === 'string' ? (raw[key] as string) : '')
  switch (table) {
    case 'scenes':
      return `场次 第 ${text('sceneNo') || '?'} 场${text('location') ? ` · ${text('location')}` : ''}`
    case 'elements':
      return `连戏要素 ${text('name') || '未命名'}${text('category') ? `（${text('category')}）` : ''}`
    case 'shootDays':
      return `拍摄日 ${text('date') || '日期缺失'}`
    case 'records':
      return `现场记录 镜次 ${text('takeNo') || '?'}`
    case 'conflicts':
      return `连戏差异 ${text('diffDesc') ? text('diffDesc').slice(0, 20) : text('id')}`
  }
  return '未知记录'
}

interface ProcessOutput<T> {
  valid: T[]
  quarantined: QuarantinedRow[]
  /** 表内出现过的全部问题（含已自动修复的告警） */
  issues: ImportIssue[]
  repairedKeys: Set<string>
}

type Preparer<T> = (ctx: Ctx) => T | null

function processTable<T>(table: BackupTableKey, list: unknown[], seqHolder: { n: number }, preparer: Preparer<T>): ProcessOutput<T> {
  const valid: T[] = []
  const quarantined: QuarantinedRow[] = []
  const issues: ImportIssue[] = []
  const seen = new Set<string>()
  const repairedKeys = new Set<string>()

  list.forEach((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      const key = `第 ${index + 1} 行`
      issues.push({
        id: `iss-${(seqHolder.n += 1)}`,
        table,
        rowKey: key,
        code: 'invalid-type',
        message: '行必须是对象，实际为 null / 数组 / 基本类型',
        repaired: false
      })
      quarantined.push({ table, rowKey: key, title: key, raw: item, issues: issues.filter((x) => x.rowKey === key) })
      return
    }
    const raw = item as Record<string, unknown>
    const ctx: Ctx = { table, index, raw, issues, blocked: false, repaired: false, seq: seqHolder.n }
    const id = raw.id
    if (!isNonEmptyString(id)) {
      addIssue(ctx, id, 'invalid-id', '缺少主键 id（非空文本），无法写库', 'id', false)
    } else if (seen.has(id)) {
      addIssue(ctx, id, 'duplicate-id', `主键 ${id} 在备份的同表内重复，保留首条，其余隔离待修`, 'id', false)
    }

    const prepared = preparer(ctx)
    seqHolder.n = ctx.seq

    const key = rowKeyOf(ctx, id)
    if (ctx.blocked || prepared === null) {
      quarantined.push({ table, rowKey: key, title: rowTitle(table, raw), raw, issues: issues.filter((x) => x.rowKey === key) })
      return
    }
    seen.add(id as string)
    if (ctx.repaired) repairedKeys.add(id as string)
    valid.push(prepared)
  })

  return { valid, quarantined, issues, repairedKeys }
}

export interface RunPrecheckOptions {
  local: PreparedRows
  localFingerprint: string
}

/** 执行预检：返回统计、可写行、问题清单与隔离区（不做任何写库动作） */
export function runPrecheck(backup: RawBackup, options: RunPrecheckOptions): PrecheckResult {
  const fatalErrors: string[] = []
  if (backup.schemaVersion > DB_SCHEMA_VERSION) {
    fatalErrors.push(
      `备份结构版本 v${backup.schemaVersion} 高于本机支持的 v${DB_SCHEMA_VERSION}，请先升级应用再导入，不能把新结构数据降级写入`
    )
  }

  const seqHolder = { n: 0 }
  const issues: ImportIssue[] = []
  const quarantined: QuarantinedRow[] = []
  const repairedKeysByTable = new Map<BackupTableKey, Set<string>>()

  // 按引用依赖顺序逐表处理；每通过一张表，它的主键集合就成为后续表的合法引用目标
  const scenesOut = processTable('scenes', fatalErrors.length > 0 ? [] : backup.rows.scenes, seqHolder, prepareScenes)
  const sceneRows = scenesOut.valid
  const sceneIds = new Set(sceneRows.map((row) => row.id))

  const elementsOut = processTable(
    'elements',
    fatalErrors.length > 0 ? [] : backup.rows.elements,
    seqHolder,
    (ctx) => prepareElements(ctx, sceneIds)
  )
  const elementRows = elementsOut.valid
  const elementIds = new Set(elementRows.map((row) => row.id))

  const shootDaysOut = processTable(
    'shootDays',
    fatalErrors.length > 0 ? [] : backup.rows.shootDays,
    seqHolder,
    (ctx) => prepareShootDays(ctx, sceneIds)
  )
  const shootDayRows = shootDaysOut.valid
  const shootDayIds = new Set(shootDayRows.map((row) => row.id))

  const recordsOut = processTable(
    'records',
    fatalErrors.length > 0 ? [] : backup.rows.records,
    seqHolder,
    (ctx) => prepareRecords(ctx, sceneIds, elementIds, shootDayIds)
  )
  const recordRows = recordsOut.valid
  const recordIds = new Set(recordRows.map((row) => row.id))

  const conflictsOut = processTable(
    'conflicts',
    fatalErrors.length > 0 ? [] : backup.rows.conflicts,
    seqHolder,
    (ctx) => prepareConflicts(ctx, elementIds, recordIds)
  )
  const conflictRows = conflictsOut.valid

  // 缺拍摄顺序的场次统一追加到队尾（排在备份内已有最大序号之后）
  let nextOrder = sceneRows.reduce((max, row) => Math.max(max, row.shootOrder), 0)
  for (const row of sceneRows) {
    if (row.shootOrder === -1) {
      nextOrder += 1
      row.shootOrder = nextOrder
    }
  }

  for (const out of [scenesOut, elementsOut, shootDaysOut, recordsOut, conflictsOut]) {
    issues.push(...out.issues)
    quarantined.push(...out.quarantined)
  }
  repairedKeysByTable.set('scenes', scenesOut.repairedKeys)
  repairedKeysByTable.set('elements', elementsOut.repairedKeys)
  repairedKeysByTable.set('shootDays', shootDaysOut.repairedKeys)
  repairedKeysByTable.set('records', recordsOut.repairedKeys)
  repairedKeysByTable.set('conflicts', conflictsOut.repairedKeys)

  const outByTable: Record<BackupTableKey, { valid: { id: string }[]; total: number; quarantinedCount: number }> = {
    scenes: { valid: sceneRows, total: backup.rows.scenes.length, quarantinedCount: scenesOut.quarantined.length },
    elements: { valid: elementRows, total: backup.rows.elements.length, quarantinedCount: elementsOut.quarantined.length },
    shootDays: { valid: shootDayRows, total: backup.rows.shootDays.length, quarantinedCount: shootDaysOut.quarantined.length },
    records: { valid: recordRows, total: backup.rows.records.length, quarantinedCount: recordsOut.quarantined.length },
    conflicts: { valid: conflictRows, total: backup.rows.conflicts.length, quarantinedCount: conflictsOut.quarantined.length }
  }

  const stats: TableImportStats[] = BACKUP_TABLE_KEYS.map((table) => {
    const localIds = new Set(options.local[table].map((row) => row.id))
    const out = outByTable[table]
    let added = 0
    let overwritten = 0
    for (const row of out.valid) {
      if (localIds.has(row.id)) overwritten += 1
      else added += 1
    }
    return {
      table,
      label: TABLE_LABELS[table],
      total: out.total,
      valid: out.valid.length,
      added,
      overwritten,
      quarantined: out.quarantinedCount,
      repaired: repairedKeysByTable.get(table)?.size ?? 0
    }
  })

  const totals = stats.reduce(
    (acc, item) => ({
      input: acc.input + item.total,
      valid: acc.valid + item.valid,
      added: acc.added + item.added,
      overwritten: acc.overwritten + item.overwritten,
      quarantined: acc.quarantined + item.quarantined,
      repaired: acc.repaired + item.repaired
    }),
    { input: 0, valid: 0, added: 0, overwritten: 0, quarantined: 0, repaired: 0 }
  )

  const validRows: PreparedRows = {
    scenes: sceneRows,
    elements: elementRows,
    shootDays: shootDayRows,
    records: recordRows,
    conflicts: conflictRows
  }

  return {
    checkedAt: Date.now(),
    localFingerprint: options.localFingerprint,
    sourceSchemaVersion: backup.schemaVersion,
    targetSchemaVersion: DB_SCHEMA_VERSION,
    sourceExportedAt: backup.exportedAt,
    upgraded: backup.schemaVersion < DB_SCHEMA_VERSION,
    phase: fatalErrors.length > 0 ? 'fail' : quarantined.length > 0 ? 'pass-with-quarantine' : 'pass',
    stats,
    totals,
    validRows,
    issues,
    quarantined,
    fatalErrors
  }
}
