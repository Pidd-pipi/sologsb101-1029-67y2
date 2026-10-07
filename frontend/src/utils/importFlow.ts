/**
 * 换设备整库备份导入流水线：预检 → 留档 → 分批落地 → 失败回滚 → 可重试草稿。
 *
 * 设计要点（对应交接痛点）：
 * 1. 先预检再落地：读结构版本，逐表核对必填字段与枚举，再核对跨表引用，
 *    任何一行对不上都只进「隔离区（待修）」，绝不写进主库；
 * 2. 旧备份缺 revision 修订号 / 时间戳时，按当前结构回填（升级），填不上的行隔离待修；
 * 3. 预检时记录本机台账指纹（各表 id+updatedAt 摘要），写入前再算一次，
 *    台账一旦在预检后被改动，预检结果直接作废，必须重新预检；
 * 4. 落地前把本机整套数据原样存入导入草稿（独立 IndexedDB），分批写入并回报进度，
 *    中途失败立即按快照恢复到导入前，草稿保留可重试；
 * 5. 草稿库 gbcontinuity-import-db 与业务库 gbcontinuity-db 分离，不占用业务库结构版本。
 */
import Dexie, { type Table } from 'dexie'
import {
  db,
  DB_SCHEMA_VERSION,
  ROW_REVISION,
  type SceneRow,
  type ElementRow,
  type ShootDayRow,
  type RecordRow,
  type ConflictRow
} from './db'
import { SCENE_PLACES, SCENE_TIMES, SCENE_STATES } from '../types/scene'
import { ELEMENT_CATEGORIES } from '../types/element'
import { CONFLICT_SEVERITIES, CONFLICT_STATES } from '../types/conflict'
import { createId } from './uuid'

/* ------------------------------- 基础类型 ------------------------------- */

export type TableKey = 'scenes' | 'elements' | 'shootDays' | 'records' | 'conflicts'

export const TABLE_KEYS: TableKey[] = ['scenes', 'elements', 'shootDays', 'records', 'conflicts']

export const TABLE_LABEL: Record<TableKey, string> = {
  scenes: '场次',
  elements: '连戏要素',
  shootDays: '拍摄日',
  records: '现场记录',
  conflicts: '连戏差异'
}

export type TableCounts = Record<TableKey, number>

export const ZERO_COUNTS: TableCounts = { scenes: 0, elements: 0, shootDays: 0, records: 0, conflicts: 0 }

/** 预检问题级别：warning 可继续落地，danger 仅做汇总提示（问题行本身已隔离） */
export type IssueLevel = 'warning' | 'danger'

export interface ImportIssue {
  level: IssueLevel
  table: TableKey | null
  code: string
  message: string
}

/** 隔离区条目：对不上结构或引用的原始行，绝不写入主库，等待人工修复后重新预检 */
export interface QuarantineEntry {
  table: TableKey
  /** 在备份数组中的下标（从 0 起，便于对照原文件） */
  index: number
  id: string
  /** 业务可读标签：场号 / 要素名 / 拍摄日 / 镜次 / 差异描述 */
  label: string
  reason: string
  raw: unknown
}

export interface PrecheckResult {
  sourceSchemaVersion: number
  /** 是否来自更旧结构（需要升级回填） */
  upgraded: boolean
  /** 通过全部校验、可直接 bulkPut 的普通对象行（已打修订号与时间戳） */
  accepted: Record<TableKey, Record<string, unknown>[]>
  acceptedCount: TableCounts
  /** 相对本机：备份有、本机无 */
  addedCount: TableCounts
  /** 相对本机：备份有、本机也有（覆盖） */
  updatedCount: TableCounts
  /** 相对本机：本机有、备份无（导入后被替换删除） */
  deletedCount: TableCounts
  quarantined: QuarantineEntry[]
  issues: ImportIssue[]
  /** 预检时刻的本机台账指纹，写入前必须一致，否则预检作废 */
  localFingerprint: string
  localCount: TableCounts
}

/** 导入前留存的本机整套数据（业务行原样，含修订号与时间戳） */
export interface LocalSnapshot {
  scenes: SceneRow[]
  elements: ElementRow[]
  shootDays: ShootDayRow[]
  records: RecordRow[]
  conflicts: ConflictRow[]
}

export type ImportJobStatus = 'prechecked' | 'writing' | 'succeeded' | 'rolled_back' | 'failed'

export interface ImportProgress {
  phase: 'snapshot' | 'clearing' | 'writing' | 'rolling-back' | 'done'
  table: TableKey | ''
  written: number
  total: number
  percent: number
}

/** 导入草稿：预检结论、原始备份文本、导入前快照、进度与错误都留在这里，刷新/换机内重启不丢 */
export interface ImportJobRow {
  id: string
  fileName: string
  sourceSchemaVersion: number
  status: ImportJobStatus
  /** 预检通过时的本机指纹 */
  localFingerprint: string
  rawText: string
  accepted: Record<TableKey, Record<string, unknown>[]>
  acceptedCount: TableCounts
  addedCount: TableCounts
  updatedCount: TableCounts
  deletedCount: TableCounts
  quarantined: QuarantineEntry[]
  issues: ImportIssue[]
  preImportSnapshot: LocalSnapshot | null
  progress: ImportProgress | null
  lastError: string
  createdAt: number
  updatedAt: number
  finishedAt: number | null
}

/* ------------------------------- 自定义错误 ------------------------------ */

