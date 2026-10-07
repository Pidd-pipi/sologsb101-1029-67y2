<script setup lang="ts">
/** /scenes 剧本场次与拍摄顺序台账：新建场次、拖拽调序、按内外景与日/夜筛选 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Plus, Rank } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import ConflictTag from '@/components/common/ConflictTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { db, type ConflictRow, type ElementRow, type SceneRow } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useSceneStore } from '@/stores/sceneStore'
import { SCENE_PLACES, SCENE_STATES, SCENE_TIMES, createEmptyScene, type Scene } from '@/types/scene'
import type { FilterSelectConfig, FilterModel } from '@/types/filter'
import { filtersToQuery } from '@/utils/query'
import { ROUTES } from '@/router'

const route = useRoute()
const router = useRouter()
const store = useSceneStore()

const { rows: scenes, ready } = useIdbTable<SceneRow>(() => db.scenes, {
  compare: (a, b) => a.shootOrder - b.shootOrder
})
const { rows: elements } = useIdbTable<ElementRow>(() => db.elements)
const { rows: conflicts } = useIdbTable<ConflictRow>(() => db.conflicts)

const selects: FilterSelectConfig[] = [
  { key: 'places', label: '内外景', options: SCENE_PLACES.map((item) => ({ label: item, value: item })) },
  { key: 'times', label: '时间', options: SCENE_TIMES.map((item) => ({ label: item, value: item })) }
]

/** 该场的连戏要素数与未解决冲突数 */
function elementCountOf(sceneId: string): number {
  return elements.value.filter((item) => item.sceneId === sceneId).length
}

function openConflictCountOf(sceneId: string): number {
  const elementIds = elements.value.filter((item) => item.sceneId === sceneId).map((item) => item.id)
  return conflicts.value.filter((item) => elementIds.includes(item.elementId) && item.state === '待确认').length
}

const filtered = computed(() => {
  const keyword = String(store.filters.keyword ?? '').trim().toLowerCase()
  const places = Array.isArray(store.filters.places) ? store.filters.places : []
  const times = Array.isArray(store.filters.times) ? store.filters.times : []
  return scenes.value
    .filter((scene) => {
      const label = `${scene.sceneNo} ${scene.location} ${scene.excerpt}`.toLowerCase()
      if (keyword && !label.includes(keyword)) return false
      if (places.length > 0 && !places.includes(scene.place)) return false
      if (times.length > 0 && !times.includes(scene.timeOfDay)) return false
      return true
    })
    .sort((a, b) => a.shootOrder - b.shootOrder)
})

const totals = computed(() => {
  const open = conflicts.value.filter((item) => item.state === '待确认')
  return {
    sceneCount: scenes.value.length,
    elementCount: elements.value.length,
    openConflictCount: open.length,
    blockingCount: open.filter((item) => item.severity === '阻断').length,
    shotCount: scenes.value.filter((item) => item.state === '已过').length,
    shotRatio: scenes.value.length > 0 ? Math.round((scenes.value.filter((i) => i.state === '已过').length / scenes.value.length) * 100) : 0
  }
})

/* ------------------------------ 拖拽调序 ------------------------------ */
const dragIndex = ref<number | null>(null)
const overIndex = ref<number | null>(null)

function onDragStart(index: number): void {
  dragIndex.value = index
}

function onDragOver(index: number): void {
  overIndex.value = index
}

async function onDrop(index: number): Promise<void> {
  const from = dragIndex.value
  dragIndex.value = null
  overIndex.value = null
  if (from === null || from === index) return
  await store.move(filtered.value, from, index)
  ElMessage.success('拍摄顺序已更新并自动重编号')
}

async function moveBy(index: number, offset: number): Promise<void> {
  await store.move(filtered.value, index, index + offset)
}

/* ------------------------------ 新增 / 编辑 ------------------------------ */
const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()
const form = reactive<Omit<Scene, 'id' | 'shootOrder'>>(createEmptyScene())

const rules: FormRules = {
  sceneNo: [{ required: true, message: '请填写场号', trigger: 'blur' }],
  location: [{ required: true, message: '请填写地点', trigger: 'blur' }]
}

function openCreate(): void {
  editingId.value = null
  Object.assign(form, createEmptyScene())
  dialogVisible.value = true
}

function openEdit(scene: SceneRow): void {
  editingId.value = scene.id
  Object.assign(form, {
    sceneNo: scene.sceneNo,
    place: scene.place,
    timeOfDay: scene.timeOfDay,
    location: scene.location,
    excerpt: scene.excerpt,
    state: scene.state
  })
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  if (editingId.value) {
    await store.updateScene(editingId.value, { ...form })
    ElMessage.success('场次已更新')
  } else {
    await store.createScene({ ...form })
    ElMessage.success('场次已登记')
  }
  dialogVisible.value = false
}

async function remove(scene: SceneRow): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除场次 ${scene.sceneNo} 会级联删除其连戏要素、现场记录与差异条目，是否继续？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '确认删除' }
    )
  } catch {
    return
  }
  await store.deleteScene(scene.id)
  ElMessage.success('场次及其下级记录已删除')
}

async function changeState(scene: SceneRow, state: Scene['state']): Promise<void> {
  await store.updateScene(scene.id, { state })
  ElMessage.success(`场次 ${scene.sceneNo} 已置为「${state}」`)
}

function gotoElements(scene: SceneRow): void {
  void router.push({ path: ROUTES.elements, query: { sceneIds: scene.id } })
}

