# 船舶危险货箱配载审定服务

TypeScript / Node.js + PostgreSQL 实现的危险货箱三维舱位配载审定（stowage plan approval）HTTP 服务。

调度员按**修订号（乐观并发）**整批调整箱位，服务仅按**最终布局**一次性校验全部规则，任一违反即**整批拒绝**并指出相关箱号、舱位与原因；签发装载清单时内容冻结到当时修订号，旧清单永久保留。

**航次安全约束（默认列承重、按列覆盖限额、不相容类别对）同样按修订号演进**：调度员携带所见修订号即可整批替换整套约束；受理前按新约束复验当前完整布局，违反即拒绝、修订号不变，受理后修订号 +1、布局原样继承。约束随每个修订号留痕，**历史布局查询总展示当时生效的约束**；舱位尺寸与箱档案登记后不可变更。

清单签发后，现场以该冻结清单为基准开启**装船核对作业（check job）**：逐箱上报实装位置或撤销（未装），以每箱最后一条上报确定当前状态，服务实时给出应装/已核对/缺失/错位/清单外箱明细；全部与冻结清单一致且无清单外箱方可结案冻结，之后拒绝新上报。核对基准一经开工即固定，后续布局调整、**约束变更**或新签发清单均不影响在办作业。

调度员还可从航次**当前修订号**派生一个或多个相互独立的**试排方案（stowage plan）**：每个方案以创建时的布局为初值、**固定当时的安全约束快照**，并记录来源修订号（`sourceRevision`）与独立的方案修订号（`planRevision`，初始 0）。方案内整批调整沿用既有箱号/坐标/最终布局五项校验，但按**方案修订号**做乐观并发，任何请求级错误、规则违反或修订号过期都不改变方案。**试排期间正式航次、清单与核对作业完全不受影响**。发布（publish）时仅当航次当前修订号仍等于来源修订号，才把方案布局**原子写入航次新修订号并继承该约束**；否则返回 `409 plan_publish_conflict` 且方案保留。发布成功后方案只读，重复发布幂等返回首次发布结果。

---

## 1. 模型与规则

### 坐标系（三维舱位）

| 维度 | 字段 | 取值 |
| --- | --- | --- |
| 舱/贝 | `bay` | `1..bays` |
| 列 | `row` | `1..rows` |
| 层（自底向上） | `tier` | `0..tiers-1`，底层为 `tier=0` |

“列”指同一 `(bay, row)` 下垂直堆叠的一列箱。两箱位距离为三维曼哈顿距离：

```
d = |Δbay| + |Δrow| + |Δtier|
```

### 登记数据

- 航次三维舱位尺寸 `bays / rows / tiers`；
- 各列承重上限：默认上限 + 按 `(bay,row)` 覆盖的单列上限（重量单位 kg，支持最多 6 位小数，内部以整数存储，无浮点误差）；
- 箱号、重量（正数）、危险品类别；
- 不相容类别对的**正整数**最小曼哈顿距离；**未设定的类别对视为相容**。

### 整批调整语义

- 每次提交携带调度员所见的 `baseRevision`；
- 一批中可包含任意多条 `{boxNo, position}`，`position=null` 表示该箱**暂留空（撤位）**；
- **允许同批交换**：以最终布局为准（先撤后放只是计算方式，不存在“中间态冲突”）；
- 未出现在批次中的箱保持原位；
- 箱位可以留空（未配位），仅在**签发清单**时要求所有箱已配位。

### 最终布局校验规则（任一违反则整批拒绝）

1. **一箱至多一位**（同一箱在最终布局中不得出现两次）；
2. **一位至多一箱**（同一三维坐标不得放两个箱）；
3. **各列自底向上连续占用**：同列占用层必须恰好为 `tier 0..k-1`，不得悬空；
4. **列总重量不超上限**：按默认/单列上限逐列核算；
5. **不相容类别对距离**：两箱曼哈顿距离必须 ≥ 设定的最小距离。

### 请求级错误（HTTP 400 / 409）

- 未知箱号 → `unknown_box`；
- 坐标越界、重量非法 → `invalid_coordinates` / 请求体校验错误；
- 同一批中同一箱号出现多次 → `duplicate_box_in_batch`；
- `baseRevision` 与当前修订号不一致 → **409 `stale_revision`**（响应中给出当前修订号）。

