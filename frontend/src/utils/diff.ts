/**
 * 连戏差异算法：字段级比对 + 状态文本归一化 + 严重程度权重
 * 被差异比对页、现场记录页与差异 hook 共同消费。
 */
import type { ConflictSeverity } from '../types/conflict'
import type { Record as ContinuityRecord } from '../types/record'

/** 单条字段级差异 */
export interface FieldDiff {
  field: keyof Pick<ContinuityRecord, 'takeNo' | 'currentState' | 'photoNote'>
  label: string
  a: string
  b: string
}

/** 同义写法分组：组内任一写法都归一为组首写法，避免「藏青 / 深蓝」被误判为差异 */
const SYNONYM_GROUPS: string[][] = [
  ['深蓝', '藏青', '宝蓝', '海军蓝', '靛蓝'],
  ['浅蓝', '天蓝', '湖蓝', '淡蓝'],
  ['深红', '酒红', '枣红', '绛红', '暗红'],
  ['米白', '乳白', '象牙白', '本白', '奶白'],
  ['浅灰', '烟灰', '银灰', '灰'],
  ['深棕', '咖啡色', '褐色', '咖色'],
  ['黑色', '纯黑', '乌黑'],
  ['白色', '纯白']
]

/** 状态文本归一化：去空白与标点、统一小写、同义词归组 */
export function normalizeStateText(text: string): string {
  let normalized = text
    .trim()
    .toLowerCase()
    .replace(/[\s,，。;；、/|·-]+/g, '')
    .replace(/[（(].*?[)）]/g, '')
  SYNONYM_GROUPS.forEach((group) => {
    const canonical = group[0]
    group.slice(1).forEach((alias) => {
      normalized = normalized.split(alias).join(canonical)
    })
  })
  return normalized
}

/** 两次现场记录的字段级比对（归一化后仍不同才算差异） */
export function diffRecords(a: ContinuityRecord, b: ContinuityRecord): FieldDiff[] {
  const diffs: FieldDiff[] = []
  const push = (
    field: FieldDiff['field'],
    label: string,
    left: string,
    right: string,
    normalize: boolean
  ): void => {
    const va = normalize ? normalizeStateText(left) : left.trim()
    const vb = normalize ? normalizeStateText(right) : right.trim()
    if (va !== vb && (va.length > 0 || vb.length > 0)) {
      diffs.push({ field, label, a: left, b: right })
    }
  }
  push('currentState', '当前状态', a.currentState, b.currentState, true)
  push('photoNote', '照片说明', a.photoNote, b.photoNote, false)
  push('takeNo', '镜次', a.takeNo, b.takeNo, false)
  return diffs
}

/** 把差异列表渲染成一句可读描述 */
export function describeDiffs(diffs: FieldDiff[]): string {
  if (diffs.length === 0) return '无差异'
  return diffs.map((item) => `${item.label}：「${item.a || '空'}」→「${item.b || '空'}」`).join('；')
}

/** 严重程度权重：用于排序与统计 */
export const SEVERITY_WEIGHT: Record<ConflictSeverity, number> = {
  轻微: 1,
  需处理: 2,
  阻断: 3
}

/**
 * 由差异推导严重程度：
 * - 无差异 → null（不生成冲突条目）
 * - 关键要素且状态描述变化 → 阻断
 * - 状态描述变化 → 需处理
 * - 仅照片说明 / 镜次变化 → 轻微
 */
export function severityOf(diffs: FieldDiff[], critical: boolean): ConflictSeverity | null {
  if (diffs.length === 0) return null
  const stateChanged = diffs.some((item) => item.field === 'currentState')
  if (stateChanged && critical) return '阻断'
  if (stateChanged) return '需处理'
  return '轻微'
}

/** 按严重程度权重倒序排列 */
export function sortBySeverity<T extends { severity: ConflictSeverity }>(list: T[]): T[] {
  return [...list].sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity])
}
