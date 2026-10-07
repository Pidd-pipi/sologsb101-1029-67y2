/**
 * 连戏核对报告 JSON 序列化与校验
 * 报告页用于导出整份核对报告，也是「导入导出备份」的数据校验入口。
 */
import type { Scene } from '../types/scene'
import type { Element } from '../types/element'
import type { ShootDay } from '../types/shootDay'
import type { Record as ContinuityRecord } from '../types/record'
import type { Conflict } from '../types/conflict'
import { SEVERITY_WEIGHT } from './diff'
import { DB_NAME, DB_SCHEMA_VERSION, listConflicts, listElements, listRecords, listScenes, listShootDays } from './db'
import { nowIso } from './uuid'

/** 单个场次的核对小结 */
export interface SceneReportRow {
  sceneId: string
  sceneNo: string
  place: string
  timeOfDay: string
  location: string
  state: string
  elementCount: number
  criticalElementCount: number
  openConflictCount: number
  resolvedConflictCount: number
  shootDayCount: number
}

/** 连戏核对报告 */
export interface ContinuityReport {
  name: string
  schemaVersion: number
  exportedAt: string
  scenes: Scene[]
  elements: Element[]
  shootDays: ShootDay[]
  records: ContinuityRecord[]
  conflicts: Conflict[]
  summary: {
    sceneCount: number
    elementCount: number
    recordCount: number
    openConflictCount: number
    blockedConflictCount: number
    resolvedConflictCount: number
    /** 未解决冲突最多的场次 */
    riskiestSceneNo: string
    rows: SceneReportRow[]
  }
}

type WithRevision = { revision?: number; createdAt?: number; updatedAt?: number }

function stripRevision<T extends WithRevision>(row: T): T {
  const copy = { ...row } as Record<string, unknown>
  delete copy.revision
  delete copy.createdAt
  delete copy.updatedAt
  return copy as T
}

/** 汇总整份连戏核对报告 */
export async function buildReport(): Promise<ContinuityReport> {
  const [scenes, elements, shootDays, records, conflicts] = await Promise.all([
    listScenes(),
    listElements(),
    listShootDays(),
    listRecords(),
    listConflicts()
  ])

  const rows: SceneReportRow[] = scenes.map((scene) => {
    const sceneElements = elements.filter((item) => item.sceneId === scene.id)
    const elementIds = sceneElements.map((item) => item.id)
    const sceneConflicts = conflicts.filter((item) => elementIds.includes(item.elementId))
    return {
      sceneId: scene.id,
      sceneNo: scene.sceneNo,
      place: scene.place,
      timeOfDay: scene.timeOfDay,
      location: scene.location,
      state: scene.state,
      elementCount: sceneElements.length,
      criticalElementCount: sceneElements.filter((item) => item.critical).length,
      openConflictCount: sceneConflicts.filter((item) => item.state === '待确认').length,
      resolvedConflictCount: sceneConflicts.filter((item) => item.state === '已解决').length,
      shootDayCount: shootDays.filter((day) => day.sceneIds.includes(scene.id)).length
    }
  })

  const riskiest = [...rows].sort(
    (a, b) => b.openConflictCount - a.openConflictCount || b.criticalElementCount - a.criticalElementCount
  )[0]

  const openConflicts = conflicts.filter((item) => item.state === '待确认')

  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    scenes: scenes.map(stripRevision),
    elements: elements.map(stripRevision),
    shootDays: shootDays.map(stripRevision),
    records: records.map(stripRevision),
    conflicts: conflicts.map(stripRevision),
    summary: {
      sceneCount: scenes.length,
      elementCount: elements.length,
      recordCount: records.length,
      openConflictCount: openConflicts.length,
      blockedConflictCount: openConflicts.filter((item) => item.severity === '阻断').length,
      resolvedConflictCount: conflicts.filter((item) => item.state === '已解决').length,
      riskiestSceneNo: riskiest ? riskiest.sceneNo : '—',
      rows
    }
  }
}

/** 严重程度加权后的风险分：用于报告页排序 */
export function riskScore(conflicts: Conflict[]): number {
  return conflicts.reduce((sum, item) => sum + SEVERITY_WEIGHT[item.severity], 0)
}

export function serializeReport(report: ContinuityReport): string {
  return JSON.stringify(report, null, 2)
}

/** 校验并解析报告 / 备份 JSON，失败时抛出可读错误 */
export function parseReport(text: string): ContinuityReport {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('不是合法的 JSON 文本')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('报告根节点必须是对象')
  }
  const candidate = parsed as Partial<ContinuityReport>
  if (typeof candidate.name !== 'string') throw new Error('缺少 name 字段')
  if (typeof candidate.schemaVersion !== 'number') throw new Error('缺少 schemaVersion 字段')
  if (!Array.isArray(candidate.scenes)) throw new Error('scenes 必须是数组')
  if (!Array.isArray(candidate.conflicts)) throw new Error('conflicts 必须是数组')
  return candidate as ContinuityReport
}

/** 触发浏览器下载（纯前端，无需后端） */
export function downloadJson(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
