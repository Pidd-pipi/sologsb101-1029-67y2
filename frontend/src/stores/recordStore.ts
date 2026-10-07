/**
 * 现场记录 store：维护现场记录与当前拍摄日上下文。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LocationQuery } from 'vue-router'
import type { ShootDay } from '@/types/shootDay'
import type { FilterModel } from '@/types/filter'
import {
  nextShootOrder,
  putRecord,
  putShootDay,
  removeRecord,
  removeShootDay,
  updateRecord as updateRecordRow,
  updateShootDay as updateShootDayRow,
  ROW_REVISION
} from '@/utils/db'
import { createId } from '@/utils/uuid'
import { queryToFilters } from '@/utils/query'
import type { Record as ContinuityRecord } from '@/types/record'

export const RECORD_FILTER_KEYS = ['sceneIds', 'takes']

export const useRecordStore = defineStore('record', () => {
  const filters = ref<FilterModel>({ keyword: '', sceneIds: [], takes: [] })
  /** 当前选中的拍摄日（现场记录页的上下文） */
  const currentShootDayId = ref<string | null>(null)

  function setFilters(next: FilterModel): void {
    filters.value = next
  }

  function resetFilters(): void {
    filters.value = { keyword: '', sceneIds: [], takes: [] }
  }

  function applyQuery(query: LocationQuery): void {
    filters.value = queryToFilters(query, RECORD_FILTER_KEYS)
    if (typeof query.shootDayId === 'string' && query.shootDayId.length > 0) {
      currentShootDayId.value = query.shootDayId
    }
  }

  function selectShootDay(id: string | null): void {
    currentShootDayId.value = id
  }

  async function createShootDay(payload: Omit<ShootDay, 'id'>): Promise<string> {
    if (!payload.date) throw new Error('请选择拍摄日期')
    if (payload.sceneIds.length === 0) throw new Error('请至少选择一个当日场次')
    const now = Date.now()
    const id = createId('shootday')
    await putShootDay({ ...payload, id, revision: ROW_REVISION, createdAt: now, updatedAt: now })
    currentShootDayId.value = id
    return id
  }

  async function updateShootDay(id: string, patch: Partial<ShootDay>): Promise<void> {
    await updateShootDayRow(id, patch)
  }

  async function deleteShootDay(id: string): Promise<void> {
    await removeShootDay(id)
    if (currentShootDayId.value === id) currentShootDayId.value = null
  }

  async function createRecord(payload: Omit<ContinuityRecord, 'id'>): Promise<string> {
    if (!payload.shootDayId) throw new Error('请先选择拍摄日')
    if (!payload.elementId) throw new Error('请选择连戏要素')
    if (!payload.currentState.trim()) throw new Error('请填写当前状态')
    const now = Date.now()
    const id = createId('record')
    await putRecord({ ...payload, id, revision: ROW_REVISION, createdAt: now, updatedAt: now })
    return id
  }

  async function updateRecord(id: string, patch: Partial<ContinuityRecord>): Promise<void> {
    await updateRecordRow(id, patch)
  }

  async function deleteRecord(id: string): Promise<void> {
    await removeRecord(id)
  }

  /** 保留给后续扩展：拍摄顺序号 */
  async function peekNextOrder(): Promise<number> {
    return nextShootOrder()
  }

  return {
    filters,
    currentShootDayId,
    setFilters,
    resetFilters,
    applyQuery,
    selectShootDay,
    createShootDay,
    updateShootDay,
    deleteShootDay,
    createRecord,
    updateRecord,
    deleteRecord,
    peekNextOrder
  }
})