/** 备份文件结构性错误（JSON / 根节点 / 版本 / 缺表），连预检都无法开始 */
export class BackupFormatError extends Error {}

/** 预检后本机台账发生过改动，预检结果作废 */
export class StalePrecheckError extends Error {}

/** 草稿状态不允许当前操作（如正在写入时再点写入） */
export class JobStateError extends Error {}

/* ------------------------------- 草稿库 ---------------------------------- */

class ImportJobDatabase extends Dexie {
  jobs!: Table<ImportJobRow, string>

  constructor() {
    super('gbcontinuity-import-db')
    this.version(1).stores({
      jobs: 'id, status, updatedAt'
    })
  }
}

export const jobDb = new ImportJobDatabase()

async function saveJob(patch: Partial<ImportJobRow> & Pick<ImportJobRow, 'id'>): Promise<void> {
  await jobDb.jobs.update(patch.id, { ...patch, updatedAt: Date.now() })
}

async function requireJob(jobId: string): Promise<ImportJobRow> {
  const job = await jobDb.jobs.get(jobId)
  if (!job) throw new JobStateError('导入草稿不存在或已被删除')
  return job
}

/* ------------------------------- 本机指纹 -------------------------------- */

/** FNV-1a 32 位摘要：足够检测台账的增删改，成本极低 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function snapshotFingerprint(snapshot: LocalSnapshot): string {
  const parts: string[] = []
  for (const key of TABLE_KEYS) {
    const rows = snapshot[key] as Array<{ id: unknown; updatedAt?: unknown }>
    const tokens = rows
      .map((row) => `${String(row.id)}:${typeof row.updatedAt === 'number' ? row.updatedAt : ''}`)
      .sort()
    parts.push(`${key}#${rows.length}#${tokens.join(',')}`)
  }
  return fnv1a(parts.join('|'))
}

async function collectLocalSnapshot(): Promise<LocalSnapshot> {
  const [scenes, elements, shootDays, records, conflicts] = await Promise.all([
    db.scenes.toArray(),
    db.elements.toArray(),
    db.shootDays.toArray(),
    db.records.toArray(),
    db.conflicts.toArray()
  ])
  return { scenes, elements, shootDays, records, conflicts }
}

/** 本机台账当前指纹：任何增删改（写库均会刷新 updatedAt）都会改变它 */
export async function currentFingerprint(): Promise<string> {
  return snapshotFingerprint(await collectLocalSnapshot())
}

/* ----------------------------- 备份解析与版本 ----------------------------- */

interface ParsedBackup {
  root: Record<string, unknown>
  sourceSchemaVersion: number
  tables: Record<TableKey, unknown[]>
}

/**
 * 解析备份文本并识别结构版本：
 * - schemaVersion 缺失视为 v0 历史备份（旧数据没有修订号）；
 * - 版本高于本机直接报错（让用户先升级应用，而不是写坏库）。
 */
export function parseBackupText(text: string): ParsedBackup {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new BackupFormatError('不是合法的 JSON 文本，请确认粘贴的是完整备份文件内容')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BackupFormatError('备份根节点必须是对象')
  }
  const root = parsed as Record<string, unknown>
  if (typeof root.name !== 'string' || root.name.trim() === '') {
    throw new BackupFormatError('缺少 name 字段，不是本应用的备份文件')
  }

  let sourceSchemaVersion = 0
  if ('schemaVersion' in root) {
    const version = root.schemaVersion
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
      throw new BackupFormatError('schemaVersion 字段必须是非负整数')
    }
    if (version > DB_SCHEMA_VERSION) {
      throw new BackupFormatError(
        `备份结构版本 v${version} 高于本机 v${DB_SCHEMA_VERSION}，请先在本机升级应用后再导入`
      )
    }
    sourceSchemaVersion = version
  }

  const tables = {} as Record<TableKey, unknown[]>
  for (const key of TABLE_KEYS) {
    const value = root[key]
    if (!Array.isArray(value)) {
      throw new BackupFormatError(`缺少 ${key} 数组字段（${TABLE_LABEL[key]}表），不是完整的整库备份`)
    }
    tables[key] = value
  }
  return { root, sourceSchemaVersion, tables }
}

/* ------------------------------- 行级校验 -------------------------------- */

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