### 修订号与清单

- 初始修订号为 `0`（空布局）；每接受一批合法调整，修订号 +1，历史布局全量留痕可查；
- 事务内对航次行 `SELECT ... FOR UPDATE`，并发提交只有一个能成功，其余得到 409；
- 签发要求**所有箱已配位**（否则 422 `unplaced_boxes`），且 `expectedRevision` 必须等于当前修订号；
- 清单内容**复制冻结**到独立的 `manifest_items`，之后调整布局不影响旧清单；
- 旧清单继续可查，列表中以 `current` 标识其是否指向当前修订号——因此**永远不存在指向过期布局的“当前清单”**；
- 对同一修订号重复签发幂等（返回已冻结的清单）。

### 安全约束变更语义（`POST /constraints`）

- 提交体携带调度员所见 `baseRevision`，并给出**整套**：`defaultColumnWeightLimit`、`columnWeightLimits`（按列覆盖）、`incompatRules`（不相容类别对）；
- **全量替换**：未在本次列出的按列覆盖项、不相容类别对即视为撤销（想保留就得连同再传一次）；
- **舱位尺寸（`bays/rows/tiers`）与箱档案（箱号/重量/类别）登记后不变**，本接口不接收这些字段；
- 沿用登记时的校验：承重必须为**正数**（最多 6 位小数）、按列覆盖的列坐标必须在舱位范围内、不相容类别对**归一化后唯一**（`(a,b)` 与 `(b,a)` 视为同一对），任一不满足 → 400；
- 受理前按**新约束**对**当前完整布局**复验五项配载规则：任一违反 → 422 `validation_failed`（返回箱号、位置、原因），**规则与修订号均不变**；
- `baseRevision` 与当前修订号不一致 → **409 `stale_revision`**（响应给出当前修订号），与整批调整一致；
- 受理后修订号 +1：**当前布局原样继承**到新修订号（箱位不变），新约束自新修订号生效；
- **约束按修订号留痕**：`GET /layout?rev=N` 总返回修订号 N 当时生效的整套约束（默认承重/按列覆盖/类别对），当前布局返回新约束；
- **旧清单与在办核对**以各自冻结清单为基准，约束变更不影响其内容与判定；**后续的整批调整与签发**按新约束复验；
- 事务内对航次行 `SELECT ... FOR UPDATE`，与整批调整共用同一修订号序列，并发提交只有一个成功，其余得到 409。

> 布局调整（`/moves`）与约束变更（`/constraints`）都会使修订号 +1 并各自把“不变的另一半”快照复制到新修订号：`/moves` 沿用当前约束、生成新布局；`/constraints` 沿用当前布局、写入新约束。

---

## 2. 一键启动（Docker Compose）

前置：Docker 20.10+（支持 Compose v2）。

```bash
# 在项目根目录
docker compose up --build -d
```

启动后：

- API 服务：`http://localhost:3000`
- 健康检查：`http://localhost:3000/health`
- PostgreSQL：`localhost:5432`（库/用户/密码默认均为 `stowage`，数据持久化在命名卷 `stowage-pgdata`）

应用容器会等待数据库健康、自动执行幂等的 `src/schema.sql` 建表，无需手动初始化。

停止与清理：

```bash
docker compose down          # 停止，保留数据
docker compose down -v       # 停止并删除数据库卷
```

### 配置（环境变量 / `.env`）

复制 `.env.example` 为 `.env` 后由 Compose 自动读取：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `API_PORT` | `3000` | API 对宿主端口 |
| `DB_PORT` | `5432` | PostgreSQL 对宿主端口 |
| `POSTGRES_USER` | `stowage` | 数据库用户 |
| `POSTGRES_PASSWORD` | `stowage` | 数据库密码 |
| `POSTGRES_DB` | `stowage` | 数据库名 |
| `PORT`（容器内） | `3000` | 服务监听端口 |
| `DATABASE_URL` | 指向 `db:5432` | 应用连接串 |
| `DB_STARTUP_TIMEOUT_SEC` | `60` | 等待数据库就绪最长秒数 |
| `SCHEMA_PATH` | `/app/src/schema.sql` | 建表脚本路径 |

