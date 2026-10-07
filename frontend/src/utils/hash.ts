/**
 * 本机台账指纹：FNV-1a 32 位散列，按固定表序汇总每行的 id / revision / updatedAt。
 * 预检时记录一次指纹，正式写入前再算一次；指纹不一致说明预检后台账有新改动，
 * 预检结果作废必须重来（避免拿着过期核对结果覆盖别人刚改的数据）。
 */
import type { BackupTableKey, PreparedRows } from '@/types/importDraft'
import { BACKUP_TABLE_KEYS } from '@/types/importDraft'
import { readAllBusinessRows } from './db'

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

function fnv1a(acc: number, text: string): number {
  let hash = acc >>> 0
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, FNV_PRIME) >>> 0
  }
  return hash >>> 0
}

/** 对任意已读行集合计算指纹（导入前留底回滚后也用它核对） */
export function fingerprintOf(rows: PreparedRows): string {
  let hash = FNV_OFFSET
  for (const table of BACKUP_TABLE_KEYS) {
    hash = fnv1a(hash, `${table}:`)
    for (const row of rows[table]) {
      const r = row as { id?: unknown; revision?: unknown; updatedAt?: unknown }
      hash = fnv1a(hash, `${String(r.id)}|${String(r.revision)}|${String(r.updatedAt)};`)
    }
  }
  return hash.toString(16).padStart(8, '0')
}

/** 直接对本机五张业务表当前内容计算指纹 */
export async function currentFingerprint(): Promise<string> {
  return fingerprintOf(await readAllBusinessRows())
}

/** 表顺序辅助：供导入分批按同一顺序遍历 */
export function tablesOf(rows: PreparedRows): Array<{ table: BackupTableKey; list: PreparedRows[BackupTableKey] }> {
  return BACKUP_TABLE_KEYS.map((table) => ({ table, list: rows[table] }))
}
