/**
 * 首次打开应用时灌入的演示数据
 * 只在 scenes 表为空时执行。场次 → 连戏要素 → 拍摄日 → 现场记录 → 连戏差异 三层互相引用，
 * 并预留 1 条「阻断/待确认」与 1 条「轻微/待确认」差异，保证差异页与报告页有内容可看。
 */
import type { SceneRow, ElementRow, ShootDayRow, RecordRow, ConflictRow } from './db'
import { db, ROW_REVISION } from './db'

function rev<T>(row: T): T & { revision: number; createdAt: number; updatedAt: number } {
  const now = Date.now()
  return { ...row, revision: ROW_REVISION, createdAt: now, updatedAt: now }
}

const SCENES: Array<Omit<SceneRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  {
    id: 'sc-001',
    sceneNo: '12A',
    place: '内景',
    timeOfDay: '夜',
    location: '老宅客厅',
    excerpt: '女主在台灯下翻找旧信，听到门外脚步后把信塞回抽屉。',
    shootOrder: 1,
    state: '拍摄中'
  },
  {
    id: 'sc-002',
    sceneNo: '15',
    place: '外景',
    timeOfDay: '日',
    location: '江边码头',
    excerpt: '男主拖着木箱走下码头栈桥，与船老大交接货物。',
    shootOrder: 2,
    state: '未拍'
  },
  {
    id: 'sc-003',
    sceneNo: '3',
    place: '内景',
    timeOfDay: '晨',
    location: '女主卧室',
    excerpt: '晨光里女主对镜盘发，墙上全家福入画。',
    shootOrder: 3,
    state: '已过'
  }
]

const ELEMENTS: Array<Omit<ElementRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  {
    id: 'el-001',
    sceneId: 'sc-001',
    category: '服装',
    name: '女主蓝色风衣',
    initialState: '深蓝风衣，第二颗扣子缺失',
    owner: '服化组-林岚',
    critical: true
  },
  {
    id: 'el-002',
    sceneId: 'sc-001',
    category: '道具',
    name: '铜制台灯',
    initialState: '铜制台灯，灯罩左下有裂纹',
    owner: '道具组-周迟',
    critical: false
  },
  {
    id: 'el-003',
    sceneId: 'sc-001',
    category: '妆发',
    name: '女主发型',
    initialState: '低盘发，右侧留碎发',
    owner: '妆发组-许静',
    critical: true
  },
  {
    id: 'el-004',
    sceneId: 'sc-002',
    category: '道具',
    name: '编号木箱',
    initialState: '编号 A-17 木箱，右上角有破损',
    owner: '道具组-周迟',
    critical: true
  },
  {
    id: 'el-005',
    sceneId: 'sc-002',
    category: '服装',
    name: '男主夹克',
    initialState: '深灰夹克，左袖有油污',
    owner: '服化组-林岚',
    critical: false
  },
  {
    id: 'el-006',
    sceneId: 'sc-003',
    category: '陈设',
    name: '墙上全家福',
    initialState: '全家福相框右下角卷边',
    owner: '陈设组-孟舟',
    critical: false
  }
]

const SHOOT_DAYS: Array<Omit<ShootDayRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  {
    id: 'sd-001',
    date: '2024-05-06',
    sceneIds: ['sc-001'],
    director: '郑一鸣',
    scripty: '苏晚',
    weatherNote: '棚内夜戏，空调稳定，无异常。'
  },
  {
    id: 'sd-002',
    date: '2024-05-07',
    sceneIds: ['sc-001', 'sc-003'],
    director: '郑一鸣',
    scripty: '苏晚',
    weatherNote: '补拍 12A 特写；妆发临时调整，需复核。'
  },
  {
    id: 'sd-003',
    date: '2024-05-09',
    sceneIds: ['sc-002'],
    director: '郑一鸣',
    scripty: '苏晚',
    weatherNote: '江边风大，木箱贴纸被吹起一角。'
  }
]

