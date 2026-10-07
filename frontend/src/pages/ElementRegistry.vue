<script setup lang="ts">
/** /elements 连戏要素登记：按类别维护服装/道具/妆发/陈设的初始状态与责任人 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { db, type ElementRow, type RecordRow, type SceneRow } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useElementStore } from '@/stores/elementStore'
import { ELEMENT_CATEGORIES, createEmptyElement, type Element, type ElementCategory } from '@/types/element'
import type { FilterSelectConfig, FilterModel } from '@/types/filter'
import { filtersToQuery } from '@/utils/query'
import { ROUTES } from '@/router'

const route = useRoute()
const router = useRouter()
const store = useElementStore()

const { rows: elements, ready } = useIdbTable<ElementRow>(() => db.elements, {
  compare: (a, b) => a.category.localeCompare(b.category, 'zh-Hans-CN') || a.name.localeCompare(b.name, 'zh-Hans-CN')
})
const { rows: scenes } = useIdbTable<SceneRow>(() => db.scenes, { compare: (a, b) => a.shootOrder - b.shootOrder })
const { rows: records } = useIdbTable<RecordRow>(() => db.records)

const selects = computed<FilterSelectConfig[]>(() => [
  { key: 'categories', label: '类别', options: ELEMENT_CATEGORIES.map((item) => ({ label: item, value: item })) },
  { key: 'sceneIds', label: '场次', options: scenes.value.map((item) => ({ label: `第 ${item.sceneNo} 场`, value: item.id })) }
])

function sceneOf(sceneId: string): SceneRow | null {
  return scenes.value.find((item) => item.id === sceneId) ?? null
}

function sceneLabel(sceneId: string): string {
  const scene = sceneOf(sceneId)
  return scene ? `第 ${scene.sceneNo} 场 · ${scene.location}` : '场次已删除'
}

/** 该要素已有多少次现场记录 */
function recordCountOf(elementId: string): number {
  return records.value.filter((item) => item.elementId === elementId).length
}

const filtered = computed(() => {
  const keyword = String(store.filters.keyword ?? '').trim().toLowerCase()
  const categories = Array.isArray(store.filters.categories) ? store.filters.categories : []
  const sceneIds = Array.isArray(store.filters.sceneIds) ? store.filters.sceneIds : []
  return elements.value.filter((element) => {
    const label = `${element.name} ${element.initialState} ${element.owner}`.toLowerCase()
    if (keyword && !label.includes(keyword)) return false
    if (categories.length > 0 && !categories.includes(element.category)) return false
    if (sceneIds.length > 0 && !sceneIds.includes(element.sceneId)) return false
    return true
  })
})

/** 按场次 → 类别两级分组展示 */
interface GroupedScene {
  sceneId: string
  label: string
  groups: Array<{ category: ElementCategory; items: ElementRow[] }>
}

const grouped = computed<GroupedScene[]>(() => {
  const byScene = new Map<string, ElementRow[]>()
  filtered.value.forEach((element) => {
    const list = byScene.get(element.sceneId) ?? []
    list.push(element)
    byScene.set(element.sceneId, list)
  })
  return Array.from(byScene.entries())
    .map(([sceneId, list]) => ({
      sceneId,
      label: sceneLabel(sceneId),
      groups: ELEMENT_CATEGORIES.map((category) => ({
        category,
        items: list.filter((item) => item.category === category)
      })).filter((group) => group.items.length > 0)
    }))
    .sort((a, b) => (sceneOf(a.sceneId)?.shootOrder ?? 99) - (sceneOf(b.sceneId)?.shootOrder ?? 99))
})

const totals = computed(() => {
  const critical = elements.value.filter((item) => item.critical).length
  return {
    elementCount: elements.value.length,
    criticalCount: critical,
    criticalRatio: elements.value.length > 0 ? Math.round((critical / elements.value.length) * 100) : 0,
    categoryCount: new Set(elements.value.map((item) => item.category)).size,
    ownerCount: new Set(elements.value.map((item) => item.owner)).size
  }
})

/* ------------------------------ 新增 / 编辑 ------------------------------ */
const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()
const form = reactive<Omit<Element, 'id'>>(createEmptyElement())

const rules: FormRules = {
  sceneId: [{ required: true, message: '请选择所属场次', trigger: 'change' }],
  name: [{ required: true, message: '请填写要素名称', trigger: 'blur' }],
  initialState: [{ required: true, message: '请填写初始状态', trigger: 'blur' }]
}

function openCreate(sceneId?: string): void {
  editingId.value = null
  Object.assign(form, createEmptyElement())
  const preset = sceneId ?? (typeof route.query.sceneIds === 'string' ? route.query.sceneIds.split(',')[0] : '')
  if (preset) form.sceneId = preset
  else if (scenes.value.length > 0) form.sceneId = scenes.value[0].id
  dialogVisible.value = true
}

function openEdit(element: ElementRow): void {
  editingId.value = element.id
  Object.assign(form, {
    sceneId: element.sceneId,
    category: element.category,
    name: element.name,
    initialState: element.initialState,
    owner: element.owner,
    critical: element.critical
  })
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  if (editingId.value) {
    await store.updateElement(editingId.value, { ...form })
    ElMessage.success('连戏要素已更新')
  } else {
    await store.createElement({ ...form })
    ElMessage.success('连戏要素已登记')
  }
  dialogVisible.value = false
}

