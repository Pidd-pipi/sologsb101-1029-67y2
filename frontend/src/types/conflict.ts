/** 差异严重程度 */
export type ConflictSeverity = '轻微' | '需处理' | '阻断'
/** 差异处理状态 */
export type ConflictState = '待确认' | '已解决'

/** 连戏差异：同一要素两次现场记录之间的字段级偏差 */
export interface Conflict {
  id: string
  /** 连戏要素 */
  elementId: string
  /** 较早的记录 */
  recordIdA: string
  /** 较晚的记录 */
  recordIdB: string
  /** 差异描述 */
  diffDesc: string
  /** 严重程度 */
  severity: ConflictSeverity
  /** 处理状态 */
  state: ConflictState
  /** 解决留痕（解决时间与处理说明） */
  resolvedNote: string
  /** 解决时间（ISO，未解决为空串） */
  resolvedAt: string
}

export const CONFLICT_SEVERITIES: ConflictSeverity[] = ['轻微', '需处理', '阻断']
export const CONFLICT_STATES: ConflictState[] = ['待确认', '已解决']

export function createEmptyConflict(): Omit<Conflict, 'id' | 'resolvedNote' | 'resolvedAt'> {
  return { elementId: '', recordIdA: '', recordIdB: '', diffDesc: '', severity: '轻微', state: '待确认' }
}