---

## 3. 本地开发（不用 Docker）

```bash
npm install
npm run build      # tsc 编译到 dist/
# 需自行准备 PostgreSQL 14+，并设置连接串，例如：
export DATABASE_URL='postgres://stowage:stowage@localhost:5432/stowage'
npm start          # 启动（自动等待 DB + 建表）

npm run dev        # 或 tsx watch 热重载
npm test           # 纯函数单元测试（配载规则 + 装船核对）

# 端到端测试（需 devDependency embedded-postgres，首次运行会自动下载本地 PG）
npm run build && node test/e2e.js             # 配载/签发/并发
npm run build && node test/e2e-check.js       # 核对作业/上报/结案/并发
npm run build && node test/e2e-constraints.js # 安全约束变更/历史留痕/冻结基准/并发
npm run build && node test/e2e-stowage-plans.js # 试排方案：独立沙箱/方案修订号/发布冲突/原子发布/幂等只读
```

---

## 4. HTTP API

基址 `/api`，请求/响应均为 JSON。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/voyages` | 登记航次（舱位、列承重、箱、不相容规则） |
| `GET` | `/api/voyages` | 航次列表 |
| `GET` | `/api/voyages/:id` | 航次元数据（含当前修订号） |
| `GET` | `/api/voyages/:id/layout?rev=N` | 查看布局与该修订号**当时生效的约束**（缺省当前修订号；可查历史） |
| `POST` | `/api/voyages/:id/moves` | **整批调整**（携带 `baseRevision`） |
| `POST` | `/api/voyages/:id/constraints` | **安全约束变更**（整套默认承重/按列覆盖/类别对，携带 `baseRevision`） |
| `POST` | `/api/voyages/:id/manifests` | **签发装载清单**（携带 `expectedRevision`） |
| `GET` | `/api/voyages/:id/manifests` | 清单列表（旧清单保留，带 `current` 标记） |
| `GET` | `/api/voyages/:id/manifests/:rev` | 取某修订号的冻结清单 |
| `POST` | `/api/voyages/:id/check-jobs` | **开启核对作业**（基准为已签发清单修订号） |
| `GET` | `/api/voyages/:id/check-jobs` | 航次下核对作业列表 |
| `POST` | `/api/voyages/:id/stowage-plans` | **建立试排方案**（从当前修订号 fork；可选 `baseRevision` 读后确认） |
| `GET` | `/api/voyages/:id/stowage-plans` | 航次下试排方案列表（版本/状态，不含布局明细） |
| `GET` | `/api/stowage-plans/:planId` | 查询方案（当前试排布局 + 固定约束 + 版本信息） |
| `POST` | `/api/stowage-plans/:planId/moves` | **方案内整批调整**（`baseRevision` 为方案修订号） |
| `POST` | `/api/stowage-plans/:planId/publish` | **发布方案**（原子写入航次新修订号；重复发布幂等） |
| `GET` | `/api/check-jobs/:jobId` | 核对状态（应装/已核对/缺失/错位/清单外箱） |
| `POST` | `/api/check-jobs/:jobId/reports` | **核对上报**（实装位置/撤销 + 唯一上报号） |
| `GET` | `/api/check-jobs/:jobId/reports` | 上报留痕 |
| `POST` | `/api/check-jobs/:jobId/close` | **结案冻结**（有差异返回 409，作业继续开放） |
| `GET` | `/health` | 健康检查（含数据库连通性） |

### 4.1 登记航次

```bash
curl -sS -X POST http://localhost:3000/api/voyages \
  -H 'content-type: application/json' -d '{
  "voyageNo": "V-2026-001",
  "bays": 3, "rows": 2, "tiers": 3,
  "defaultColumnWeightLimit": "10000",
  "columnWeightLimits": [
    { "bay": 1, "row": 1, "weightLimit": "1200" }
  ],
  "boxes": [
    { "boxNo": "BOX-1", "weight": "500",    "category": "1" },
    { "boxNo": "BOX-2", "weight": "600",    "category": "3" },
    { "boxNo": "BOX-3", "weight": "400",    "category": "5" },
    { "boxNo": "BOX-4", "weight": "300.25", "category": "1" }
  ],
  "incompatRules": [
    { "categoryA": "1", "categoryB": "3", "minDistance": 3 }
  ]
}'
```

响应（修订号初始为 0）：

```json
{ "id": "…uuid…", "voyageNo": "V-2026-001", "bays": 3, "rows": 2, "tiers": 3,
  "defaultColumnWeightLimit": "10000", "revision": 0, "createdAt": "…" }
