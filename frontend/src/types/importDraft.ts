/**
 * 整库备份导入：预检结果、隔离待修行、导入草稿与导入前快照的类型定义。
 * 预检（importPrecheck）、分批落地（importRunner）与导入 store 共同消费。
 */
import type { Scene } from './scene'
import type { Element } from './element'
import type { ShootDay } from './shootDay'
import type { Record as ContinuityRecord } from './record'
import type { Conflict } from './conflict'
import type { SceneRow, ElementRow, ShootDayRow, RecordRow, ConflictRow } from '@/utils/db'

/** 备份中的五张业务表（不含 importMeta 元信息表） */
export type BackupTableKey = 'scenes' | 'elements' | 'shootDays' | 'records' | 'conflicts'

/** 预检 / 写入时固定的表顺序：被引用方在前，引用方在后 */
export const BACKUP_TABLE_KEYS: BackupTableKey[] = ['scenes', 'elements', 'shootDays', 'records', 'conflicts']

export const TABLE_LABELS: Record<BackupTableKey, string> = {
  scenes: '场次',
  elements: '连戏要素',
  shootDays: '拍摄日',
  records: '现场记录',
  conflicts: '连戏差异'
}

/** 不带行修订信息的备份行（备份导出时会剥掉 revision/时间戳） */
export type BackupRowByTable = {
  scenes: Scene
  elements: Element
  shootDays: ShootDay
  records: ContinuityRecord
  conflicts: Conflict
}

/** 预检通过、已按当前结构补齐修订号、可直接写库的行 */
export interface PreparedRows {
  scenes: SceneRow[]
  elements: ElementRow[]
  shootDays: ShootDayRow[]
  records: RecordRow[]
  conflicts: ConflictRow[]
}

/** 问题类别：阻断类会隔离该行，repaired 类只告警不阻断 */
export type IssueCode =
  | 'missing-field' // 必填字段缺失 / 为空
  | 'invalid-enum' // 枚举值不在当前结构允许范围内
  | 'invalid-type' // 字段类型不对
  | 'invalid-id' // 缺少主键 id
  | 'duplicate-id' // 备份内主键重复
  | 'missing-reference' // 跨表引用悬空（找不到连戏要素 / 拍摄日 / 场次 / 现场记录）
  | 'backfill-revision' // 旧数据缺修订号 / 时间戳，已按当前结构回填
  | 'backfill-default' // 可选字段缺失，已按默认值补齐
  | 'drop-dangling-ref' // 多值引用（拍摄日场次清单）中的悬空项已剔除

export interface ImportIssue {
  id: string
  table: BackupTableKey
  /** 问题所在行的主键；缺 id 的坏行用「第 N 行」占位 */
  rowKey: string
  code: IssueCode
  /** 字段名（跨表引用时给出外键字段） */
  field?: string
  message: string
  /** true = 已自动修复（仅告警，不隔离）；false = 无法修复，该行隔离待修 */
  repaired: boolean
}

/** 隔离区中的坏行：原始内容 + 全部问题，供导出后人工修复再重试 */
export interface QuarantinedRow {
  table: BackupTableKey
  rowKey: string
  /** 行的可读标题，如「现场记录 镜次 3」 */
  title: string
  raw: unknown
  issues: ImportIssue[]
}

export interface TableImportStats {
  table: BackupTableKey
  label: string
  /** 备份内总行数 */
  total: number
  /** 通过预检可写入 */
  valid: number
  /** 本机不存在同 id，写入后为净新增 */
  added: number
  /** 本机已存在同 id，写入后为覆盖 */
  overwritten: number
  /** 隔离待修、不会写库 */
  quarantined: number
  /** 自动修复（回填修订号 / 默认值等）的行数 */
  repaired: number
}

export type PrecheckPhase = 'pass' | 'pass-with-quarantine' | 'fail'

export interface PrecheckTotals {
  input: number
  valid: number
  added: number
  overwritten: number
  quarantined: number
  repaired: number
}

export interface PrecheckResult {
  checkedAt: number
  /** 预检时本机台账指纹；落地前若指纹变化，本次预检作废 */
  localFingerprint: string
  sourceSchemaVersion: number
  targetSchemaVersion: number
  sourceExportedAt: string
  /** 旧结构版本 < 当前版本，逐行做了升级回填 */
  upgraded: boolean
  phase: PrecheckPhase
  stats: TableImportStats[]
  totals: PrecheckTotals
  validRows: PreparedRows
  /** 全部问题：含已自动修复的告警与导致隔离的阻断问题 */
  issues: ImportIssue[]
  quarantined: QuarantinedRow[]
  /** 根级致命错误（如备份结构版本高于本机），phase=fail 时给出 */
  fatalErrors: string[]
}

/** 导入前整套本机数据留底（存在 IndexedDB 的 importMeta 表，也可另存下载） */
export interface PreImportSnapshot {
  savedAt: number
  reason: string
  /** 留底时刻的台账指纹，用于回滚后核对 */
  fingerprint: string
  data: PreparedRows
}

/** 可重试的导入草稿：备份原文 + 最近一次预检结果 */
export interface ImportDraft {
  draftId: string
  createdAt: number
  updatedAt: number
  fileName: string
  backupText: string
  precheck: PrecheckResult | null
}

/** 分批写入进度 */
export interface ImportProgress {
  stage: 'clearing' | 'writing' | 'restoring'
  table: BackupTableKey | null
  tableIndex: number
  tableCount: number
  /** 当前表已写行数 */
  doneRows: number
  /** 当前表总行数 */
  totalRows: number
  /** 全部表合计 0~100 */
  percent: number
}

/** parseBackup 的产物：根结构已验过，行内容尚未核对 */
export interface RawBackup {
  name: string
  schemaVersion: number
  exportedAt: string
  rows: Record<BackupTableKey, unknown[]>
}
