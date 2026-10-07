/** 现场记录：某拍摄日某镜次下，一个连戏要素的实际状态 */
export interface Record {
  id: string
  /** 拍摄日 */
  shootDayId: string
  /** 连戏要素 */
  elementId: string
  /** 所属场次（冗余存储，便于按场次统计） */
  sceneId: string
  /** 镜次 */
  takeNo: string
  /** 当前状态描述 */
  currentState: string
  /** 照片说明 */
  photoNote: string
  /** 记录人 */
  recordedBy: string
}

export function createEmptyRecord(): Omit<Record, 'id'> {
  return {
    shootDayId: '',
    elementId: '',
    sceneId: '',
    takeNo: '',
    currentState: '',
    photoNote: '',
    recordedBy: ''
  }
}