```

### 4.2 整批调整（合法）

```bash
curl -sS -X POST http://localhost:3000/api/voyages/<id>/moves \
  -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [
    { "boxNo": "BOX-1", "position": { "bay": 1, "row": 1, "tier": 0 } },
    { "boxNo": "BOX-2", "position": { "bay": 3, "row": 2, "tier": 0 } },
    { "boxNo": "BOX-3", "position": { "bay": 2, "row": 2, "tier": 0 } },
    { "boxNo": "BOX-4", "position": { "bay": 1, "row": 1, "tier": 1 } }
  ]
}'
```

`position: null` 表示把该箱撤下留空。成功返回新修订号与完整新布局。

### 4.3 规则违反：整批拒绝（422，含箱号/舱位/原因）

```json
{
  "error": {
    "code": "validation_failed",
    "message": "配载校验未通过，共 1 项违反，整批调整已拒绝",
    "details": {
      "violationCount": 1,
      "violations": [
        {
          "reason": "incompatible_too_close",
          "message": "不相容类别箱 BOX-1(1类) 与 BOX-2(3类) 曼哈顿距离为 1，要求至少 3",
          "boxA": "BOX-1", "boxB": "BOX-2",
          "categoryA": "1", "categoryB": "3",
          "positionA": { "bay": 1, "row": 1, "tier": 0 },
          "positionB": { "bay": 2, "row": 1, "tier": 0 },
          "distance": 1, "minDistance": 3
        }
      ]
    }
  }
}
```

违反原因码：

| `reason` | 含义 | 关键定位字段 |
| --- | --- | --- |
| `box_duplicated` | 一箱多位 | `boxNo`, `positions[]` |
| `position_collision` | 一位多箱 | `position`, `boxNos[]` |
| `column_not_continuous` | 列未自底向上连续/悬空 | `bay`,`row`,`occupiedTiers`,`missingTiers`,`boxNos[]` |
| `column_overweight` | 列总重超限 | `bay`,`row`,`totalWeight`,`weightLimit`,`boxNos[]` |
| `incompatible_too_close` | 不相容箱距离不足 | `boxA`,`boxB`,`positionA`,`positionB`,`distance`,`minDistance` |

### 4.4 过期修订号（409）

```json
{
  "error": {
    "code": "stale_revision",
    "message": "修订号已过期：携带的 0 与当前修订号 2 不一致，请重新读取最新布局后再提交",
    "details": { "expectedRevision": 0, "currentRevision": 2 }
  }
}
```

### 4.5 安全约束变更（整套替换 + 受理前复验）

```bash
curl -sS -X POST http://localhost:3000/api/voyages/<id>/constraints \
  -H 'content-type: application/json' -d '{
  "baseRevision": 1,
  "defaultColumnWeightLimit": "9000",
  "columnWeightLimits": [
    { "bay": 2, "row": 2, "weightLimit": "9999" }
  ],
  "incompatRules": [
    { "categoryA": "1", "categoryB": "5", "minDistance": 2 }
  ]
}'
```

- 三个约束字段按**整套**提交（与登记请求体一致）；省略的 `columnWeightLimits` / `incompatRules` 按空数组处理（即**撤销全部**覆盖项/类别对）；
- 受理成功返回新修订号、`constraintsChanged:true`、`layoutInherited:true`，以及继承后的完整 `layout`（箱位不变，约束字段已是新值）；
- 当前布局在新约束下违反规则 → 422 `validation_failed`，`violations[]` 与整批调整同构（含箱号、位置、原因），修订号与规则保持不变；
- 修订号过期 → 409 `stale_revision`（`details.currentRevision` 为当前修订号）；
- 非正承重、越界列坐标、重复类别对/列覆盖 → 400 `invalid_request_body` 或 `invalid_column_limit` / `duplicate_incompat_rule` / `duplicate_column_limit`。

随后 `GET /layout?rev=1` 仍返回 rev=1 当时生效的旧约束；`GET /layout`（当前）返回新约束。**未变更的接口字段保持不变**，历史布局响应只是在原有字段位置反映各修订号自己的约束。

### 4.6 签发与冻结

```bash
curl -sS -X POST http://localhost:3000/api/voyages/<id>/manifests \
  -H 'content-type: application/json' -d '{ "expectedRevision": 4 }'
