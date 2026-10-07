/**
 * 路由表：/scenes、/elements、/shootdays、/conflicts、/report
 * 页面按路由懒加载，构建时自动分包。
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

export const ROUTES = {
  scenes: '/scenes',
  elements: '/elements',
  shootdays: '/shootdays',
  conflicts: '/conflicts',
  report: '/report'
} as const

export interface NavItem {
  path: string
  label: string
  icon: string
  hint: string
}

/** 侧边导航配置（与路由一一对应） */
export const NAV_ITEMS: NavItem[] = [
  { path: ROUTES.scenes, label: '剧本场次', icon: '🎬', hint: '场次台账与拍摄顺序' },
  { path: ROUTES.elements, label: '连戏要素', icon: '👗', hint: '服装 / 道具 / 妆发 / 陈设' },
  { path: ROUTES.shootdays, label: '现场记录', icon: '📝', hint: '拍摄日与镜次记录' },
  { path: ROUTES.conflicts, label: '差异比对', icon: '⚠️', hint: '冲突提示与消解' },
  { path: ROUTES.report, label: '核对报告', icon: '📋', hint: '报告导出与版本查看' }
]

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: ROUTES.scenes },
  {
    path: ROUTES.scenes,
    name: 'scenes',
    component: () => import('@/pages/SceneList.vue'),
    meta: { title: '剧本场次与拍摄顺序台账' }
  },
  {
    path: ROUTES.elements,
    name: 'elements',
    component: () => import('@/pages/ElementRegistry.vue'),
    meta: { title: '连戏要素登记' }
  },
  {
    path: ROUTES.shootdays,
    name: 'shootdays',
    component: () => import('@/pages/ShootDayLog.vue'),
    meta: { title: '现场状态记录' }
  },
  {
    path: ROUTES.conflicts,
    name: 'conflicts',
    component: () => import('@/pages/ConflictBoard.vue'),
    meta: { title: '连戏差异比对与冲突提示' }
  },
  {
    path: ROUTES.report,
    name: 'report',
    component: () => import('@/pages/ReportExport.vue'),
    meta: { title: '连戏核对报告与结构版本导出' }
  },
  { path: '/:pathMatch(.*)*', redirect: ROUTES.scenes }
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 })
})

export default router
