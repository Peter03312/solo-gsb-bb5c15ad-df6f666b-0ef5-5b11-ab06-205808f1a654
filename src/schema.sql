-- 船舶危险货箱配载审定服务 初始化结构
-- 幂等：可重复执行
--
-- 航次安全约束（默认列承重、按列覆盖限额、不相容类别对）随修订号演进：
-- 每个修订号 rev 都有一份独立的约束快照，与该修订号的布局（placements）对应。
-- 布局调整（moves）继承当前约束快照；安全约束变更（constraints）继承当前布局，
-- 并把新约束复制到新修订号。历史布局查询因此总能展示当时生效的约束。
-- 舱位尺寸（n_bays/n_rows/n_tiers）与箱档案（boxes）不可变更。

CREATE TABLE IF NOT EXISTS voyages (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    voyage_no            TEXT NOT NULL UNIQUE,
    n_bays               INTEGER NOT NULL CHECK (n_bays > 0),
    n_rows               INTEGER NOT NULL CHECK (n_rows > 0),
    n_tiers              INTEGER NOT NULL CHECK (n_tiers > 0),
    -- 当前修订号生效的默认列承重（与 constraint_defaults 当前行保持同步，冗余以便列表查询）
    default_column_limit BIGINT NOT NULL CHECK (default_column_limit > 0), -- 微千克 (1kg = 1e6)
    rev                  INTEGER NOT NULL DEFAULT 0 CHECK (rev >= 0),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 箱档案：登记后不可变更（箱号、重量、类别）
CREATE TABLE IF NOT EXISTS boxes (
    voyage_id  UUID NOT NULL REFERENCES voyages(id) ON DELETE CASCADE,
    box_no     TEXT NOT NULL,
    weight_ug  BIGINT NOT NULL CHECK (weight_ug > 0), -- 微千克
    category   TEXT NOT NULL,
    PRIMARY KEY (voyage_id, box_no)
);

-- 每个修订号的默认列承重快照（每修订号一行）
CREATE TABLE IF NOT EXISTS constraint_defaults (
    voyage_id    UUID NOT NULL REFERENCES voyages(id) ON DELETE CASCADE,
    rev          INTEGER NOT NULL CHECK (rev >= 0),
    weight_limit BIGINT NOT NULL CHECK (weight_limit > 0), -- 微千克
    PRIMARY KEY (voyage_id, rev)
);

-- 每个修订号的按列承重覆盖快照（bay+row 维度的“列”）；未列出的列回退到该修订号默认上限
CREATE TABLE IF NOT EXISTS constraint_column_limits (
    voyage_id    UUID NOT NULL REFERENCES voyages(id) ON DELETE CASCADE,
    rev          INTEGER NOT NULL CHECK (rev >= 0),
    bay          INTEGER NOT NULL CHECK (bay >= 1),
    row          INTEGER NOT NULL CHECK (row >= 1),
    weight_limit BIGINT NOT NULL CHECK (weight_limit > 0), -- 微千克
    PRIMARY KEY (voyage_id, rev, bay, row)
);

-- 每个修订号的不相容类别对快照 -> 正整数最小曼哈顿距离（未登记的类别对视为相容）
CREATE TABLE IF NOT EXISTS constraint_incompat_rules (
    voyage_id    UUID NOT NULL REFERENCES voyages(id) ON DELETE CASCADE,
    rev          INTEGER NOT NULL CHECK (rev >= 0),
    cat_a        TEXT NOT NULL,
    cat_b        TEXT NOT NULL,
    min_distance INTEGER NOT NULL CHECK (min_distance > 0),
    PRIMARY KEY (voyage_id, rev, cat_a, cat_b),
    CHECK (cat_a <= cat_b)
);

-- 配载布局按修订号全量留痕：每接受一批调整即产生一个新修订号，
-- 该修订号下的布局由 placements 中 (voyage_id, rev) 的所有行完整表示。
CREATE TABLE IF NOT EXISTS placements (
    voyage_id UUID NOT NULL REFERENCES voyages(id) ON DELETE CASCADE,
    rev       INTEGER NOT NULL CHECK (rev >= 0),
    box_no    TEXT NOT NULL,
    bay       INTEGER NOT NULL CHECK (bay >= 1),
    row       INTEGER NOT NULL CHECK (row >= 1),
    tier      INTEGER NOT NULL CHECK (tier >= 0),
    PRIMARY KEY (voyage_id, rev, box_no),
    UNIQUE (voyage_id, rev, bay, row, tier)
);
CREATE INDEX IF NOT EXISTS idx_placements_rev ON placements (voyage_id, rev);

-- 装载清单（签发后内容冻结到该修订号的布局；空布局亦可签发，但要求所有箱已配位）
CREATE TABLE IF NOT EXISTS manifests (
    voyage_id  UUID NOT NULL REFERENCES voyages(id) ON DELETE CASCADE,
    rev        INTEGER NOT NULL CHECK (rev >= 0),
    issued_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    box_count  INTEGER NOT NULL CHECK (box_count >= 0),
    PRIMARY KEY (voyage_id, rev)
);

CREATE TABLE IF NOT EXISTS manifest_items (
    voyage_id UUID NOT NULL,
    rev       INTEGER NOT NULL,
    box_no    TEXT NOT NULL,
    bay       INTEGER NOT NULL,
    row       INTEGER NOT NULL,
    tier      INTEGER NOT NULL,
    PRIMARY KEY (voyage_id, rev, box_no),
    FOREIGN KEY (voyage_id, rev) REFERENCES manifests (voyage_id, rev) ON DELETE CASCADE
);

-- 现场装船核对作业：以航次某修订号的【已签发冻结清单】为核对基准开启，
-- 同一清单最多一个作业（voyage_id+manifest_rev 唯一）。
-- 基准引用冻结副本（manifest_items），后续布局调整/约束变更/新清单不改变既有作业基准。
CREATE TABLE IF NOT EXISTS check_jobs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    voyage_id    UUID NOT NULL,
    manifest_rev INTEGER NOT NULL CHECK (manifest_rev >= 0),
    status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    opened_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at    TIMESTAMPTZ,
    -- 作业内上报顺序号（同作业互斥递增；也用于“每箱最后一条上报”判定）
    next_seq     BIGINT NOT NULL DEFAULT 0 CHECK (next_seq >= 0),
    UNIQUE (voyage_id, manifest_rev),
    FOREIGN KEY (voyage_id, manifest_rev)
        REFERENCES manifests (voyage_id, rev) ON DELETE CASCADE
);