function gotoConflicts(scene: SceneRow): void {
  void router.push({ path: ROUTES.conflicts, query: { keyword: scene.sceneNo } })
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
        <h2 class="page__title">剧本场次与拍摄顺序台账</h2>
        <p class="page__subtitle">拖拽卡片或用上下移按钮调整拍摄顺序，顺序号会自动重编号并写回本地库。</p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openCreate">新建场次</el-button>
    </div>

    <div class="badge-row">
      <StatBadge label="场次数" :value="totals.sceneCount" suffix="场" icon="Files" tone="primary" />
      <StatBadge label="连戏要素" :value="totals.elementCount" suffix="项" icon="Grid" tone="info" />
      <StatBadge label="未解决冲突" :value="totals.openConflictCount" suffix="条" icon="WarningFilled" tone="danger" />
      <StatBadge label="阻断级" :value="totals.blockingCount" suffix="条" icon="WarningFilled" tone="warning" />
      <StatBadge label="已过场次" :value="totals.shotCount" suffix="场" icon="TrendCharts" tone="success" />
      <StatBadge label="拍摄进度" :value="totals.shotRatio" :percent="totals.shotRatio" show-percent icon="PieChart" tone="primary" />
    </div>

    <FilterBar
      :model-value="store.filters"
      :selects="selects"
      keyword-placeholder="搜索场号 / 地点 / 剧本节选…"
      @update:model-value="onFilterChange"
      @reset="store.resetFilters()"
    />

    <EmptyPanel
      v-if="ready && filtered.length === 0"
      title="还没有场次"
      description="新建剧本场次，再为每场登记服装 / 道具 / 妆发 / 陈设等连戏要素。"
      create-text="新建场次"
      @create="openCreate"
    />

    <div v-else class="scene-list">
      <div
        v-for="(scene, index) in filtered"
        :key="scene.id"
        class="scene-card"
        :class="{ 'is-dragging': dragIndex === index, 'is-over': overIndex === index }"
        draggable="true"
        @dragstart="onDragStart(index)"
        @dragover.prevent="onDragOver(index)"
        @drop.prevent="onDrop(index)"
        @dragend="dragIndex = null"
      >
        <el-icon class="drag-handle"><Rank /></el-icon>
        <div class="scene-card__order">#{{ index + 1 }}</div>
        <div class="scene-card__body">
          <div class="scene-card__title">
            <strong>第 {{ scene.sceneNo }} 场</strong>
            <el-tag size="small" effect="plain">{{ scene.place }} · {{ scene.timeOfDay }}</el-tag>
            <ConflictTag :state="scene.state" />
            <el-tag v-if="openConflictCountOf(scene.id) > 0" type="danger" size="small" effect="plain">
              未解决冲突 {{ openConflictCountOf(scene.id) }}
            </el-tag>
          </div>
          <div class="scene-card__meta">{{ scene.location }} · 连戏要素 {{ elementCountOf(scene.id) }} 项</div>
          <div class="scene-card__excerpt">{{ scene.excerpt }}</div>
        </div>
        <div class="scene-card__actions">
          <el-button link size="small" :disabled="index === 0" @click="moveBy(index, -1)">上移</el-button>
          <el-button link size="small" :disabled="index === filtered.length - 1" @click="moveBy(index, 1)">下移</el-button>
          <el-button link type="primary" size="small" @click="gotoElements(scene)">要素</el-button>
          <el-button link type="primary" size="small" @click="gotoConflicts(scene)">差异</el-button>
          <el-dropdown trigger="click" @command="(cmd: string) => changeState(scene, cmd as Scene['state'])">
            <el-button link type="warning" size="small">状态</el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item v-for="item in SCENE_STATES" :key="item" :command="item">{{ item }}</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-button link type="primary" size="small" @click="openEdit(scene)">编辑</el-button>
          <el-button link type="danger" size="small" @click="remove(scene)">删除</el-button>
        </div>
      </div>
    </div>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑场次' : '新建场次'" width="560px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="场号" prop="sceneNo">
          <el-input v-model="form.sceneNo" placeholder="如：12A" />
        </el-form-item>
        <el-form-item label="内外景">
          <el-radio-group v-model="form.place">
            <el-radio-button v-for="item in SCENE_PLACES" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="时间">
          <el-radio-group v-model="form.timeOfDay">
            <el-radio-button v-for="item in SCENE_TIMES" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="地点" prop="location">
          <el-input v-model="form.location" placeholder="如：老宅客厅" />
        </el-form-item>
        <el-form-item label="剧本节选">
          <el-input v-model="form.excerpt" type="textarea" :rows="3" placeholder="摘录本场关键动作与台词" />
        </el-form-item>
        <el-form-item label="拍摄状态">
          <el-select v-model="form.state" class="full">
            <el-option v-for="item in SCENE_STATES" :key="item" :label="item" :value="item" />
          </el-select>
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

.scene-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.scene-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  background: #ffffff;
  border: 1px solid #dde7ef;
  border-left: 4px solid #5b8bb8;
  border-radius: 10px;
}

.scene-card.is-dragging {
  opacity: 0.45;
}

.scene-card.is-over {
  border-top: 2px dashed #2f5d8a;
}

.scene-card__order {
  width: 38px;
  font-weight: 700;
  color: #2f5d8a;
  font-variant-numeric: tabular-nums;
}

.scene-card__body {
  flex: 1;
  min-width: 0;
}

.scene-card__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.scene-card__meta {
  margin-top: 4px;
  font-size: 12px;
  color: #7d8b98;
}

.scene-card__excerpt {
  margin-top: 4px;
  font-size: 12px;
  color: #9aa5ad;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scene-card__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
}
</style>