```

返回冻结清单（`current:true`）。之后再调整布局，重新 `GET /manifests` 可见旧清单 `current:false` 仍在；只有再次签发才会产生指向当前布局的新清单。

### 4.7 现场装船核对

核对作业以航次**已签发清单的修订号**为基准开启；同一清单最多一个作业。基准引用冻结副本（`manifest_items`），开工后无论布局怎样调整、**安全约束怎样变更**、签发多少新清单，该作业的核对基准都不变。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/voyages/:id/check-jobs` | 以 `{ "manifestRevision": N }` 开启核对作业 |
| `GET` | `/api/voyages/:id/check-jobs` | 航次下的核对作业列表 |
| `GET` | `/api/check-jobs/:jobId` | 查询核对状态（五类明细） |
| `POST` | `/api/check-jobs/:jobId/reports` | 上报一箱（唯一 `reportNo`） |
| `GET` | `/api/check-jobs/:jobId/reports` | 上报留痕（按受理顺序） |
| `POST` | `/api/check-jobs/:jobId/close` | 结案冻结 |

**开工**

```bash
curl -sS -X POST http://localhost:3000/api/voyages/<id>/check-jobs \
  -H 'content-type: application/json' -d '{ "manifestRevision": 4 }'
```

清单修订号不存在（未签发过）→ 404 `manifest_not_found`，拒绝开工；同一清单重复开工 → 409 `check_job_exists`（`details.existingJob` 带回既有作业）。返回体含作业信息与冻结的 `expected` 应装明细。

**上报**

```bash
# 实装位置（position 非空）
curl -sS -X POST http://localhost:3000/api/check-jobs/<jobId>/reports \
  -H 'content-type: application/json' -d '{
  "reportNo": "RPT-0001",
  "boxNo": "BOX-1",
  "position": { "bay": 1, "row": 1, "tier": 0 }
}'

# 撤销标记（position=null）：表示该箱未装，回到“缺失”
curl -sS -X POST http://localhost:3000/api/check-jobs/<jobId>/reports \
  -H 'content-type: application/json' -d '{
  "reportNo": "RPT-0002", "boxNo": "BOX-2", "position": null
}'
```

上报语义：

- `reportNo` 为**作业内唯一上报号**（客户端生成，如流水号/UUID）；
- 相同 `reportNo` + **相同内容**重试 → `200 { replay: true, ... }`，返回首次受理的原结果（含原 `seq` 与当时状态），不产生新记录；
- 相同 `reportNo` + **不同内容**（箱号/位置/撤销任一不同）→ 409 `report_no_conflict`；
- 坐标越界（超出航次 `bays/rows/tiers`）→ 400 `invalid_coordinates`，该次不留痕；
- 每次成功受理均**留痕**（自增 `seq`），以**箱号最后一条上报**确定当前实装状态：最后一条为撤销即未装；
- 上报箱号无需预先校验：不在冻结清单中的箱号按“清单外箱”跟踪（实装计入差异、撤销则消失）。

**状态查询**返回五类明细与计数：

| 明细 | 含义 |
| --- | --- |
| `details.expected` | 应装：冻结清单全部箱及其计划位置 |
| `details.checked` | 已核对：清单箱当前坐标与清单完全一致 |
| `details.missing` | 缺失：从未上报（`reason:"none"`）或最后一条为撤销（`reason:"revoked"`） |
| `details.misplaced` | 错位：清单箱当前实装坐标 ≠ 清单坐标（含应装/实装两个坐标） |
| `details.extra` | 清单外箱：不在清单中的箱号当前处于实装状态 |

