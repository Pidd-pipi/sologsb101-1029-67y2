/** 拍摄日：把当日要拍的场次聚合成一个现场工作日 */
export interface ShootDay {
  id: string
  /** 拍摄日期 YYYY-MM-DD */
  date: string
  /** 当日场次清单 */
  sceneIds: string[]
  /** 导演 */
  director: string
  /** 场记 */
  scripty: string
  /** 现场备注（天气、突发情况等） */
  weatherNote: string
}

export function createEmptyShootDay(): Omit<ShootDay, 'id'> {
  return { date: new Date().toISOString().slice(0, 10), sceneIds: [], director: '', scripty: '', weatherNote: '' }
}