interface RowCheck {
  /** 归一化后的业务字段（不含修订号），通过为对象，不通过为 null */
  row: Record<string, unknown> | null
  /** 不通过原因（进隔离区） */
  reason: string
  /** 被默认值/自动值补齐的字段名（汇总为 warning） */
  repaired: string[]
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function checkScene(raw: Record<string, unknown>): RowCheck {
  const repaired: string[] = []
  if (!nonEmptyString(raw.id)) return fail('缺少 id，无法定位场次行')
  if (!nonEmptyString(raw.sceneNo)) return fail('缺少必填字段 sceneNo（场号）')

  let place: string
  if (raw.place === undefined || raw.place === null || raw.place === '') {
    place = SCENE_PLACES[0]
    repaired.push('place')
  } else if (!enumValue(raw.place, SCENE_PLACES)) {
    return fail(`内外景取值非法：${String(raw.place)}（应为 ${SCENE_PLACES.join('/')}）`)
  } else {
    place = raw.place
  }

  let timeOfDay: string
  if (raw.timeOfDay === undefined || raw.timeOfDay === null || raw.timeOfDay === '') {
    timeOfDay = SCENE_TIMES[0]
    repaired.push('timeOfDay')
  } else if (!enumValue(raw.timeOfDay, SCENE_TIMES)) {
    return fail(`时间取值非法：${String(raw.timeOfDay)}（应为 ${SCENE_TIMES.join('/')}）`)
  } else {
    timeOfDay = raw.timeOfDay
  }

  let state: string
  if (raw.state === undefined || raw.state === null || raw.state === '') {
    state = SCENE_STATES[0]
    repaired.push('state')
  } else if (!enumValue(raw.state, SCENE_STATES)) {
    return fail(`场次状态取值非法：${String(raw.state)}（应为 ${SCENE_STATES.join('/')}）`)
  } else {
    state = raw.state
  }

  const location = optionalText(raw, 'location', repaired)
  if (location === null) return fail('location（地点）必须是文本')
  const excerpt = optionalText(raw, 'excerpt', repaired)
  if (excerpt === null) return fail('excerpt（剧本节选）必须是文本')

  let shootOrder: number
  if (raw.shootOrder === undefined || raw.shootOrder === null) {
    shootOrder = -1 // 占位，全部行过完后按备份顺序顺延补齐
    repaired.push('shootOrder')
  } else if (typeof raw.shootOrder !== 'number' || !Number.isFinite(raw.shootOrder)) {
    return fail('shootOrder（拍摄顺序）必须是数字')
  } else {
    shootOrder = raw.shootOrder
  }

  return {
    row: { id: raw.id, sceneNo: raw.sceneNo, place, timeOfDay, location, excerpt, shootOrder, state },
    reason: '',
    repaired
  }
}

function checkElement(raw: Record<string, unknown>): RowCheck {
  const repaired: string[] = []
  if (!nonEmptyString(raw.id)) return fail('缺少 id，无法定位要素行')
  if (!nonEmptyString(raw.sceneId)) return fail('缺少必填字段 sceneId（所属场次）')
  if (!nonEmptyString(raw.name)) return fail('缺少必填字段 name（要素名称）')

  let category: string
  if (raw.category === undefined || raw.category === null || raw.category === '') {
    category = ELEMENT_CATEGORIES[0]
    repaired.push('category')
  } else if (!enumValue(raw.category, ELEMENT_CATEGORIES)) {
    return fail(`要素类别取值非法：${String(raw.category)}（应为 ${ELEMENT_CATEGORIES.join('/')}）`)
  } else {
    category = raw.category
  }

  const initialState = optionalText(raw, 'initialState', repaired)
  if (initialState === null) return fail('initialState（初始状态）必须是文本')
  const owner = optionalText(raw, 'owner', repaired)
  if (owner === null) return fail('owner（责任人）必须是文本')

  let critical: boolean
  if (raw.critical === undefined || raw.critical === null) {
    critical = false
    repaired.push('critical')
  } else if (typeof raw.critical !== 'boolean') {
    return fail('critical（关键要素标记）必须是布尔值')
  } else {
    critical = raw.critical
  }

  return {
    row: { id: raw.id, sceneId: raw.sceneId, category, name: raw.name, initialState, owner, critical },
    reason: '',
    repaired
  }
}

function checkShootDay(raw: Record<string, unknown>): RowCheck {
  const repaired: string[] = []
  if (!nonEmptyString(raw.id)) return fail('缺少 id，无法定位拍摄日行')
  if (!nonEmptyString(raw.date) || !DATE_RE.test(raw.date)) {
    return fail('缺少或非法的 date（拍摄日期，应为 YYYY-MM-DD）')
  }

  let sceneIds: string[] = []
  if (raw.sceneIds === undefined || raw.sceneIds === null) {
    sceneIds = []
    repaired.push('sceneIds')
  } else if (!Array.isArray(raw.sceneIds)) {
    return fail('sceneIds（当日场次清单）必须是数组')
  } else {
    const bad = raw.sceneIds.some((item) => typeof item !== 'string')
    if (bad) return fail('sceneIds（当日场次清单）里的每一项都必须是场次 id 字符串')
    sceneIds = [...raw.sceneIds]
  }

  const director = optionalText(raw, 'director', repaired)
  if (director === null) return fail('director（导演）必须是文本')
  const scripty = optionalText(raw, 'scripty', repaired)
  if (scripty === null) return fail('scripty（场记）必须是文本')
  const weatherNote = optionalText(raw, 'weatherNote', repaired)
  if (weatherNote === null) return fail('weatherNote（现场备注）必须是文本')

  return {
    row: { id: raw.id, date: raw.date, sceneIds, director, scripty, weatherNote },
    reason: '',
    repaired
  }
}

function checkRecord(raw: Record<string, unknown>): RowCheck {
  const repaired: string[] = []
  if (!nonEmptyString(raw.id)) return fail('缺少 id，无法定位现场记录行')
  if (!nonEmptyString(raw.shootDayId)) return fail('缺少必填字段 shootDayId（拍摄日）')
  if (!nonEmptyString(raw.elementId)) return fail('缺少必填字段 elementId（连戏要素）')
  if (!nonEmptyString(raw.takeNo)) return fail('缺少必填字段 takeNo（镜次）')

  // sceneId 为冗余字段：缺失/非法先置空，跨表核对阶段按所属要素回填
  let sceneId: string | null
  if (typeof raw.sceneId === 'string') {
    sceneId = raw.sceneId
  } else if (raw.sceneId === undefined || raw.sceneId === null) {
    sceneId = null
    repaired.push('sceneId')
  } else {
    return fail('sceneId（所属场次）必须是字符串')
  }

  const currentState = optionalText(raw, 'currentState', repaired)
  if (currentState === null) return fail('currentState（当前状态）必须是文本')
  const photoNote = optionalText(raw, 'photoNote', repaired)
  if (photoNote === null) return fail('photoNote（照片说明）必须是文本')
  const recordedBy = optionalText(raw, 'recordedBy', repaired)
  if (recordedBy === null) return fail('recordedBy（记录人）必须是文本')

  const row: Record<string, unknown> = {
    id: raw.id,
    shootDayId: raw.shootDayId,
    elementId: raw.elementId,
    takeNo: raw.takeNo,
    currentState,
    photoNote,
    recordedBy
  }
  if (sceneId !== null) row.sceneId = sceneId
  return { row, reason: '', repaired }
}

function checkConflict(raw: Record<string, unknown>): RowCheck {
  const repaired: string[] = []
  if (!nonEmptyString(raw.id)) return fail('缺少 id，无法定位差异行')
  if (!nonEmptyString(raw.elementId)) return fail('缺少必填字段 elementId（连戏要素）')
  if (!nonEmptyString(raw.recordIdA)) return fail('缺少必填字段 recordIdA（较早记录）')
  if (!nonEmptyString(raw.recordIdB)) return fail('缺少必填字段 recordIdB（较晚记录）')

  let severity: string
  if (raw.severity === undefined || raw.severity === null || raw.severity === '') {
    severity = CONFLICT_SEVERITIES[0]
    repaired.push('severity')
  } else if (!enumValue(raw.severity, CONFLICT_SEVERITIES)) {
    return fail(`严重程度取值非法：${String(raw.severity)}（应为 ${CONFLICT_SEVERITIES.join('/')}）`)
  } else {
    severity = raw.severity
  }

  let state: string
  if (raw.state === undefined || raw.state === null || raw.state === '') {
    state = CONFLICT_STATES[0]
    repaired.push('state')
  } else if (!enumValue(raw.state, CONFLICT_STATES)) {
    return fail(`处理状态取值非法：${String(raw.state)}（应为 ${CONFLICT_STATES.join('/')}）`)
  } else {
    state = raw.state
  }

  const diffDesc = optionalText(raw, 'diffDesc', repaired)
  if (diffDesc === null) return fail('diffDesc（差异描述）必须是文本')
  const resolvedNote = optionalText(raw, 'resolvedNote', repaired)
  if (resolvedNote === null) return fail('resolvedNote（解决留痕）必须是文本')
  const resolvedAt = optionalText(raw, 'resolvedAt', repaired)
  if (resolvedAt === null) return fail('resolvedAt（解决时间）必须是文本')

  return {
    row: {
      id: raw.id,
      elementId: raw.elementId,
      recordIdA: raw.recordIdA,
      recordIdB: raw.recordIdB,
      diffDesc,
      severity,
      state,
      resolvedNote,
      resolvedAt
    },
    reason: '',
    repaired
  }
}

function fail(reason: string): RowCheck {
  return { row: null, reason, repaired: [] }
}

/** 可空文本字段：缺失补 ''，类型不对返回 null（调用方据此隔离） */
function optionalText(raw: Record<string, unknown>, field: string, repaired: string[]): string | null {
  const value = raw[field]
  if (value === undefined || value === null) {
    repaired.push(field)
    return ''
  }
  if (typeof value !== 'string') return null
  return value
}

const ROW_CHECKERS: Record<TableKey, (raw: Record<string, unknown>) => RowCheck> = {
  scenes: checkScene,
  elements: checkElement,
  shootDays: checkShootDay,
  records: checkRecord,
  conflicts: checkConflict
}

/** 业务可读标签，隔离清单里用来辨认行 */
export function quarantineLabel(table: TableKey, raw: Record<string, unknown>): string {
  const text = (value: unknown): string => (nonEmptyString(value) ? value : '（无）')
  switch (table) {
    case 'scenes':
      return `第 ${text(raw.sceneNo)} 场`
    case 'elements':
      return `${text(raw.name)}`
    case 'shootDays':
      return `拍摄日 ${text(raw.date)}`
    case 'records':
      return `镜次 ${text(raw.takeNo)}${nonEmptyString(raw.recordedBy) ? ` · ${raw.recordedBy}` : ''}`
    case 'conflicts':
      return text(raw.diffDesc)
  }
}

/* ------------------------------- 预检主流程 ------------------------------- */

interface Candidate {
  index: number
  raw: Record<string, unknown>
  row: Record<string, unknown>
}

/** 按当前行结构回填修订号与时间戳；旧数据缺 revision 时按 ROW_REVISION 补齐 */
function stampRow(row: Record<string, unknown>, raw: Record<string, unknown>): boolean {
  const now = Date.now()
  let backfilled = false
  if (typeof raw.revision === 'number' && Number.isFinite(raw.revision)) {
    row.revision = raw.revision
  } else {
    row.revision = ROW_REVISION
    backfilled = true
  }
  if (typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)) {
    row.createdAt = raw.createdAt
  } else {
    row.createdAt = now
    backfilled = true
  }
  if (typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)) {
    row.updatedAt = raw.updatedAt
  } else {
    row.updatedAt = row.createdAt
  }
  return backfilled
}

