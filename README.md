# 影视场景连戏与道具接续核对台（gbcontinuity）

面向剧组场记与服装道具部门的本地化核对工具：把剧本场次拆成连戏要素清单，按拍摄日逐条记录现场服装、道具、妆发与陈设的实际状态，自动比对同一场景在不同拍摄日之间的差异，提示冲突并跟踪解决，最后生成连戏核对报告。

核心动作：**建场次与拍摄顺序 → 登记连戏要素 → 录现场状态与镜次 → 比对差异 → 消解冲突并导出报告**。

纯前端单页应用（Vue 3 + TypeScript + Element Plus + Vite + Pinia + Vue Router + Dexie），**无后端、无数据库服务、无 API 服务**，全部数据保存在浏览器本地（IndexedDB），刷新或重启浏览器后仍然存在。

---

## 一、Docker 一键启动（推荐）

```bash
# 1. 首次启动先复制环境变量模板
cp .env.example .env

# 2. 构建并启动
docker compose up -d --build
```

启动完成后访问：**http://localhost:22829**

常用命令：

```bash
docker compose ps                 # 查看服务状态（healthy 表示就绪）
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 代码改动后重新构建
```

> 端口可在 `.env` 中通过 `FRONTEND_PORT` 修改；容器名固定为 `${COMPOSE_PROJECT_NAME:-gbcontinuity}-frontend`。
> 容器无状态：不连接数据库、不挂载命名卷，数据全部在浏览器本地，迁移设备请使用应用内「导出整库备份 / 导入备份」。

---

## 二、技术栈

| 分类 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3（`<script setup>` + Composition API） | 全部页面与组件使用组合式 API |
| 语言 | TypeScript（`strict: true`，无 `any`） | `npm run build` 内含 `vue-tsc --noEmit` 类型检查 |
| UI 组件库 | Element Plus 2.x（含 `@element-plus/icons-vue`） | 表格、卡片、对话框、表单、下拉菜单交互 |
| 构建工具 | Vite 6 | 开发服务器端口 22829 |
| 状态管理 | Pinia（setup store） | `sceneStore` / `elementStore` / `recordStore` / `conflictStore` |
| 路由 | Vue Router 4（history 模式） | nginx 侧配合 `try_files` 做 SPA fallback |
| 本地存储 | Dexie 4（IndexedDB 封装） | 库名 `gbcontinuity-db`，含结构版本号与 upgrade 迁移 |
| 容器化 | Docker 多阶段构建：`node:20-alpine` → `nginx:alpine` | 构建阶段执行类型检查与打包，运行阶段仅托管静态产物 |

---

## 三、本地开发方式

```bash
cd frontend
npm install
npm run dev          # 开发服务器 http://localhost:22829
npm run build        # 类型检查 + 生产构建，产物在 frontend/dist
npm run preview      # 本地预览构建产物（http://localhost:22829）
npm run test:import  # 整库导入流水线端到端测试（Node + fake-indexeddb，无需浏览器）
```

---

## 四、页面与路由

| 路由 | 模块 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/scenes` | 剧本场次与拍摄顺序台账 | Scene、Conflict | 新建/编辑/删除场次、**拖拽调序并自动重编号**、按内外景与日/夜筛选、卡片回显要素数与未解决冲突数、筛选同步 URL query |
| `/elements` | 连戏要素登记 | Element、Scene | 按场次与类别分组展示、维护初始状态与责任人、关键要素标记与高亮、增删改 |
| `/shootdays` | 现场状态记录 | ShootDay、Record、Element | 建立拍摄日并勾选当日场次、按镜次逐条录入当前状态与照片说明、同要素保留历次快照、记录差异角标 |
| `/conflicts` | 连戏差异比对与冲突提示 | Conflict、Record | **重新比对生成差异**、并排展示记录 A / 记录 B、严重程度与解决状态流转、解决后回写要素初始状态并留痕 |
| `/report` | 连戏核对报告与结构版本导出 | 全部模型 | 场次核对小结、风险分统计、本地库版本查看、报告 / 整库 JSON 导出与导入 |

---

## 五、目录结构

```
sologsb101-1029/
├── README.md
├── docker-compose.yml
├── .env / .env.example
├── .gitignore
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files SPA fallback + gzip
    ├── .dockerignore
    ├── index.html / vite.config.ts / tsconfig.json / package.json
    ├── public/favicon.svg
    └── src/
        ├── main.ts  App.vue  env.d.ts
        ├── types/              # scene.ts element.ts shootDay.ts record.ts conflict.ts filter.ts
        ├── stores/             # sceneStore elementStore recordStore conflictStore
        ├── components/common/  # ConflictTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
        ├── hooks/              # useContinuityDiff.ts useIdbTable.ts
        ├── utils/              # diff.ts db.ts export.ts seed.ts uuid.ts query.ts
        ├── pages/              # SceneList ElementRegistry ShootDayLog ConflictBoard ReportExport
        ├── styles/main.css
        └── router/index.ts
