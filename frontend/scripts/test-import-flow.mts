/**
 * 导入流水线端到端验证（Node + fake-indexeddb）：
 * 覆盖：旧版备份升级回填、必填/枚举隔离、跨表悬空隔离、多对多悬空剔除、
 * 新增/覆盖/删除计数、指纹失效作废、分批写入、失败自动回滚、重试、中断恢复。
 */
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import {
  precheckBackup,
  createImportJob,
  beginImport,
  currentFingerprint,
  recoverInterruptedJobs,
  listImportJobs,
  getImportJob,
  deleteImportJob,
  TABLE_KEYS
} from '../src/utils/importFlow'
import { db, initDatabase, listScenes, listRecords, putScene, ROW_REVISION } from '../src/utils/db'
import type { SceneRow } from '../src/utils/db'

let passed = 0
function check(name: string, cond: boolean): void {
  assert.ok(cond, name)
  passed += 1
  console.log(`  ✓ ${name}`)
}

async function counts(): Promise<Record<string, number>> {
  const result: Record<string, number> = {}
  for (const key of TABLE_KEYS) result[key] = await db.table(key).count()
  return result
}

async function main(): Promise<void> {
  await initDatabase()
  const before = await counts()
  console.log('播种后行数:', before)

  // 构造一份「旧版」备份（无 schemaVersion、无修订号），且带各种坏行
  const localScenes = await listScenes()
  const keepScene = localScenes[0]

  const goodScene = { id: 's-new', sceneNo: '99', place: '外景', timeOfDay: '夜', location: '码头', excerpt: '', shootOrder: 99, state: '已过' }
  const badEnumScene = { id: 's-bad', sceneNo: '100', place: '水下', timeOfDay: '日', location: 'X', excerpt: '', shootOrder: 1, state: '未拍' }
  const missingNoScene = { id: 's-nono', place: '内景', timeOfDay: '日' }

  const goodElement = { id: 'e1', sceneId: 's-new', category: '服装', name: '风衣', initialState: '藏青', owner: '小王', critical: true }
  const danglingElement = { id: 'e2', sceneId: 's-ghost', category: '道具', name: '怀表', initialState: '', owner: '', critical: false }

  const day = { id: 'd1', date: '2026-10-01', sceneIds: ['s-new', 's-ghost'], director: '李导', scripty: '小张', weatherNote: '' }
  const badDay = { id: 'd2', date: '10月1号', sceneIds: [] }

  const goodRecord = { id: 'r1', shootDayId: 'd1', elementId: 'e1', takeNo: '1镜1', currentState: '深蓝风衣', photoNote: '', recordedBy: '小张' }
  const danglingRecord = { id: 'r2', shootDayId: 'd1', elementId: 'e-ghost', takeNo: '1镜2', currentState: 'X', photoNote: '', recordedBy: '' }
  const recordMissingScene = { id: 'r3', shootDayId: 'd1', elementId: 'e1', takeNo: '2镜1', currentState: '湿透', photoNote: '', recordedBy: '小张' }

  const goodConflict = { id: 'c1', elementId: 'e1', recordIdA: 'r1', recordIdB: 'r3', diffDesc: '颜色深浅不一', severity: '阻断', state: '待确认', resolvedNote: '', resolvedAt: '' }
  const danglingConflict = { id: 'c2', elementId: 'e1', recordIdA: 'r1', recordIdB: 'r-ghost', diffDesc: '坏引用', severity: '轻微', state: '待确认', resolvedNote: '', resolvedAt: '' }

  const backup = {
    name: 'gbcontinuity-db',
    exportedAt: new Date().toISOString(),
    scenes: [goodScene, badEnumScene, missingNoScene],
    elements: [goodElement, danglingElement],
    shootDays: [day, badDay],
    records: [goodRecord, danglingRecord, recordMissingScene],
    conflicts: [goodConflict, danglingConflict]
  }

  // ---- 1. 预检 ----
  console.log('\n[1] 预检旧版备份（含坏行）')
  const pre = await precheckBackup(JSON.stringify(backup))
  check('识别为 v0 历史备份并标记升级', pre.sourceSchemaVersion === 0 && pre.upgraded)
  check('场次可写入 1（枚举非法/缺场号被隔离）', pre.acceptedCount.scenes === 1)
  check('要素可写入 1（悬空场次被隔离）', pre.acceptedCount.elements === 1)
  check('拍摄日可写入 1（日期非法被隔离）', pre.acceptedCount.shootDays === 1)
  check('现场记录可写入 2（悬空要素 1 条被隔离）', pre.acceptedCount.records === 2)
  check('差异可写入 1（悬空记录引用被隔离）', pre.acceptedCount.conflicts === 1)
  check('隔离合计 6 条（场次2/要素1/拍摄日1/记录1/差异1）', pre.quarantined.length === 6)
  check(
    '隔离清单列清悬空现场记录',
    pre.quarantined.some((q) => q.table === 'records' && q.reason.includes('连戏要素'))
  )
  check('多对多悬空场次关联被剔除（d1 只留 s-new）', pre.accepted.shootDays[0].sceneIds.join() === 's-new')
  check('缺 sceneId 的现场记录按要素回填', pre.accepted.records.find((r) => r.id === 'r3')?.sceneId === 's-new')
  check('缺 shootOrder 的缺失行已隔离，好行保留顺序', pre.accepted.scenes[0].shootOrder === 99)

  const stamped = pre.accepted.scenes[0] as Record<string, unknown>
  check('旧数据已回填修订号', stamped.revision === ROW_REVISION)
  check('已回填时间戳', typeof stamped.createdAt === 'number' && typeof stamped.updatedAt === 'number')
  check('有升级回填提示', pre.issues.some((i) => i.code === 'revision-backfilled'))
  check('计数：备份带来新增场次 1', pre.addedCount.scenes === 1)
  check(`计数：本机播种 ${before.scenes} 个场次 id 均不在备份内，将删 ${before.scenes}`, pre.deletedCount.scenes === before.scenes)

  // ---- 2. 创建草稿 + 指纹失效 ----
  console.log('\n[2] 预检后台账被改动 → 结果作废')
  const jobId = await createImportJob('test.json', JSON.stringify(backup), pre)
  const localBeforeImport = await listScenes()
  check('草稿状态 prechecked', (await getImportJob(jobId))?.status === 'prechecked')

  const extra: SceneRow = {
    ...keepScene,
    id: 's-tampered',
    sceneNo: 'T1',
    shootOrder: 999,
    revision: ROW_REVISION,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  await putScene(extra)
  check('指纹已变化', (await currentFingerprint()) !== pre.localFingerprint)
  await assertRejects(
    () => beginImport(jobId),
    /作废/,
    '台账改动后 beginImport 必须拒绝'
  )
  const jobAfterReject = await getImportJob(jobId)
  check('拒绝后业务库未被清空（原有场次仍在）', (await db.scenes.count()) === localBeforeImport.length + 1)
  check('拒绝后草稿仍是 prechecked', jobAfterReject?.status === 'prechecked')
  check('拒绝后未留快照（还没进入落地阶段）', jobAfterReject?.preImportSnapshot === null)

  // 删掉干扰行，重新预检
  await db.scenes.delete('s-tampered')
  const pre2 = await precheckBackup(JSON.stringify(backup))
  check('指纹重新一致', pre2.localFingerprint === (await currentFingerprint()))

  // ---- 3. 正常分批导入 ----
  console.log('\n[3] 正常导入')
  const progressLog: number[] = []
  await beginImport(jobId, (p) => progressLog.push(p.percent))
  const after = await counts()
  check('导入后行数与预检一致', after.scenes === 1 && after.elements === 1 && after.shootDays === 1 && after.records === 2 && after.conflicts === 1)
  check('进度从 0 到 100', progressLog[0] === 0 && progressLog[progressLog.length - 1] === 100)
  check('进度单调递增', progressLog.every((v, i) => i === 0 || v >= progressLog[i - 1]))
  const succeededJob = await getImportJob(jobId)
  check('草稿状态 succeeded', succeededJob?.status === 'succeeded')
  check('导入前快照已留存（可回滚）', (succeededJob?.preImportSnapshot?.scenes.length ?? 0) === before.scenes)

  // ---- 4. 手动回滚 ----
  console.log('\n[4] 手动回滚到导入前')
  const { rollbackImport } = await import('../src/utils/importFlow')
  await rollbackImport(jobId)
  const restored = await counts()
  check('回滚后行数恢复播种状态', JSON.stringify(restored) === JSON.stringify(before))
  check('草稿状态 rolled_back', (await getImportJob(jobId))?.status === 'rolled_back')

  // ---- 5. 重试 ----
  console.log('\n[5] 回滚后重试')
  const { retryImport } = await import('../src/utils/importFlow')
  await retryImport(jobId)
  const afterRetry = await counts()
  check('重试后行数与预检一致', afterRetry.scenes === 1 && afterRetry.records === 2)
  check('重试后草稿 succeeded', (await getImportJob(jobId))?.status === 'succeeded')

  // ---- 6. 写入中失败 → 自动回滚 ----
  console.log('\n[6] 写入阶段抛错 → 自动恢复导入前')
  const preState6 = await counts()
  const pre3 = await precheckBackup(JSON.stringify(backup))
  const job2 = await createImportJob('fail.json', JSON.stringify(backup), pre3)
  const originalBulkPut = db.scenes.bulkPut.bind(db.scenes)
  // 第一批场次写入即失败；随即恢复原方法，保证自动回滚使用的是未被污染的写入通道
  db.scenes.bulkPut = (() => {
    db.scenes.bulkPut = originalBulkPut as typeof db.scenes.bulkPut
    return Promise.reject(new Error('模拟磁盘写入失败'))
  }) as typeof db.scenes.bulkPut
  await assertRejects(() => beginImport(job2), /模拟磁盘写入失败/, '写入失败应抛出')
  const afterFail = await counts()
  check('失败后自动回滚，行数恢复本次导入前', JSON.stringify(afterFail) === JSON.stringify(preState6))
  const failedJob = await getImportJob(job2)
  check('草稿状态 rolled_back 且记录错误', failedJob?.status === 'rolled_back' && (failedJob?.lastError.includes('模拟磁盘写入失败')))
  check('失败草稿的快照仍保留', (failedJob?.preImportSnapshot?.scenes.length ?? 0) === preState6.scenes)

  // 自动回滚后指纹已重记，重试不应被「预检后改动」拦住
  await retryImport(job2)
  const afterFailRetry = await counts()
  check('失败回滚后重试成功，行数与预检一致', afterFailRetry.scenes === 1 && afterFailRetry.records === 2)

  // ---- 7. 中断恢复（状态停在 writing + 已存快照）----
  console.log('\n[7] 页面中途关闭 → 打开时自动恢复')
  // 制造一个「只清空没写完」的半现场，模拟浏览器在写入中途被杀
  await db.scenes.clear()
  // 借助草稿库直接把状态改回 writing
  const { jobDb } = await import('../src/utils/importFlow')
  await jobDb.jobs.update(job2, { status: 'writing' })
  const recovered = await recoverInterruptedJobs()
  check('恢复函数返回该中断草稿', recovered.some((j) => j.id === job2))
  const afterRecover = await counts()
  check('恢复后回到中断前（本次导入前）状态', JSON.stringify(afterRecover) === JSON.stringify(preState6))

  // ---- 8. 结构版本高于本机 ----
  console.log('\n[8] 高版本备份拒绝')
  await assertRejects(
    () => precheckBackup(JSON.stringify({ ...backup, schemaVersion: 999 })),
    /高于本机/,
    '高版本必须拒绝'
  )

  // 清理
  await deleteImportJob(jobId)
  await deleteImportJob(job2)
  check('草稿可删除', (await listImportJobs()).length === 0)

  console.log(`\n全部 ${passed} 项断言通过 ✅`)
}

async function assertRejects(fn: () => Promise<unknown>, match: RegExp, label: string): Promise<void> {
  let threw: unknown = null
  try {
    await fn()
  } catch (error) {
    threw = error
  }
  assert.ok(threw instanceof Error, `${label}：应抛错`)
  assert.match((threw as Error).message, match, label)
  passed += 1
  console.log(`  ✓ ${label}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