const REPAIR_LABELS: Record<string, string> = {
  'scenes.place': '内外景',
  'scenes.timeOfDay': '时间',
  'scenes.state': '场次状态',
  'scenes.location': '地点',
  'scenes.excerpt': '剧本节选',
  'scenes.shootOrder': '拍摄顺序',
  'elements.category': '要素类别',
  'elements.initialState': '初始状态',
  'elements.owner': '责任人',
  'elements.critical': '关键要素标记',
  'shootDays.sceneIds': '当日场次清单',
  'shootDays.director': '导演',
  'shootDays.scripty': '场记',
  'shootDays.weatherNote': '现场备注',
  'records.sceneId': '所属场次（按要素回填）',
  'records.currentState': '当前状态',
  'records.photoNote': '照片说明',
  'records.recordedBy': '记录人',
  'conflicts.severity': '严重程度',
  'conflicts.state': '处理状态',
  'conflicts.diffDesc': '差异描述',
  'conflicts.resolvedNote': '解决留痕',
  'conflicts.resolvedAt': '解决时间'
}

/**
 * 预检整库备份：只读、绝不写业务库。
 * 输出：可落地行（含新增/覆盖/被删计数）、隔离清单、汇总问题、本机指纹。
 */
export async function precheckBackup(text: string): Promise<PrecheckResult> {
  const parsed = parseBackupText(text)
  const local = await collectLocalSnapshot()
  const localFingerprint = snapshotFingerprint(local)

  const localIds = {} as Record<TableKey, Set<string>>
  const localCount = { ...ZERO_COUNTS }
  for (const key of TABLE_KEYS) {
    localIds[key] = new Set(local[key].map((row) => row.id))
    localCount[key] = local[key].length
  }

  const candidates = {} as Record<TableKey, Candidate[]>
  const quarantined: QuarantineEntry[] = []
  const repairCounts: Record<string, number> = {}
  const revisionBackfill = { ...ZERO_COUNTS }

  // 第一轮：结构 / 必填 / 枚举校验 + 表内 id 去重
  for (const key of TABLE_KEYS) {
    const list: Candidate[] = []
    const seen = new Map<string, number>()
    parsed.tables[key].forEach((value, index) => {
      if (!isPlainRecord(value)) {
        quarantined.push({
          table: key,
          index,
          id: '',
          label: `第 ${index + 1} 行`,
          reason: '不是对象结构，无法按当前表结构读取',
          raw: value
        })
        return
      }
      const check = ROW_CHECKERS[key](value)
      if (!check.row) {
        quarantined.push({
          table: key,
          index,
          id: nonEmptyString(value.id) ? value.id : '',
          label: quarantineLabel(key, value),
          reason: check.reason,
          raw: value
        })
        return
      }
      const id = check.row.id as string
      const firstIndex = seen.get(id)
      if (firstIndex !== undefined) {
        quarantined.push({
          table: key,
          index,
          id,
          label: quarantineLabel(key, value),
          reason: `id 与本备份中第 ${firstIndex + 1} 行重复，同表 id 必须唯一`,
          raw: value
        })
        return
      }
      seen.set(id, index)
      for (const field of check.repaired) {
        const code = `${key}.${field}`
        repairCounts[code] = (repairCounts[code] ?? 0) + 1
      }
      list.push({ index, raw: value, row: check.row })
    })
    candidates[key] = list
  }

  // 为缺 shootOrder 的场次按备份顺序顺延补齐
  const maxOrder = candidates.scenes.reduce((max, item) => {
    const order = item.row.shootOrder as number
    return order > 0 ? Math.max(max, order) : max
  }, 0)
  let autoOrder = maxOrder
  for (const item of candidates.scenes) {
    if ((item.row.shootOrder as number) < 0) {
      autoOrder += 1
      item.row.shootOrder = autoOrder
    }
  }

  // 第二轮：跨表引用（只在通过结构校验的行之间核对）
  const sceneIds = new Set(candidates.scenes.map((item) => item.row.id as string))
  const elementIds = new Set(candidates.elements.map((item) => item.row.id as string))
  const elementScene = new Map(
    candidates.elements.map((item) => [item.row.id as string, item.row.sceneId as string])
  )
  const shootDayIds = new Set(candidates.shootDays.map((item) => item.row.id as string))
  const recordIds = new Set(candidates.records.map((item) => item.row.id as string))

  const quarantine = (key: TableKey, item: Candidate, reason: string): void => {
    quarantined.push({
      table: key,
      index: item.index,
      id: item.row.id as string,
      label: quarantineLabel(key, item.raw),
      reason,
      raw: item.raw
    })
  }

  // elements.sceneId → scenes
  candidates.elements = candidates.elements.filter((item) => {
    if (sceneIds.has(item.row.sceneId as string)) return true
    quarantine('elements', item, `找不到所属场次（sceneId=${String(item.row.sceneId)}）`)
    return false
  })

  // shootDays.sceneIds[] → scenes：多对多关联只剔除悬空 id，不隔离整个拍摄日
  let prunedDayLinks = 0
  for (const day of candidates.shootDays) {
    const refs = day.row.sceneIds as string[]
    const kept = refs.filter((ref) => sceneIds.has(ref))
    if (kept.length !== refs.length) {
      prunedDayLinks += refs.length - kept.length
      day.row.sceneIds = kept
    }
  }

  // records.elementId / shootDayId → elements / shootDays（现场记录悬空必须列清并隔离）
  let sceneIdFilled = 0
  let sceneIdRealigned = 0
  candidates.records = candidates.records.filter((item) => {
    const reasons: string[] = []
    const elementId = item.row.elementId as string
    const shootDayId = item.row.shootDayId as string
    if (!elementIds.has(elementId)) reasons.push(`找不到连戏要素（elementId=${elementId}）`)
    if (!shootDayIds.has(shootDayId)) reasons.push(`找不到拍摄日（shootDayId=${shootDayId}）`)
    if (reasons.length > 0) {
      quarantine('records', item, reasons.join('；'))
      return false
    }
    const ownerScene = elementScene.get(elementId) ?? ''
    if (typeof item.row.sceneId !== 'string') {
      item.row.sceneId = ownerScene
      sceneIdFilled += 1
    } else if (item.row.sceneId !== ownerScene) {
      item.row.sceneId = ownerScene
      sceneIdRealigned += 1
    }
    return true
  })

  // conflicts.elementId / recordIdA / recordIdB
  candidates.conflicts = candidates.conflicts.filter((item) => {
    const reasons: string[] = []
    const elementId = item.row.elementId as string
    const recordA = item.row.recordIdA as string
    const recordB = item.row.recordIdB as string
    if (!elementIds.has(elementId)) reasons.push(`找不到连戏要素（elementId=${elementId}）`)
    if (!recordIds.has(recordA)) reasons.push(`找不到较早现场记录（recordIdA=${recordA}）`)
    if (!recordIds.has(recordB)) reasons.push(`找不到较晚现场记录（recordIdB=${recordB}）`)
    if (reasons.length > 0) {
      quarantine('conflicts', item, reasons.join('；'))
      return false
    }
    return true
  })

  // 第三轮：打修订号 / 时间戳，产出最终可写入行
  const accepted = {} as Record<TableKey, Record<string, unknown>[]>
  const acceptedCount = { ...ZERO_COUNTS }
  const addedCount = { ...ZERO_COUNTS }
  const updatedCount = { ...ZERO_COUNTS }
  const deletedCount = { ...ZERO_COUNTS }
  for (const key of TABLE_KEYS) {
    const rows = candidates[key].map((item) => {
      if (stampRow(item.row, item.raw)) revisionBackfill[key] += 1
      return item.row
    })
    accepted[key] = rows
    acceptedCount[key] = rows.length
    const incomingIds = new Set(rows.map((row) => row.id as string))
    addedCount[key] = [...incomingIds].filter((id) => !localIds[key].has(id)).length
    updatedCount[key] = [...incomingIds].filter((id) => localIds[key].has(id)).length
    deletedCount[key] = [...localIds[key]].filter((id) => !incomingIds.has(id)).length
  }

  // 汇总问题
  const issues: ImportIssue[] = []
  if (parsed.sourceSchemaVersion < DB_SCHEMA_VERSION) {
    issues.push({
      level: 'warning',
      table: null,
      code: 'schema-upgrade',
      message: `备份来自旧结构 v${parsed.sourceSchemaVersion}，将按当前结构 v${DB_SCHEMA_VERSION} 升级落地`
    })
    for (const key of TABLE_KEYS) {
      if (revisionBackfill[key] > 0) {
        issues.push({
          level: 'warning',
          table: key,
          code: 'revision-backfilled',
          message: `${TABLE_LABEL[key]}表 ${revisionBackfill[key]} 行旧数据缺少修订号/时间戳，已按当前结构回填（revision=${ROW_REVISION}）`
        })
      }
    }
  }
  for (const [code, count] of Object.entries(repairCounts)) {
    const table = code.split('.')[0] as TableKey
    const field = code.slice(table.length + 1)
    issues.push({
      level: 'warning',
      table,
      code,
      message: `${TABLE_LABEL[table]}表 ${count} 行缺少「${REPAIR_LABELS[code] ?? field}」，已按默认规则补齐`
    })
  }
  if (prunedDayLinks > 0) {
    issues.push({
      level: 'warning',
      table: 'shootDays',
      code: 'shootday-scene-pruned',
      message: `${prunedDayLinks} 个拍摄日关联的场次在备份中不存在，已剔除悬空关联（拍摄日本身保留）`
    })
  }
  if (sceneIdFilled > 0) {
    issues.push({
      level: 'warning',
      table: 'records',
      code: 'record-scene-filled',
      message: `${sceneIdFilled} 条现场记录缺少所属场次，已按连戏要素所属场次回填`
    })
  }
  if (sceneIdRealigned > 0) {
    issues.push({
      level: 'warning',
      table: 'records',
      code: 'record-scene-realigned',
      message: `${sceneIdRealigned} 条现场记录的所属场次与连戏要素不一致，已按要素场次校正`
    })
  }
  const danglingRecords = quarantined.filter(
    (item) => item.table === 'records' && (item.reason.includes('连戏要素') || item.reason.includes('拍摄日'))
  ).length
  if (danglingRecords > 0) {
    issues.push({
      level: 'danger',
      table: 'records',
      code: 'dangling-records',
      message: `${danglingRecords} 条现场记录找不到连戏要素或拍摄日，已隔离待修，不会写入本机`
    })
  }
  const totalDeleted = TABLE_KEYS.reduce((sum, key) => sum + deletedCount[key], 0)
  if (totalDeleted > 0) {
    issues.push({
      level: 'warning',
      table: null,
      code: 'local-replaced',
      message: `本机有 ${totalDeleted} 行不在备份内，导入后将被替换删除；导入前会自动留存整套数据快照，可随时回滚`
    })
  }

  return {
    sourceSchemaVersion: parsed.sourceSchemaVersion,
    upgraded: parsed.sourceSchemaVersion < DB_SCHEMA_VERSION,
    accepted,
    acceptedCount,
    addedCount,
    updatedCount,
    deletedCount,
    quarantined,
    issues,
    localFingerprint,
    localCount
  }
}

