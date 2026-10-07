<script setup lang="ts">
/** 应用外壳：左侧导航 + 顶部概览 + 路由出口 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NAV_ITEMS, ROUTES } from '@/router'
import { countAll, DB_NAME, DB_SCHEMA_VERSION } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const counts = ref<Record<string, number>>({})
const dbName = DB_NAME
const schemaVersion = DB_SCHEMA_VERSION

const activePath = computed(() => {
  const match = NAV_ITEMS.find((item) => route.path.startsWith(item.path))
  return match ? match.path : ROUTES.scenes
})

const currentTitle = computed(() => (route.meta.title as string | undefined) ?? '影视场景连戏与道具接续核对台')

async function refreshCounts(): Promise<void> {
  counts.value = await countAll()
}

onMounted(() => {
  void refreshCounts()
  router.afterEach(() => {
    void refreshCounts()
  })
})
</script>

<template>
  <el-container class="app-shell">
    <el-aside width="230px" class="app-aside">
      <div class="app-brand">
        <div class="app-brand__mark">🎬</div>
        <div>
          <div class="app-brand__title">影视连戏核对</div>
          <div class="app-brand__sub">gbcontinuity · 道具接续核对台</div>
        </div>
      </div>
      <el-menu :default-active="activePath" class="app-menu" @select="(key: string) => router.push(key)">
        <el-menu-item v-for="item in NAV_ITEMS" :key="item.path" :index="item.path">
          <span class="app-menu__icon">{{ item.icon }}</span>
          <span class="app-menu__label">{{ item.label }}</span>
        </el-menu-item>
      </el-menu>
      <div class="app-aside__foot">
        <div>本地库 {{ dbName }} · v{{ schemaVersion }}</div>
        <div>场次 {{ counts.scenes ?? 0 }} · 要素 {{ counts.elements ?? 0 }} · 拍摄日 {{ counts.shootDays ?? 0 }}</div>
        <div>记录 {{ counts.records ?? 0 }} · 差异 {{ counts.conflicts ?? 0 }}</div>
      </div>
    </el-aside>

    <el-container>
      <el-header class="app-header">
        <div class="app-header__title">{{ currentTitle }}</div>
        <div class="app-header__meta">数据仅保存在本机浏览器（IndexedDB），无后端服务</div>
      </el-header>
      <el-main class="app-main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
}

.app-aside {
  display: flex;
  flex-direction: column;
  background: #1f2f3b;
  color: #e9f1f6;
}

.app-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 18px 16px 12px;
}

.app-brand__mark {
  font-size: 26px;
}

.app-brand__title {
  font-size: 15px;
  font-weight: 700;
}

.app-brand__sub {
  font-size: 11px;
  color: rgba(233, 241, 246, 0.6);
}

.app-menu {
  flex: 1;
  border-right: none;
  background: transparent;
}

.app-menu :deep(.el-menu-item) {
  color: rgba(233, 241, 246, 0.78);
}

.app-menu :deep(.el-menu-item.is-active) {
  color: #fff;
  background: rgba(91, 139, 184, 0.28);
}

.app-menu :deep(.el-menu-item:hover) {
  background: rgba(91, 139, 184, 0.16);
}

.app-menu__icon {
  margin-right: 8px;
}

.app-aside__foot {
  padding: 12px 16px 18px;
  font-size: 11px;
  line-height: 1.8;
  color: rgba(233, 241, 246, 0.55);
}

.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #ffffff;
  border-bottom: 1px solid var(--wine-border);
}

.app-header__title {
  font-size: 16px;
  font-weight: 600;
}

.app-header__meta {
  font-size: 12px;
  color: #8c8479;
}

.app-main {
  background: var(--wine-bg);
  padding: 18px;
}
</style>
