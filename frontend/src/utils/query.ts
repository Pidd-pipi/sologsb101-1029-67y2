/**
 * 筛选条件 ↔ 路由 query 的互转工具
 * FilterBar 的筛选状态需要同步到 URL，刷新后仍可复现同一视图。
 */
import type { LocationQuery, LocationQueryRaw } from 'vue-router'
import type { FilterModel } from '../types/filter'

/** 把筛选条件序列化为路由 query（空值不下发） */
export function filtersToQuery(filters: FilterModel): LocationQueryRaw {
  const query: LocationQueryRaw = {}
  Object.entries(filters).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      if (value.length > 0) query[key] = value.join(',')
    } else if (typeof value === 'string') {
      if (value.length > 0) query[key] = value
    } else if (typeof value === 'boolean') {
      if (value) query[key] = '1'
    }
  })
  return query
}

/** 把路由 query 还原为筛选条件 */
export function queryToFilters(query: LocationQuery, keys: string[]): FilterModel {
  const filters: FilterModel = { keyword: '' }
  keys.forEach((key) => {
    const raw = query[key]
    if (typeof raw === 'string' && raw.length > 0) {
      filters[key] = raw.split(',').filter((item) => item.length > 0)
    } else {
      filters[key] = []
    }
  })
  if (typeof query.keyword === 'string') filters.keyword = query.keyword
  return filters
}