const RECORDS: Array<Omit<RecordRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  { id: 'rec-001', shootDayId: 'sd-001', elementId: 'el-001', sceneId: 'sc-001', takeNo: '3/1', currentState: '深蓝风衣，第二颗扣子缺失', photoNote: '正面全身', recordedBy: '苏晚' },
  { id: 'rec-002', shootDayId: 'sd-001', elementId: 'el-002', sceneId: 'sc-001', takeNo: '3/1', currentState: '铜制台灯，灯罩左下有裂纹', photoNote: '台灯特写', recordedBy: '苏晚' },
  { id: 'rec-003', shootDayId: 'sd-001', elementId: 'el-003', sceneId: 'sc-001', takeNo: '3/1', currentState: '低盘发，右侧留碎发', photoNote: '侧脸发际', recordedBy: '苏晚' },
  { id: 'rec-004', shootDayId: 'sd-002', elementId: 'el-001', sceneId: 'sc-001', takeNo: '7/2', currentState: '深蓝风衣，第三颗扣子缺失', photoNote: '正面全身（补）', recordedBy: '苏晚' },
  { id: 'rec-005', shootDayId: 'sd-002', elementId: 'el-002', sceneId: 'sc-001', takeNo: '7/2', currentState: '铜制台灯，灯罩左下有裂纹', photoNote: '台灯特写（第二次）', recordedBy: '苏晚' },
  { id: 'rec-006', shootDayId: 'sd-002', elementId: 'el-003', sceneId: 'sc-001', takeNo: '7/2', currentState: '高马尾，无碎发', photoNote: '侧脸发际', recordedBy: '苏晚' },
  { id: 'rec-007', shootDayId: 'sd-002', elementId: 'el-006', sceneId: 'sc-003', takeNo: '7/5', currentState: '全家福相框右下角卷边', photoNote: '墙面全景', recordedBy: '苏晚' },
  { id: 'rec-008', shootDayId: 'sd-003', elementId: 'el-004', sceneId: 'sc-002', takeNo: '9/1', currentState: '编号 A-17 木箱，右上角有破损', photoNote: '木箱标识', recordedBy: '苏晚' },
  { id: 'rec-009', shootDayId: 'sd-003', elementId: 'el-005', sceneId: 'sc-002', takeNo: '9/1', currentState: '深灰夹克，左袖有油污', photoNote: '男主半身', recordedBy: '苏晚' }
]

const CONFLICTS: Array<Omit<ConflictRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  {
    id: 'cf-001',
    elementId: 'el-001',
    recordIdA: 'rec-001',
    recordIdB: 'rec-004',
    diffDesc: '当前状态：「深蓝风衣，第二颗扣子缺失」→「深蓝风衣，第三颗扣子缺失」',
    severity: '阻断',
    state: '待确认',
    resolvedNote: '',
    resolvedAt: ''
  },
  {
    id: 'cf-002',
    elementId: 'el-003',
    recordIdA: 'rec-003',
    recordIdB: 'rec-006',
    diffDesc: '当前状态：「低盘发，右侧留碎发」→「高马尾，无碎发」',
    severity: '需处理',
    state: '已解决',
    resolvedNote: '已按第 7 场重新盘发并补拍侧脸特写',
    resolvedAt: '2024-05-08T02:10:00.000Z'
  },
  {
    id: 'cf-003',
    elementId: 'el-002',
    recordIdA: 'rec-002',
    recordIdB: 'rec-005',
    diffDesc: '照片说明：「台灯特写」→「台灯特写（第二次）」',
    severity: '轻微',
    state: '待确认',
    resolvedNote: '',
    resolvedAt: ''
  }
]

/** 灌入演示数据（场次 → 要素 → 拍摄日 → 现场记录 → 连戏差异） */
export async function seedDatabase(): Promise<void> {
  await db.transaction('rw', [db.scenes, db.elements, db.shootDays, db.records, db.conflicts], async () => {
    await db.scenes.bulkPut(SCENES.map(rev))
    await db.elements.bulkPut(ELEMENTS.map(rev))
    await db.shootDays.bulkPut(SHOOT_DAYS.map(rev))
    await db.records.bulkPut(RECORDS.map(rev))
    await db.conflicts.bulkPut(CONFLICTS.map(rev))
  })
}
