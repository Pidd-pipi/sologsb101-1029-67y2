/** 连戏要素类别 */
export type ElementCategory = '服装' | '道具' | '妆发' | '陈设'

/** 连戏要素：需要在不同拍摄日之间保持一致的实体 */
export interface Element {
  id: string
  /** 所属场次 */
  sceneId: string
  /** 类别 */
  category: ElementCategory
  /** 名称 */
  name: string
  /** 初始状态（连戏基准） */
  initialState: string
  /** 责任人 */
  owner: string
  /** 是否关键要素（差异需单独高亮） */
  critical: boolean
}

export const ELEMENT_CATEGORIES: ElementCategory[] = ['服装', '道具', '妆发', '陈设']

export function createEmptyElement(): Omit<Element, 'id'> {
  return { sceneId: '', category: '服装', name: '', initialState: '', owner: '', critical: false }
}