/* ------------------------------- 草稿管理 -------------------------------- */

/** 预检通过后立即落草稿：刷新页面 / 重开浏览器都能继续或重试 */
export async function createImportJob(fileName: string, rawText: string, result: PrecheckResult): Promise<string> {
  const now = Date.now()
  const job: ImportJobRow = {
    id: createId('importjob'),
    fileName: fileName || '粘贴的备份内容',
    sourceSchemaVersion: result.sourceSchemaVersion,
    status: 'prechecked',
    localFingerprint: result.localFingerprint,
    rawText,
    accepted: result.accepted,
    acceptedCount: result.acceptedCount,
    addedCount: result.addedCount,
    updatedCount: result.updatedCount,
    deletedCount: result.deletedCount,
    quarantined: result.quarantined,
    issues: result.issues,
    preImportSnapshot: null,
    progress: null,
    lastError: '',
    createdAt: now,
    updatedAt: now,
    finishedAt: null
  }
  await jobDb.jobs.put(job)
  return job.id
}

export async function listImportJobs(): Promise<ImportJobRow[]> {
  const rows = await jobDb.jobs.toArray()
  return rows.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getImportJob(jobId: string): Promise<ImportJobRow | undefined> {
  return jobDb.jobs.get(jobId)
}

export async function deleteImportJob(jobId: string): Promise<void> {
  await jobDb.jobs.delete(jobId)
}

/** 台账改动后用草稿原文重新预检，覆盖旧结论（快照与进度随之作废，回到待导入） */
export async function refreshJobPrecheck(jobId: string, result: PrecheckResult): Promise<void> {
  await requireJob(jobId)
  await saveJob({
    id: jobId,
    sourceSchemaVersion: result.sourceSchemaVersion,
    status: 'prechecked',
    localFingerprint: result.localFingerprint,
    accepted: result.accepted,
    acceptedCount: result.acceptedCount,
    addedCount: result.addedCount,
    updatedCount: result.updatedCount,
    deletedCount: result.deletedCount,
    quarantined: result.quarantined,
    issues: result.issues,
    preImportSnapshot: null,
    progress: null,
    lastError: '',
    finishedAt: null
  })
}

/* ------------------------------- 分批落地 -------------------------------- */

/** 单批行数：每批一个独立事务，批间让出主线程，避免大库一次写入超时/卡死 */
export const IMPORT_CHUNK_SIZE = 100

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function bulkPutRows(key: TableKey, rows: Record<string, unknown>[]): Promise<void> {
  switch (key) {
    case 'scenes':
      await db.scenes.bulkPut(rows as unknown as SceneRow[])
      break
    case 'elements':
      await db.elements.bulkPut(rows as unknown as ElementRow[])
      break
    case 'shootDays':
      await db.shootDays.bulkPut(rows as unknown as ShootDayRow[])
      break
    case 'records':
      await db.records.bulkPut(rows as unknown as RecordRow[])
      break
    case 'conflicts':
      await db.conflicts.bulkPut(rows as unknown as ConflictRow[])
      break
  }
}

async function clearBusinessTables(): Promise<void> {
  await db.transaction('rw', [db.scenes, db.elements, db.shootDays, db.records, db.conflicts], async () => {
    await Promise.all([
      db.scenes.clear(),
      db.elements.clear(),
      db.shootDays.clear(),
      db.records.clear(),
      db.conflicts.clear()
    ])
  })
}

/** 按导入前快照恢复整套本机数据（分批写，回报进度） */
export async function restoreSnapshot(snapshot: LocalSnapshot, onProgress?: (p: ImportProgress) => void): Promise<void> {
  const total = TABLE_KEYS.reduce((sum, key) => sum + snapshot[key].length, 0)
  await clearBusinessTables()
  let written = 0
  for (const key of TABLE_KEYS) {
    const rows = snapshot[key] as unknown as Record<string, unknown>[]
    for (let start = 0; start < rows.length; start += IMPORT_CHUNK_SIZE) {
      const chunk = rows.slice(start, start + IMPORT_CHUNK_SIZE)
      await bulkPutRows(key, chunk)
      written += chunk.length
      onProgress?.({
        phase: 'rolling-back',
        table: key,
        written,
        total,
        percent: total === 0 ? 100 : Math.round((written / total) * 100)
      })
      await tick()
    }
  }
}

async function assertFingerprintFresh(job: ImportJobRow): Promise<void> {
  const fingerprint = await currentFingerprint()
  if (fingerprint !== job.localFingerprint) {
    throw new StalePrecheckError('本机台账在预检后发生过改动，预检结果已作废，请重新预检后再导入')
  }
}

/**
 * 执行导入：写入前复核指纹 → 留存导入前整套数据 → 清空替换 → 分批写入。
 * 任何一步失败都自动恢复到导入前；成功后快照仍保留在草稿中，可手动回滚。
 */
export async function beginImport(jobId: string, onProgress?: (p: ImportProgress) => void): Promise<void> {
  const job = await requireJob(jobId)
  if (job.status === 'succeeded') throw new JobStateError('该备份已经导入完成，无需再次写入')
  if (job.status === 'writing') throw new JobStateError('该草稿正在写入中')
  // 指纹必须在任何状态/数据变更之前校验：作废时草稿仍停留在 prechecked，可直接重新预检
  await assertFingerprintFresh(job)

  const report = (p: ImportProgress): void => {
    onProgress?.(p)
    void saveJob({ id: jobId, progress: p })
  }

  try {
    await saveJob({ id: jobId, status: 'writing', lastError: '', finishedAt: null })
    report({ phase: 'snapshot', table: '', written: 0, total: 0, percent: 0 })

    const snapshot = await collectLocalSnapshot()
    await saveJob({ id: jobId, preImportSnapshot: snapshot })

    report({ phase: 'clearing', table: '', written: 0, total: 0, percent: 0 })
    await clearBusinessTables()

    const total = TABLE_KEYS.reduce((sum, key) => sum + job.acceptedCount[key], 0)
    let written = 0
    report({ phase: 'writing', table: TABLE_KEYS[0], written: 0, total, percent: 0 })
    for (const key of TABLE_KEYS) {
      const rows = job.accepted[key]
      for (let start = 0; start < rows.length; start += IMPORT_CHUNK_SIZE) {
        const chunk = rows.slice(start, start + IMPORT_CHUNK_SIZE)
        await bulkPutRows(key, chunk)
        written += chunk.length
        report({
          phase: 'writing',
          table: key,
          written,
          total,
          percent: total === 0 ? 100 : Math.round((written / total) * 100)
        })
        await tick()
      }
    }

    report({ phase: 'done', table: '', written: total, total, percent: 100 })
    await saveJob({ id: jobId, status: 'succeeded', finishedAt: Date.now(), lastError: '' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const snapshot = (await getImportJob(jobId))?.preImportSnapshot ?? null
    if (snapshot) {
      try {
        await restoreSnapshot(snapshot, onProgress)
        // 回滚后台账已恢复，指纹重记为当前值，否则重试时会被当成「预检后改动」误拦
        const restoredFingerprint = await currentFingerprint()
        await saveJob({
          id: jobId,
          status: 'rolled_back',
          localFingerprint: restoredFingerprint,
          lastError: message,
          progress: null,
          finishedAt: Date.now()
        })
      } catch (rollbackError) {
        await saveJob({
          id: jobId,
          status: 'failed',
          lastError: `${message}；自动回滚也失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          progress: null,
          finishedAt: Date.now()
        })
      }
    } else {
      await saveJob({ id: jobId, status: 'failed', lastError: message, progress: null, finishedAt: Date.now() })
    }
    throw error
  }
}

/** 失败/回滚后的重试：指纹仍与预检一致才允许，否则要求重新预检 */
export async function retryImport(jobId: string, onProgress?: (p: ImportProgress) => void): Promise<void> {
  const job = await requireJob(jobId)
  if (job.status !== 'prechecked' && job.status !== 'rolled_back') {
    throw new JobStateError('当前草稿状态不允许重试，请重新预检')
  }
  await assertFingerprintFresh(job)
  await beginImport(jobId, onProgress)
}

/** 导入成功后手动回到导入前（快照一直留存在草稿里） */
export async function rollbackImport(jobId: string, onProgress?: (p: ImportProgress) => void): Promise<void> {
  const job = await requireJob(jobId)
  if (!job.preImportSnapshot) throw new JobStateError('草稿里没有导入前快照，无法回滚')
  await restoreSnapshot(job.preImportSnapshot, onProgress)
  await saveJob({
    id: jobId,
    status: 'rolled_back',
    localFingerprint: await currentFingerprint(),
    progress: null,
    lastError: '已手动恢复到导入前',
    finishedAt: Date.now()
  })
}

/**
 * 页面打开时调用：恢复上次因关闭页面 / 崩溃而停在 writing 的导入。
 * 快照在清空业务表之前就已落草稿，因此这里能完整还原。
 */
export async function recoverInterruptedJobs(): Promise<ImportJobRow[]> {
  const interrupted = (await listImportJobs()).filter((job) => job.status === 'writing')
  const recovered: ImportJobRow[] = []
  for (const job of interrupted) {
    if (job.preImportSnapshot) {
      try {
        await restoreSnapshot(job.preImportSnapshot)
        await saveJob({
          id: job.id,
          status: 'rolled_back',
          localFingerprint: await currentFingerprint(),
          progress: null,
          lastError: '检测到上次导入中途退出，已自动恢复到导入前',
          finishedAt: Date.now()
        })
      } catch (error) {
        await saveJob({
          id: job.id,
          status: 'failed',
          progress: null,
          lastError: `上次导入中断且自动恢复失败：${error instanceof Error ? error.message : String(error)}`,
          finishedAt: Date.now()
        })
      }
    } else {
      // 快照尚未留存意味着业务表还没开始清空，直接退回待导入
      await saveJob({ id: job.id, status: 'prechecked', progress: null })
    }
    const updated = await getImportJob(job.id)
    if (updated) recovered.push(updated)
  }
  return recovered
}