async function remove(element: ElementRow): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除要素「${element.name}」会同时删除其现场记录与差异条目，是否继续？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '确认删除' }
    )
  } catch {
    return
  }
  await store.deleteElement(element.id)
  ElMessage.success('要素及其记录已删除')
}

async function toggleCritical(element: ElementRow): Promise<void> {
  await store.updateElement(element.id, { critical: !element.critical })
  ElMessage.success(element.critical ? '已取消关键要素标记' : '已标记为关键要素')
}

function gotoLog(element: ElementRow): void {
  void router.push({ path: ROUTES.shootdays, query: { elementId: element.id } })
}

function onFilterChange(next: FilterModel): void {
  store.setFilters(next)
}

onMounted(() => {
  store.applyQuery(route.query)
})

watch(
  () => store.filters,
  (value) => {
    void router.replace({ path: route.path, query: filtersToQuery(value) })
  },
  { deep: true }
)
</script>

<template>
  <div class="page">
    <div class="page__head">
      <div>
        <h2 class="page__title">连戏要素登记</h2>
        <p class="page__subtitle">按场次与类别维护初始状态与责任人；关键要素的差异会在比对页单独高亮。</p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openCreate()">新增连戏要素</el-button>
    </div>

    <div class="badge-row">
      <StatBadge label="要素总数" :value="totals.elementCount" suffix="项" icon="Files" tone="primary" />
      <StatBadge label="关键要素" :value="totals.criticalCount" suffix="项" icon="WarningFilled" tone="danger" />
      <StatBadge label="关键占比" :value="totals.criticalRatio" :percent="totals.criticalRatio" show-percent icon="PieChart" tone="warning" />
      <StatBadge label="覆盖类别" :value="totals.categoryCount" suffix="类" icon="Grid" tone="info" />
      <StatBadge label="责任人" :value="totals.ownerCount" suffix="人" icon="DataLine" tone="success" />
    </div>

    <FilterBar
      :model-value="store.filters"
      :selects="selects"
      keyword-placeholder="搜索要素名称 / 初始状态 / 责任人…"
      @update:model-value="onFilterChange"
      @reset="store.resetFilters()"
    />

    <EmptyPanel
      v-if="ready && grouped.length === 0"
      title="还没有连戏要素"
      description="为场次登记服装 / 道具 / 妆发 / 陈设要素，作为后续现场比对的基准。"
      create-text="新增连戏要素"
      @create="openCreate()"
    />

    <el-card v-for="group in grouped" v-else :key="group.sceneId" shadow="never">
      <template #header>
        <div class="card-title">
          <span>{{ group.label }}</span>
          <el-button link type="primary" size="small" @click="openCreate(group.sceneId)">为场次新增要素</el-button>
        </div>
      </template>
      <div v-for="categoryGroup in group.groups" :key="categoryGroup.category" class="category-block">
        <div class="category-block__title">
          <el-tag size="small" effect="dark">{{ categoryGroup.category }}</el-tag>
          <span class="muted">{{ categoryGroup.items.length }} 项</span>
        </div>
        <el-table :data="categoryGroup.items" stripe border size="small">
          <el-table-column prop="name" label="要素名称" min-width="150" />
          <el-table-column prop="initialState" label="初始状态（连戏基准）" min-width="220" />
          <el-table-column prop="owner" label="责任人" width="140" />
          <el-table-column label="关键" width="90">
            <template #default="{ row }">
              <el-tag :type="row.critical ? 'danger' : 'info'" size="small" effect="plain">
                {{ row.critical ? '关键' : '一般' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="现场记录" width="100" align="right">
            <template #default="{ row }">{{ recordCountOf(row.id) }} 次</template>
          </el-table-column>
          <el-table-column label="操作" width="240" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" size="small" @click="gotoLog(row)">去记录</el-button>
              <el-button link size="small" @click="toggleCritical(row)">{{ row.critical ? '取消关键' : '设为关键' }}</el-button>
              <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
              <el-button link type="danger" size="small" @click="remove(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑连戏要素' : '新增连戏要素'" width="560px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
        <el-form-item label="所属场次" prop="sceneId">
          <el-select v-model="form.sceneId" class="full" placeholder="选择场次">
            <el-option v-for="item in scenes" :key="item.id" :label="`第 ${item.sceneNo} 场 · ${item.location}`" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="类别">
          <el-radio-group v-model="form.category">
            <el-radio-button v-for="item in ELEMENT_CATEGORIES" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="要素名称" prop="name">
          <el-input v-model="form.name" placeholder="如：女主蓝色风衣" />
        </el-form-item>
        <el-form-item label="初始状态" prop="initialState">
          <el-input v-model="form.initialState" type="textarea" :rows="2" placeholder="如：深蓝风衣，第二颗扣子缺失" />
        </el-form-item>
        <el-form-item label="责任人">
          <el-input v-model="form.owner" placeholder="如：服化组-林岚" />
        </el-form-item>
        <el-form-item label="关键要素">
          <el-switch v-model="form.critical" active-text="关键（差异按阻断处理）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.full {
  width: 100%;
}

.category-block {
  margin-bottom: 14px;
}

.category-block__title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
</style>
