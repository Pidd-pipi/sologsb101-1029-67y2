/**
 * 连戏差异 store：维护差异列表、严重程度筛选与解决状态流转。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { Conflict } from '@/types/conflict'
import type { FilterModel } from '@/types/filter'
import type { ConflictRow } from '@/utils/db'
import { putConflict, removeConflict, reopenConflict, resolveConflict, saveConflicts, ROW_REVISION } from '@/utils/db'
import { createId } from '@/utils/uuid'
import { queryToFilters } from '@/utils/query'
import type { DiffCandidate } from '@/hooks/useContinuityDiff'

export const CONFLICT_FILTER_KEYS = ['severities', 'states']

export const useConflictStore = defineStore('conflict', () => {
  const filters = ref<FilterModel>({ keyword: '', severities: [], states: [] })
  const lastGenerated = ref<number>(0)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', severities: [], states: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, CONFLICT_FILTER_KEYS)
  }

  /** 由比对候选生成差异条目（已存在的同一对记录不会重复生成） */
  async function generate(candidates: DiffCandidate[]): Promise<number> {
    const now = Date.now()
    const rows: ConflictRow[] = candidates.map((item) => ({
      id: createId('conflict'),
      elementId: item.elementId,
      recordIdA: item.a.id,
      recordIdB: item.b.id,
      diffDesc: item.desc,
      severity: item.severity,
      state: '待确认',
      resolvedNote: '',
      resolvedAt: '',
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    }))
    const created = await saveConflicts(rows)
    lastGenerated.value = created
    return created
  }

  /** 手工登记一条差异（用于现场口头发现的偏差） */
  async function createManual(payload: Omit<Conflict, 'id' | 'resolvedNote' | 'resolvedAt'>): Promise<string> {
    const now = Date.now()
    const id = createId('conflict')
    await putConflict({
      ...payload,
      id,
      resolvedNote: '',
      resolvedAt: '',
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    })
    return id
  }

  /** 解决差异：写入留痕并回写要素初始状态 */
  async function resolve(id: string, note: string): Promise<void> {
    await resolveConflict(id, note)
  }

  async function reopen(id: string): Promise<void> {
    await reopenConflict(id)
  }

  async function remove(id: string): Promise<void> {
    await removeConflict(id)
  }

  return { filters, lastGenerated, setFilters, resetFilters, applyQuery, generate, createManual, resolve, reopen, remove }
})