顶层另有 `counts`、`closeable`（缺失/错位/清单外均为 0）、`status`（`open`/`closed`）、`frozen`。

**结案**

```bash
curl -sS -X POST http://localhost:3000/api/check-jobs/<jobId>/close
```

- 仅当所有清单箱当前坐标与冻结清单一致 **且** 无清单外箱时结案成功（201），作业置 `closed`、记录 `closedAt`、结果冻结；
- 否则 409 `check_not_closeable`，响应 `details.status` 带回全部差异，作业继续开放，可继续上报后重试；
- 已结案重复结案幂等（200 `replay:true`）；
- **结案后新上报号一律 409 `check_job_closed`；已受理过的上报号仍可相同内容重试**（返回冻结的原结果）。

**并发**：所有上报与结案在事务内对作业行 `SELECT ... FOR UPDATE`，严格顺序生效；并发上报的 `seq` 连续无重复，上报与结案并发时以获得锁的先后为准（结案先到则新上报被拒，上报先到则按当时状态判定结案）。

### 4.8 试排方案（独立沙箱 → 发布）

试排方案是从航次**当前修订号**派生的独立沙箱：创建时复制当时布局为初值、**固定当时生效的整套安全约束**（之后直接引用该来源修订号的不可变约束快照），并持有与航次修订序列无关的**方案修订号**。同一航次可同时存在任意多个方案，彼此独立；试排过程不触碰正式航次修订号、布局历史、清单与核对作业。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/voyages/:id/stowage-plans` | 建立方案（请求体可空，即从当前修订号 fork；或 `{"baseRevision":N}` 读后确认） |
| `GET` | `/api/voyages/:id/stowage-plans` | 航次下方案列表（来源/方案修订号、状态、已配位箱数；不含布局明细） |
| `GET` | `/api/stowage-plans/:planId` | 查询方案：当前试排布局、固定约束与全部版本信息 |
| `POST` | `/api/stowage-plans/:planId/moves` | 方案内整批调整（`baseRevision` 为**方案修订号**，`moves` 与正式接口同构） |
| `POST` | `/api/stowage-plans/:planId/publish` | 发布到正式航次 |

**建立**

```bash
curl -sS -X POST http://localhost:3000/api/voyages/<id>/stowage-plans \
  -H 'content-type: application/json' -d '{}'