```

---

## 六、数据存储说明

- **IndexedDB 库名**：`gbcontinuity-db`（Dexie 封装），结构版本号 `version(1)`，并带 `upgrade()` 迁移逻辑（为历史行补齐行修订号与时间戳）。
- **分表存储**：`scenes` 场次、`elements` 连戏要素、`shootDays` 拍摄日、`records` 现场记录、`conflicts` 连戏差异，共 5 张表；每行带 `revision` / `createdAt` / `updatedAt`。
- **首屏自动播种**：`utils/db.ts` 的 `initDatabase()` 在 `scenes` 表为空时调用 `seedDatabase()`，灌入互相引用的三层演示数据（场次 → 连戏要素 → 拍摄日 → 现场记录 → 差异），其中包含 1 条「阻断 / 待确认」与 1 条「轻微 / 待确认」差异，保证差异页与报告页首次打开就有内容；播种幂等。
- **差异算法**：`utils/diff.ts` 对状态文本做归一化（去掉空白与标点、颜色/款式同义写法归组，如「藏青 / 深蓝」视为同一色），归一后仍有差异才生成条目；关键要素的状态变化判为「阻断」，一般要素的状态变化判为「需处理」，仅照片说明 / 镜次变化判为「轻微」。
- **无后端**：没有 API 服务、没有数据库容器；容器本身无状态，不挂载任何卷。
- **级联规则**：删除场次会级联删除其要素、现场记录与相关差异；删除拍摄日会删除当日记录与相关差异。

### 换设备整库导入：先预检、再留档、分批落地（`utils/importFlow.ts`）

旧版导入是「先清空本机、再一次性整批写」，备份字段对不上会写到一半中断、本机台账也没了。现在报告页「导入备份」走三步向导：

1. **预检（只读，绝不写业务库）**：解析结构版本（缺 `schemaVersion` 视为 v0 历史备份，高于本机版本直接拒绝）；逐表核对必填字段、枚举取值与表内 id 唯一；再核对跨表引用——`elements.sceneId`、`records.elementId/shootDayId`、`conflicts.*` 悬空的行**直接隔离待修**并在清单里列清（如「现场记录找不到连戏要素 / 拍摄日」），`shootDays.sceneIds` 这类多对多关联只剔除悬空 id；预检结论给出每张表的**新增 / 覆盖 / 本机将删**计数。旧备份缺 `revision` 修订号或时间戳的行，按当前结构回填 `revision=1` 并给出汇总提示，业务必填项填不上的才隔离。
2. **留档与指纹**：预检通过即把原始备份文本、预检结论存入独立草稿库 `gbcontinuity-import-db`（不占用业务库结构版本），并记录本机台账指纹（五表 `id+updatedAt` 摘要）。写入前再算一次指纹，**台账在预检后有任何改动，预检结果作废**，必须重新预检。
3. **分批落地与回滚**：正式写入先把导入前整套五表数据原样存进草稿快照，然后按外键顺序（场次→要素→拍摄日→记录→差异）每 100 行一个事务分批写入并显示进度；任何一批失败立即按快照自动恢复到导入前，草稿保留为「已回滚，可重试」。导入成功后快照继续保留，可手动「恢复到导入前」。写入中途关闭页面 / 崩溃，下次进报告页 `recoverInterruptedJobs()` 会自动把台账恢复到导入前并提示重试。

隔离行可在向导里「下载隔离清单」（含备份行号、原因、原始 JSON），修好后重新粘贴预检即可；隔离行在任何情况下都不会写入业务库。