-- 核对上报留痕：每次受理的上报均永久保存；(job_id, report_no) 唯一保证上报号幂等。
-- revoked=true（撤销）等价于“未装”，此时坐标必须为空；否则三维坐标必填。
CREATE TABLE IF NOT EXISTS check_reports (
    job_id      UUID NOT NULL REFERENCES check_jobs(id) ON DELETE CASCADE,
    report_no   TEXT NOT NULL,
    seq         BIGINT NOT NULL CHECK (seq > 0),
    box_no      TEXT NOT NULL,
    revoked     BOOLEAN NOT NULL,
    bay         INTEGER,
    row         INTEGER,
    tier        INTEGER,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (job_id, report_no),
    UNIQUE (job_id, seq),
    CHECK (revoked OR (bay IS NOT NULL AND row IS NOT NULL AND tier IS NOT NULL)),
    CHECK (NOT revoked OR (bay IS NULL AND row IS NULL AND tier IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_check_reports_box ON check_reports (job_id, box_no, seq);

-- ---- 试排方案（调度员试排工作区）----
-- 从航次当前修订号派生的相互独立的试排方案：以创建时布局为初值、固定当时约束快照，
-- 记录来源修订号 source_rev 与独立的方案修订号 rev（方案内乐观并发）。
-- 方案内的整批调整只写 plan_placements，不触碰正式航次；发布时才原子写回航次新修订号。
CREATE TABLE IF NOT EXISTS stowage_plans (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    voyage_id     UUID NOT NULL REFERENCES voyages(id) ON DELETE CASCADE,
    label         TEXT,
    -- 来源修订号：创建时航次的当前修订号（发布时据此判定冲突）
    source_rev    INTEGER NOT NULL CHECK (source_rev >= 0),
    -- 方案修订号：方案内每接受一批调整 +1，与航次修订号序列相互独立
    rev           INTEGER NOT NULL DEFAULT 0 CHECK (rev >= 0),
    status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'published')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at  TIMESTAMPTZ,
    -- 发布成功时写入的航次新修订号（重复发布据此幂等返回首次结果）
    published_rev INTEGER CHECK (published_rev >= 0)
);
CREATE INDEX IF NOT EXISTS idx_stowage_plans_voyage ON stowage_plans (voyage_id, created_at);

-- 方案布局按方案修订号全量留痕（与 placements 同构；每接受一批方案内调整产生一个方案修订号）
CREATE TABLE IF NOT EXISTS plan_placements (
    plan_id UUID NOT NULL REFERENCES stowage_plans(id) ON DELETE CASCADE,
    rev     INTEGER NOT NULL CHECK (rev >= 0),
    box_no  TEXT NOT NULL,
    bay     INTEGER NOT NULL CHECK (bay >= 1),
    row     INTEGER NOT NULL CHECK (row >= 1),
    tier    INTEGER NOT NULL CHECK (tier >= 0),
    PRIMARY KEY (plan_id, rev, box_no),
    UNIQUE (plan_id, rev, bay, row, tier)
);
CREATE INDEX IF NOT EXISTS idx_plan_placements_rev ON plan_placements (plan_id, rev);

-- 方案创建时固定的安全约束快照（默认列承重 / 按列覆盖 / 不相容类别对）：
-- 复制自来源修订号，方案存续期间不变；方案内调整与发布复验均使用这套约束。
CREATE TABLE IF NOT EXISTS plan_constraint_defaults (
    plan_id      UUID PRIMARY KEY REFERENCES stowage_plans(id) ON DELETE CASCADE,
    weight_limit BIGINT NOT NULL CHECK (weight_limit > 0) -- 微千克
);

CREATE TABLE IF NOT EXISTS plan_constraint_column_limits (
    plan_id      UUID NOT NULL REFERENCES stowage_plans(id) ON DELETE CASCADE,
    bay          INTEGER NOT NULL CHECK (bay >= 1),
    row          INTEGER NOT NULL CHECK (row >= 1),
    weight_limit BIGINT NOT NULL CHECK (weight_limit > 0), -- 微千克
    PRIMARY KEY (plan_id, bay, row)
);

CREATE TABLE IF NOT EXISTS plan_constraint_incompat_rules (
    plan_id      UUID NOT NULL REFERENCES stowage_plans(id) ON DELETE CASCADE,
    cat_a        TEXT NOT NULL,
    cat_b        TEXT NOT NULL,
    min_distance INTEGER NOT NULL CHECK (min_distance > 0),
    PRIMARY KEY (plan_id, cat_a, cat_b),
    CHECK (cat_a <= cat_b)
);

-- ---- 从“约束不随修订号留痕”的旧结构一次性升级（仅在遗留表存在时执行）----
-- 旧表：column_weight_limits、incompat_rules（约束登记后全局且不可变，故每个历史修订号生效同一套）。
-- 为每个航次的每个修订号 0..rev 回填约束快照后删除旧表；新库无此二表，整段跳过。
DO $$
DECLARE
    has_legacy boolean := to_regclass('public.column_weight_limits') IS NOT NULL
                       OR to_regclass('public.incompat_rules') IS NOT NULL;
BEGIN
    IF has_legacy THEN
        -- 默认列承重：每个修订号都取航次当前（也是历史唯一）默认上限
        INSERT INTO constraint_defaults (voyage_id, rev, weight_limit)
        SELECT v.id, g.rev, v.default_column_limit
        FROM voyages v
        CROSS JOIN LATERAL generate_series(0, v.rev) AS g(rev)
        ON CONFLICT DO NOTHING;

        IF to_regclass('public.column_weight_limits') IS NOT NULL THEN
            INSERT INTO constraint_column_limits (voyage_id, rev, bay, row, weight_limit)
            SELECT c.voyage_id, g.rev, c.bay, c.row, c.weight_limit
            FROM column_weight_limits c
            JOIN voyages v ON v.id = c.voyage_id
            CROSS JOIN LATERAL generate_series(0, v.rev) AS g(rev)
            ON CONFLICT DO NOTHING;
        END IF;

        IF to_regclass('public.incompat_rules') IS NOT NULL THEN
            INSERT INTO constraint_incompat_rules (voyage_id, rev, cat_a, cat_b, min_distance)
            SELECT r.voyage_id, g.rev, r.cat_a, r.cat_b, r.min_distance
            FROM incompat_rules r
            JOIN voyages v ON v.id = r.voyage_id
            CROSS JOIN LATERAL generate_series(0, v.rev) AS g(rev)
            ON CONFLICT DO NOTHING;
        END IF;

        DROP TABLE public.column_weight_limits;
        DROP TABLE public.incompat_rules;
    END IF;
END $$;