```

返回（`201`）：

```json
{
  "plan": {
    "planId": "…uuid…",
    "voyageId": "…uuid…",
    "sourceRevision": 1,
    "planRevision": 0,
    "status": "draft",
    "published": false,
    "publishedVoyageRevision": null,
    "createdAt": "…",
    "publishedAt": null,
    "voyageCurrentRevision": 1,
    "sourceCurrent": true,
    "layout": {
      "geometry": { "bays": 3, "rows": 3, "tiers": 2 },
      "defaultColumnWeightLimit": "10000",
      "columnWeightLimits": [ { "bay": 1, "row": 1, "weightLimit": "1200" } ],
      "incompatRules": [ { "categoryA": "1", "categoryB": "3", "minDistance": 3 } ],
      "boxes": [ …箱档案，登记后不变… ],
      "placements": [ …创建时布局副本… ],
      "unplacedBoxNos": [ …未配位箱号… ]
    }
  }
}
```

- 携带的 `baseRevision` 与航次当前修订号不一致 → 409 `stale_revision`（不能从历史修订号 fork）；
- 未知航次 → 404 `voyage_not_found`。

**方案内整批调整**

```bash
curl -sS -X POST http://localhost:3000/api/stowage-plans/<planId>/moves \
  -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [ { "boxNo": "BOX-2", "position": { "bay": 2, "row": 3, "tier": 0 } } ]
}'
```

- 请求体、请求级错误（`unknown_box` / `invalid_coordinates` / `duplicate_box_in_batch`）与 422 `validation_failed` 五项违反明细**与正式 `/moves` 完全同构**；
- 校验使用**创建时固定的约束快照**——试排期间正式约束无论怎样变更，方案仍按其来源修订号的约束判定；
- 乐观并发按**方案修订号**：过期 → 409 `stale_revision`，`details.revisionScope` 为 `"plan"`，并给出方案当前修订号；
- 试排**允许箱未配位**（`position:null` 撤位、不要求全配位）；
- 任何失败（400/409/422）事务回滚，方案布局与方案修订号都不变；
- 成功返回 `planRevision` / `previousPlanRevision` / `applied` 与完整方案视图。

**查询** `GET /api/stowage-plans/:planId` 返回 `{ plan: { …版本…, layout: { 当前试排布局 + 固定约束 } } }`；其中 `voyageCurrentRevision` 为航次当前修订号、`sourceCurrent` 表示来源修订号是否仍为当前（即现在发布是否不会冲突）。未知方案 → 404 `stowage_plan_not_found`；非法 UUID → 400。

**发布**

```bash
curl -sS -X POST http://localhost:3000/api/stowage-plans/<planId>/publish
```

- 仅当航次当前修订号 **仍等于** `sourceRevision`：
  - 同一事务内把方案布局写入航次 `placements` 的**新修订号**（`rev+1`），并把来源修订号的整套约束快照**继承**到该新修订号（`constraintsInherited:true`）；
  - 方案置 `published`、记录 `publishedVoyageRevision` 与 `publishedAt`，之后**只读**；
  - 返回 `201`：`voyageRevision`、`previousVoyageRevision`、`sourceRevision`、`planRevision`、`plan`（只读视图）、`layout`（写入后的正式布局）。
- 航次已自来源修订号演进（有过正式 `/moves` 或 `/constraints`）→ **409 `plan_publish_conflict`**，`details` 带 `sourceRevision/currentRevision/planRevision`，**方案原样保留**（仍可查询、继续调整或放弃）；
- 已发布方案再次发布 → **200 `replay:true`**，返回**首次发布结果**（同一 `voyageRevision`），不产生新修订号；
- 已发布方案再调整 → 409 `plan_readonly`。

**冻结语义不受影响**：发布只是航次一次普通的修订号推进——历史布局、旧清单（含 `current` 标记）、在办核对作业仍各自遵循原有冻结语义；清单只能由正式签发接口产生，试排方案本身不能签发清单、也不能开启核对作业。

### 状态码约定

| 状态 | 场景 |
| --- | --- |
| 200 / 201 | 查询成功 / 创建或首次签发、首次受理上报、首次结案成功、**方案首次发布成功 201**（幂等重试、**方案重复发布**返回 200） |
| 400 | 请求体非法、未知箱、坐标越界、同批重复箱号；约束变更的非正承重/越界列坐标/重复类别对或重复列覆盖 |
| 404 | 航次/修订号/清单/核对作业/**试排方案**不存在（含以未签发清单开工） |
| 409 | 修订号过期（整批调整、约束变更、签发共用；**方案内调整使用方案修订号，`details.revisionScope:"plan"`**）；同清单重复开工、上报号内容冲突、结案后新上报、核对有差异不可结案；**方案来源修订号已过期不可发布（`plan_publish_conflict`）、已发布方案再调整（`plan_readonly`）** |
| 422 | 配载规则违反整批拒绝（整批调整或约束变更复验当前布局）；或尚有箱未配位即签发 |
| 503 | `/health` 数据库不可达 |

---

## 5. 调用示例

- `examples/curl-examples.sh` —— 全流程 curl（登记→违规拒绝→合法整批→同批交换→撤位→签发→后续调整→旧清单）：

  ```bash
  BASE=http://localhost:3000 bash examples/curl-examples.sh
  ```

- `examples/check-curl.sh` —— 现场核对全流程 curl（自备已签发清单→开工→上报/重试/冲突/越界→错位/清单外→撤销→结案→结案后行为）：

  ```bash
  BASE=http://localhost:3000 bash examples/check-curl.sh
  ```

- `examples/constraints-curl.sh` —— 安全约束变更全流程 curl（配位→复验失败 422→过期 409→请求级 400→整套替换成功/布局继承→历史布局旧约束→旧清单与在办核对不受影响→后续调整按新约束）：

  ```bash
  BASE=http://localhost:3000 bash examples/constraints-curl.sh
  ```

- `examples/stowage-plans-curl.sh` —— 试排方案全流程 curl（建多个独立方案→方案内调整/422/方案修订号 409→正式航次不受影响→航次演进后发布冲突且方案保留→干净路径原子发布并继承约束→重复发布幂等→发布后只读→未知方案 404）：

  ```bash
  BASE=http://localhost:3000 bash examples/stowage-plans-curl.sh
  ```

- `examples/api.http` —— REST Client / JetBrains HTTP Client 文件（含核对段落）；
- `examples/demo.ts` —— Node 示例（内置 fetch）：

  ```bash
  BASE=http://localhost:3000 npx tsx examples/demo.ts
  ```

---

## 6. 项目结构

```
src/
  domain.ts        领域模型 + 纯函数规则校验（最终布局五项规则、请求级检查、十进制重量）
  check.ts         装船核对纯函数（最后上报汇总、应装/已核对/缺失/错位/清单外、结案条件）
  service.ts       事务编排：乐观修订号、整批调整、签发冻结、并发互斥
  stowage-plan-service.ts 试排方案事务：fork 沙箱、方案修订号并发、来源约束快照、冲突检测、原子发布与幂等只读
  check-service.ts 核对作业事务：开工/上报幂等与冲突/留痕/状态/结案冻结（行级互斥）
  db.ts            连接池、等待就绪、幂等建表
  schema.sql       PostgreSQL 表结构（航次/列限/箱/不相容规则/修订布局/清单/核对作业与上报/试排方案）
  http/            Express 路由与 zod 请求校验
  config.ts errors.ts app.ts start.ts
