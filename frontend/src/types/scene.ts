/** 内景 / 外景 */
export type ScenePlace = '内景' | '外景'
/** 日 / 夜 / 晨 / 昏 */
export type SceneTimeOfDay = '日' | '夜' | '晨' | '昏'
/** 场次拍摄状态 */
export type SceneState = '未拍' | '拍摄中' | '已过'

/** 剧本场次：连戏核对的最小单位 */
export interface Scene {
  id: string
  /** 场号，如 12A */
  sceneNo: string
  /** 内景 / 外景 */
  place: ScenePlace
  /** 时间 */
  timeOfDay: SceneTimeOfDay
  /** 地点 */
  location: string
  /** 剧本节选 */
  excerpt: string
  /** 拍摄顺序（拖拽调序后自动重编号） */
  shootOrder: number
  /** 拍摄状态 */
  state: SceneState
}

export const SCENE_PLACES: ScenePlace[] = ['内景', '外景']
export const SCENE_TIMES: SceneTimeOfDay[] = ['日', '夜', '晨', '昏']
export const SCENE_STATES: SceneState[] = ['未拍', '拍摄中', '已过']

export function createEmptyScene(): Omit<Scene, 'id' | 'shootOrder'> {
  return { sceneNo: '', place: '内景', timeOfDay: '日', location: '', excerpt: '', state: '未拍' }
}

/** 场次卡片回显的派生统计 */
export interface SceneStats {
  elementCount: number
  openConflictCount: number
}
