<script setup lang="ts">
/**
 * 导入预检结果面板：结构版本、逐表新增/覆盖/隔离统计、自动回填告警与隔离待修清单。
 * 纯展示组件，数据来自 importStore.precheck。
 */
import { computed, ref } from 'vue'
import { WarningFilled, CircleCheckFilled, InfoFilled } from '@element-plus/icons-vue'
import type { ImportIssue, PrecheckResult, TableImportStats } from '@/types/importDraft'
import { TABLE_LABELS } from '@/types/importDraft'

const props = defineProps<{
  precheck: PrecheckResult
}>()

const activeNames = ref<string[]>([
  ...props.precheck.stats.filter((s) => s.quarantined > 0).map((s) => s.table),
  'repaired'
])

/** 现场记录里找不到连戏要素 / 拍摄日 / 场次的悬空清单（交接时重点核对项） */
const danglingRecords = computed(() =>
  props.precheck.issues.filter(
    (item) => item.table === 'records' && item.code === 'missing-reference'
  )
)

function issuesOf(rowKey: string, table: TableImportStats['table']): ImportIssue[] {
  return props.precheck.issues.filter((item) => item.rowKey === rowKey && item.table === table)
}
</script>

<template>
  <div class="precheck">
    <el-alert
      v-if="precheck.phase === 'fail'"
      type="error"
      show-icon
      :closable="false"
      :icon="WarningFilled"
      title="预检未通过，不能导入"
      :description="precheck.fatalErrors.join('；')"
      class="precheck__alert"
    />
    <template v-else>
      <el-alert
        :type="precheck.phase === 'pass-with-quarantine' ? 'warning' : 'success'"
        show-icon
        :closable="false"
        :icon="precheck.phase === 'pass-with-quarantine' ? WarningFilled : CircleCheckFilled"
        class="precheck__alert"
        :title="
          precheck.phase === 'pass-with-quarantine'
            ? `预检通过，但有 ${precheck.totals.quarantined} 条坏数据将隔离待修，不会写库`
            : '预检通过：全部行均可写入'
        "
        :description="`共 ${precheck.totals.input} 条：净新增 ${precheck.totals.added} 条，覆盖本机同 id ${precheck.totals.overwritten} 条。`"
      />

      <el-alert
        v-if="precheck.upgraded"
        type="info"
        show-icon
        :closable="false"
        :icon="InfoFilled"
        class="precheck__alert"
        :title="`旧结构升级：备份为 v${precheck.sourceSchemaVersion}，本机当前 v${precheck.targetSchemaVersion}`"
        description="缺行修订号/时间戳的旧数据已按当前结构回填；个别必填项填不上的已打「待修」并隔离，见下方清单。"
      />

      <el-alert
        v-if="danglingRecords.length > 0"
        type="error"
        show-icon
        :closable="false"
        :icon="WarningFilled"
        class="precheck__alert"
        :title="`${danglingRecords.length} 条现场记录找不到连戏要素 / 拍摄日 / 场次，已隔离不写库`"
      >
        <ul class="dangling-list">
          <li v-for="issue in danglingRecords" :key="issue.id">
            <span class="dangling-list__key">{{ issue.rowKey }}</span>
            <span class="muted">{{ issue.message }}</span>
          </li>
        </ul>
      </el-alert>

      <el-table :data="precheck.stats" border size="small" class="precheck__table">
        <el-table-column prop="label" label="表" width="110" />
        <el-table-column prop="total" label="备份条数" width="90" align="right" />
        <el-table-column label="新增" width="80" align="right">
          <template #default="{ row }: { row: TableImportStats }">
            <el-tag type="success" size="small" effect="plain">+{{ row.added }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="覆盖" width="80" align="right">
          <template #default="{ row }: { row: TableImportStats }">
            <el-tag v-if="row.overwritten > 0" type="warning" size="small" effect="plain">{{ row.overwritten }}</el-tag>
            <span v-else class="muted">0</span>
          </template>
        </el-table-column>
        <el-table-column label="自动回填" width="90" align="right">
          <template #default="{ row }: { row: TableImportStats }">
            <el-tag v-if="row.repaired > 0" type="info" size="small">{{ row.repaired }}</el-tag>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="隔离待修" width="100" align="right">
          <template #default="{ row }: { row: TableImportStats }">
            <el-tag v-if="row.quarantined > 0" type="danger" size="small">{{ row.quarantined }}</el-tag>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
      </el-table>

      <el-collapse v-if="precheck.quarantined.length > 0" v-model="activeNames" class="precheck__details">
        <el-collapse-item
          v-for="stat in precheck.stats.filter((s) => s.quarantined > 0)"
          :key="stat.table"
          :name="stat.table"
          :title="`${TABLE_LABELS[stat.table]} · 隔离待修 ${stat.quarantined} 条`"
        >
          <el-table :data="precheck.quarantined.filter((q) => q.table === stat.table)" border size="small">
            <el-table-column prop="title" label="记录" min-width="180" />
            <el-table-column label="待修问题" min-width="240">
              <template #default="{ row }">
                <div v-for="issue in issuesOf(row.rowKey, stat.table).filter((i) => !i.repaired)" :key="issue.id" class="issue issue--block">
                  <el-icon><WarningFilled /></el-icon>
                  <span>{{ issue.message }}</span>
                </div>
              </template>
            </el-table-column>
          </el-table>
        </el-collapse-item>
      </el-collapse>

      <el-collapse v-if="precheck.issues.some((i) => i.repaired)" v-model="activeNames" class="precheck__details">
        <el-collapse-item name="repaired" :title="`自动回填 / 剔除告警（${precheck.issues.filter((i) => i.repaired).length} 条，不影响写入）`">
          <div
            v-for="issue in precheck.issues.filter((i) => i.repaired).slice(0, 100)"
            :key="issue.id"
            class="issue issue--repair"
          >
            <el-icon><InfoFilled /></el-icon>
            <span class="muted">[{{ TABLE_LABELS[issue.table] }} · {{ issue.rowKey }}] {{ issue.message }}</span>
          </div>
          <p v-if="precheck.issues.filter((i) => i.repaired).length > 100" class="muted">仅显示前 100 条，其余告警随草稿保留。</p>
        </el-collapse-item>
      </el-collapse>
    </template>
  </div>
</template>

<style scoped>
.precheck__alert {
  margin-bottom: 10px;
}
.precheck__table {
  margin-bottom: 10px;
}
.precheck__details {
  margin-top: 4px;
}
.issue {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12px;
  line-height: 1.6;
}
.issue--block {
  color: var(--el-color-danger);
}
.issue--repair .muted {
  line-height: 1.6;
}
.dangling-list {
  margin: 4px 0 0;
  padding-left: 18px;
  max-height: 140px;
  overflow: auto;
}
.dangling-list li {
  line-height: 1.8;
}
.dangling-list__key {
  font-weight: 600;
  margin-right: 8px;
}
.muted {
  color: var(--el-text-color-secondary);
}
</style>