test/
  validator.test.ts  配载规则单元测试（node --test）
  check.test.ts      核对纯函数单元测试
  e2e.js             对真实 PostgreSQL 的端到端/并发验证（开发辅助）
  e2e-check.js       核对作业端到端/并发验证（开发辅助）
  e2e-constraints.js 安全约束变更端到端/历史留痕/并发验证（开发辅助）
  e2e-stowage-plans.js 试排方案端到端/沙箱隔离/发布冲突/原子发布/幂等验证（开发辅助）
examples/          curl / .http / Node 调用示例
Dockerfile  docker-compose.yml
```

### 存储要点

- `voyages.rev` 为当前修订号；`placements` 按 `(voyage_id, rev)` 全量保存每个接受批次后的完整布局（历史可追溯）；
- **约束随修订号快照**：`constraint_defaults` / `constraint_column_limits` / `constraint_incompat_rules` 按 `(voyage_id, rev)` 保存每个修订号当时生效的整套默认列承重、按列覆盖与不相容类别对。整批调整把当前约束复制到新修订号；约束变更把当前布局复制到新修订号并写入新约束；
- 舱位尺寸存于 `voyages`、箱档案存于 `boxes`，二者登记后不可变更（约束变更不触碰）；
- `manifests` + `manifest_items` 保存签发时刻的**独立冻结副本**，与后续布局/约束解耦；
- 重量以 `BIGINT` 微千克（1kg = 10⁶）存储，精确支持小数重量；
- `check_jobs` 以 `(voyage_id, manifest_rev)` 唯一引用冻结清单（同一清单最多一个作业，外键随清单删除级联）；
- `check_reports` 每次受理上报一行：`(job_id, report_no)` 唯一保证上报号幂等、`(job_id, seq)` 唯一记录受理顺序；`revoked=true` 时坐标为空。当前实装状态取每箱 `seq` 最大的一条；
- `stowage_plans` 保存试排方案：`source_rev`（创建时航次修订号，同时确定引用哪一份不可变约束快照）+ 独立的 `plan_rev`（方案修订号）+ `status/published_voyage_rev/published_at`；
- `stowage_plan_placements` 保存方案**当前**试排布局（`plan_id+box_no` 唯一、`plan_id+bay+row+tier` 唯一），方案调整在校验通过后于同一事务内整批替换（DELETE+INSERT），失败方案不变。方案不另存约束，直接按 `(voyage_id, source_rev)` 引用既有约束快照；发布时再把该快照复制到航次新修订号。

> 从早期“约束不随修订号留痕”的版本升级时，`src/schema.sql` 启动会幂等地把旧的 `column_weight_limits` / `incompat_rules`（当时全局且不可变）回填为每个历史修订号的快照，再删除旧表；新库不受影响。
