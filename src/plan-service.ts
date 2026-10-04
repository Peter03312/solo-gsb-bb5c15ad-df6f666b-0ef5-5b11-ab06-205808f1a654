import { Pool, PoolClient } from 'pg';
import { HttpError } from './errors';
import {
  BoxInfo,
  Geometry,
  Move,
  Placement,
  Position,
  RequestIssue,
  Violation,
  checkMoves,
  columnKey,
  microToWeight,
  ruleKey,
  validateLayout,
} from './domain';

/* ---------- DTO ---------- */

export interface CreatePlanInput {
  /** 方案备注名（可空，仅用于区分同一航次下的多个试排方案） */
  label: string | null;
}

export interface PlanMovesInput {
  /** 调度员所见的方案修订号（方案内乐观并发，与航次修订号序列独立） */
  baseRevision: number;
  moves: Move[];
}

interface PlanRow {
  id: string;
  voyage_id: string;
  label: string | null;
  source_rev: number;
  rev: number;
  status: 'open' | 'published';
  created_at: Date;
  published_at: Date | null;
  published_rev: number | null;
}

interface VoyageRow {
  id: string;
  voyage_no: string;
  n_bays: number;
  n_rows: number;
  n_tiers: number;
  rev: number;
}

/** 方案创建时固定的约束快照（方案存续期间不变） */
interface PlanConstraints {
  defaultLimit: bigint;
  columnLimits: Map<string, bigint>;
  rules: Map<string, number>;
}

/* ---------- 读取辅助 ---------- */

const PLAN_COLS = `id, voyage_id, label, source_rev, rev, status, created_at, published_at, published_rev`;

async function loadPlanRow(
  client: PoolClient,
  planId: string,
  forUpdate: boolean,
): Promise<PlanRow | null> {
  const res = await client.query(
    `SELECT ${PLAN_COLS} FROM stowage_plans WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [planId],
  );
  return (res.rows[0] as PlanRow | undefined) ?? null;
}

async function loadVoyageRow(
  client: PoolClient,
  voyageId: string,
  forUpdate: boolean,
): Promise<VoyageRow | null> {
  const res = await client.query(
    `SELECT id, voyage_no, n_bays, n_rows, n_tiers, rev
     FROM voyages WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [voyageId],
  );
  return (res.rows[0] as VoyageRow | undefined) ?? null;
}

/** 箱档案（登记后不可变更，方案与正式航次共用同一份） */
async function loadBoxes(client: PoolClient, voyageId: string): Promise<BoxInfo[]> {
  const res = await client.query(
    `SELECT box_no, weight_ug::text AS weight_ug, category FROM boxes WHERE voyage_id=$1 ORDER BY box_no`,
    [voyageId],
  );
  return res.rows.map((r) => ({
    boxNo: r.box_no as string,
    weight: microToWeight(BigInt(r.weight_ug as string)),
    category: r.category as string,
  }));
}

async function loadPlanConstraints(client: PoolClient, planId: string): Promise<PlanConstraints> {
  const [defRes, limitRes, ruleRes] = await Promise.all([
    client.query(
      `SELECT weight_limit::text AS weight_limit FROM plan_constraint_defaults WHERE plan_id=$1`,
      [planId],
    ),
    client.query(
      `SELECT bay, row, weight_limit::text AS weight_limit
       FROM plan_constraint_column_limits WHERE plan_id=$1 ORDER BY bay,row`,
      [planId],
    ),
    client.query(
      `SELECT cat_a, cat_b, min_distance
       FROM plan_constraint_incompat_rules WHERE plan_id=$1 ORDER BY cat_a,cat_b`,
      [planId],
    ),
  ]);

  const defRow = defRes.rows[0];
  if (!defRow) {
    throw new Error(`试排方案 ${planId} 缺少约束快照（数据不一致）`);
  }
  const columnLimits = new Map<string, bigint>();
  for (const r of limitRes.rows) {
    columnLimits.set(columnKey(r.bay as number, r.row as number), BigInt(r.weight_limit as string));
  }
  const rules = new Map<string, number>();
  for (const r of ruleRes.rows) {
    rules.set(ruleKey(r.cat_a as string, r.cat_b as string), Number(r.min_distance));
  }
  return { defaultLimit: BigInt(defRow.weight_limit as string), columnLimits, rules };
}

async function loadPlanPlacements(
  client: PoolClient,
  planId: string,
  rev: number,
): Promise<Placement[]> {
  const res = await client.query(
    `SELECT box_no, bay, row, tier FROM plan_placements WHERE plan_id=$1 AND rev=$2 ORDER BY box_no`,
    [planId, rev],
  );
  return res.rows.map((r) => ({
    boxNo: r.box_no as string,
    position: { bay: r.bay, row: r.row, tier: r.tier } as Position,
  }));
}

interface PlanData {
  geometry: Geometry;
  boxes: BoxInfo[];
  constraints: PlanConstraints;
  placements: Placement[];
}

async function loadPlanData(client: PoolClient, plan: PlanRow, v: VoyageRow): Promise<PlanData> {
  const [boxes, constraints, placements] = await Promise.all([
    loadBoxes(client, plan.voyage_id),
    loadPlanConstraints(client, plan.id),
    loadPlanPlacements(client, plan.id, plan.rev),
  ]);
  return {
    geometry: { bays: v.n_bays, rows: v.n_rows, tiers: v.n_tiers },
    boxes,
    constraints,
    placements,
  };
}

/* ---------- 服务 ---------- */

/**
 * 试排方案：从航次当前修订号派生的相互独立的试排工作区。
 *  - 建立：以创建时布局为初值、固定当时约束快照，记录来源修订号与独立的方案修订号；
 *  - 调整：方案内整批调整沿用正式航次的箱号/坐标/最终布局校验规则，按方案修订号防并发覆盖；
 *  - 发布：仅当航次当前修订号仍等于方案来源修订号，才把方案布局原子写入航次新修订号并继承方案约束；
 *  - 正式航次、清单与核对作业不感知试排方案的存在。
 */
export class PlanService {
  constructor(private readonly pool: Pool) {}

  /** 方案完整视图：当前试排布局 + 固定约束 + 版本信息 */
  private serializePlan(plan: PlanRow, data: PlanData) {
    const placedBoxNos = new Set(data.placements.map((p) => p.boxNo));
    return {
      planId: plan.id,
      voyageId: plan.voyage_id,
      label: plan.label,
      status: plan.status,
      sourceRevision: plan.source_rev,
      planRevision: plan.rev,
      createdAt: plan.created_at.toISOString(),
      publishedAt: plan.published_at ? plan.published_at.toISOString() : null,
      publishedRevision: plan.published_rev,
      geometry: data.geometry,
      defaultColumnWeightLimit: microToWeight(data.constraints.defaultLimit),
      columnWeightLimits: [...data.constraints.columnLimits.entries()].map(([key, limit]) => {
        const [bay, row] = key.split('/').map(Number);
        return { bay, row, weightLimit: microToWeight(limit) };
      }),
      incompatRules: [...data.constraints.rules.entries()].map(([key, minDistance]) => {
        const [categoryA, categoryB] = key.split('|');
        return { categoryA, categoryB, minDistance };
      }),
      boxes: data.boxes,
      placements: data.placements
        .map((p) => ({ boxNo: p.boxNo, position: p.position }))
        .sort((a, b) => a.boxNo.localeCompare(b.boxNo)),
      unplacedBoxNos: data.boxes
        .filter((b) => !placedBoxNos.has(b.boxNo))
        .map((b) => b.boxNo),
    };
  }

  /** 发布结果中的航次布局视图（与 GET /layout 同构；current 按查询时航次修订号动态计算） */
  private serializeVoyageLayout(v: VoyageRow, rev: number, data: PlanData) {
    const placedBoxNos = new Set(data.placements.map((p) => p.boxNo));
    return {
      voyageId: v.id,
      voyageNo: v.voyage_no,
      revision: rev,
      current: rev === v.rev,
      geometry: data.geometry,
      defaultColumnWeightLimit: microToWeight(data.constraints.defaultLimit),
      columnWeightLimits: [...data.constraints.columnLimits.entries()].map(([key, limit]) => {
        const [bay, row] = key.split('/').map(Number);
        return { bay, row, weightLimit: microToWeight(limit) };
      }),
      boxes: data.boxes,
      incompatRules: [...data.constraints.rules.entries()].map(([key, minDistance]) => {
        const [categoryA, categoryB] = key.split('|');
        return { categoryA, categoryB, minDistance };
      }),
      placements: data.placements
        .map((p) => ({ boxNo: p.boxNo, position: p.position }))
        .sort((a, b) => a.boxNo.localeCompare(b.boxNo)),
      unplacedBoxNos: data.boxes
        .filter((b) => !placedBoxNos.has(b.boxNo))
        .map((b) => b.boxNo),
    };
  }

  /**
   * 从航次当前修订号建立试排方案：
   * 以该修订号布局为初值（方案 rev=0），并把当时生效的整套约束固定为方案快照。
   * 各修订号的布局/约束快照不可变，无需锁定航次行；并发建立互不影响。
   */
  async createPlan(voyageId: string, input: CreatePlanInput) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const v = await loadVoyageRow(client, voyageId, false);
      if (!v) throw HttpError.notFound('voyage_not_found', `航次 ${voyageId} 不存在`);
      const sourceRev = v.rev;

      const planRes = await client.query(
        `INSERT INTO stowage_plans (voyage_id, label, source_rev)
         VALUES ($1, $2, $3)
         RETURNING ${PLAN_COLS}`,
        [voyageId, input.label, sourceRev],
      );
      const plan = planRes.rows[0] as PlanRow;

      // 以创建时布局为初值（方案修订号 0）
      await client.query(
        `INSERT INTO plan_placements (plan_id, rev, box_no, bay, row, tier)
         SELECT $1, 0, box_no, bay, row, tier FROM placements
         WHERE voyage_id=$2 AND rev=$3`,
        [plan.id, voyageId, sourceRev],
      );
      // 固定当时的安全约束快照
      await client.query(
        `INSERT INTO plan_constraint_defaults (plan_id, weight_limit)
         SELECT $1, weight_limit FROM constraint_defaults
         WHERE voyage_id=$2 AND rev=$3`,
        [plan.id, voyageId, sourceRev],
      );
      await client.query(
        `INSERT INTO plan_constraint_column_limits (plan_id, bay, row, weight_limit)
         SELECT $1, bay, row, weight_limit FROM constraint_column_limits
         WHERE voyage_id=$2 AND rev=$3`,
        [plan.id, voyageId, sourceRev],
      );
      await client.query(
        `INSERT INTO plan_constraint_incompat_rules (plan_id, cat_a, cat_b, min_distance)
         SELECT $1, cat_a, cat_b, min_distance FROM constraint_incompat_rules
         WHERE voyage_id=$2 AND rev=$3`,
        [plan.id, voyageId, sourceRev],
      );

      const data = await loadPlanData(client, plan, v);
      await client.query('COMMIT');
      return this.serializePlan(plan, data);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** 航次下的试排方案列表（摘要，不含布局明细） */
  async listPlans(voyageId: string) {
    const check = await this.pool.query(`SELECT 1 FROM voyages WHERE id=$1`, [voyageId]);
    if (check.rows.length === 0) {
      throw HttpError.notFound('voyage_not_found', `航次 ${voyageId} 不存在`);
    }
    const res = await this.pool.query(
      `SELECT ${PLAN_COLS} FROM stowage_plans WHERE voyage_id=$1 ORDER BY created_at DESC, id`,
      [voyageId],
    );
    return {
      plans: (res.rows as PlanRow[]).map((p) => ({
        planId: p.id,
        voyageId: p.voyage_id,
        label: p.label,
        status: p.status,
        sourceRevision: p.source_rev,
        planRevision: p.rev,
        createdAt: p.created_at.toISOString(),
        publishedAt: p.published_at ? p.published_at.toISOString() : null,
        publishedRevision: p.published_rev,
      })),
    };
  }

  /** 查询方案：当前试排布局、固定约束与版本（来源修订号 / 方案修订号 / 状态） */
  async getPlan(planId: string) {
    const client = await this.pool.connect();
    try {
      const plan = await loadPlanRow(client, planId, false);
      if (!plan) throw HttpError.notFound('plan_not_found', `试排方案 ${planId} 不存在`);
      const v = await loadVoyageRow(client, plan.voyage_id, false);
      if (!v) throw HttpError.notFound('voyage_not_found', `航次 ${plan.voyage_id} 不存在`);
      const data = await loadPlanData(client, plan, v);
      return this.serializePlan(plan, data);
    } finally {
      client.release();
    }
  }

  /**
   * 方案内整批调整（与正式航次整批调整同一套语义与校验）：
   *  - 携带所见方案修订号；过期 -> 409 stale_revision（返回方案当前修订号）；
   *  - 请求级错误（未知箱/坐标越界/同批重复箱号）-> 400；最终布局违反配载规则 -> 422；
   *  - 失败不改变方案（事务回滚，方案修订号与布局原样保留）；
   *  - 受理后方案修订号 +1，正式航次不受任何影响；
   *  - 已发布方案只读 -> 409 plan_published。
   */
  async applyMoves(planId: string, input: PlanMovesInput) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const plan = await loadPlanRow(client, planId, true);
      if (!plan) throw HttpError.notFound('plan_not_found', `试排方案 ${planId} 不存在`);
      if (plan.status === 'published') {
        throw HttpError.conflict(
          'plan_published',
          `试排方案已发布（写入航次修订号 ${plan.published_rev}）并转为只读，拒绝继续调整`,
          { planId, publishedRevision: plan.published_rev, publishedAt: plan.published_at },
        );
      }
      if (!Number.isInteger(input.baseRevision) || input.baseRevision < 0) {
        throw HttpError.badRequest('invalid_revision', 'baseRevision 必须为非负整数');
      }
      if (plan.rev !== input.baseRevision) {
        throw new HttpError(
          409,
          'stale_revision',
          `方案修订号已过期：携带的 ${input.baseRevision} 与方案当前修订号 ${plan.rev} 不一致，请重新读取方案后再提交`,
          { expectedRevision: input.baseRevision, currentRevision: plan.rev, planId },
        );
      }

      const v = await loadVoyageRow(client, plan.voyage_id, false);
      if (!v) throw HttpError.notFound('voyage_not_found', `航次 ${plan.voyage_id} 不存在`);
      const data = await loadPlanData(client, plan, v);

      // 请求级错误：未知箱 / 无效坐标 / 同批重复箱号（沿用正式航次同一套检查）
      const knownBoxes = new Set(data.boxes.map((b) => b.boxNo));
      const requestIssues: RequestIssue[] = checkMoves(input.moves, data.geometry, knownBoxes);
      if (requestIssues.length > 0) {
        throw HttpError.invalidRequest(
          'invalid_adjustment',
          '整批调整请求包含非法指令，已拒绝',
          { issueCount: requestIssues.length, issues: requestIssues },
        );
      }

      // 以“最终布局”为基准应用整批指令（撤位=null；未出现的箱保持原位）
      const finalPositions = new Map<string, Position | null>();
      for (const p of data.placements) finalPositions.set(p.boxNo, p.position);
      for (const move of input.moves) {
        if (move.position === null) finalPositions.set(move.boxNo, null);
        else finalPositions.set(move.boxNo, move.position);
      }
      const finalPlacements: Placement[] = [...finalPositions.entries()]
        .filter((entry): entry is [string, Position] => entry[1] !== null)
        .map(([boxNo, position]) => ({ boxNo, position }));

      // 按方案固定的约束快照校验最终布局：任何违反整批拒绝，方案不变
      const violations: Violation[] = validateLayout({
        geometry: data.geometry,
        boxes: data.boxes,
        placements: finalPlacements,
        columnLimits: data.constraints.columnLimits,
        defaultColumnLimit: data.constraints.defaultLimit,
        rules: data.constraints.rules,
      });
      if (violations.length > 0) {
        throw HttpError.validationFailed(violations);
      }

      const nextRev = plan.rev + 1;
      if (finalPlacements.length > 0) {
        const values: string[] = [];
        const params: (string | number)[] = [plan.id, nextRev];
        let i = 3;
        for (const p of finalPlacements) {
          values.push(`($1, $2, $${i++}, $${i++}, $${i++}, $${i++})`);
          params.push(p.boxNo, p.position.bay, p.position.row, p.position.tier);
        }
        await client.query(
          `INSERT INTO plan_placements (plan_id, rev, box_no, bay, row, tier) VALUES ${values.join(',')}`,
          params,
        );
      }
      await client.query(`UPDATE stowage_plans SET rev=$2 WHERE id=$1`, [plan.id, nextRev]);

      await client.query('COMMIT');

      const updatedPlan: PlanRow = { ...plan, rev: nextRev };
      const newData: PlanData = { ...data, placements: finalPlacements };
      return {
        planId: plan.id,
        planRevision: nextRev,
        previousPlanRevision: plan.rev,
        applied: input.moves.length,
        plan: this.serializePlan(updatedPlan, newData),
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 发布方案到正式航次（原子）：
   *  - 仅当航次当前修订号仍等于方案来源修订号才受理：方案布局写入航次新修订号（rev+1），
   *    新修订号继承方案固定的约束快照；同事务把方案置为 published（只读）；
   *  - 航次修订号已偏离来源修订号 -> 409 publish_conflict，方案原样保留（仍为 open，可继续调整）；
   *  - 已发布方案重复发布 -> 幂等返回首次发布结果（不产生新修订号）；
   *  - 历史布局、旧清单与在办核对仍遵循原有冻结语义，不受发布影响。
   */
  async publish(planId: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const plan = await loadPlanRow(client, planId, true);
      if (!plan) throw HttpError.notFound('plan_not_found', `试排方案 ${planId} 不存在`);
      const v = await loadVoyageRow(client, plan.voyage_id, true);
      if (!v) throw HttpError.notFound('voyage_not_found', `航次 ${plan.voyage_id} 不存在`);

      // 重复发布：幂等返回首次发布结果（布局/约束快照不可变，可按原样重建）
      if (plan.status === 'published') {
        const data = await loadPlanData(client, plan, v);
        await client.query('COMMIT');
        return {
          published: true,
          replay: true,
          planId: plan.id,
          voyageId: plan.voyage_id,
          sourceRevision: plan.source_rev,
          planRevision: plan.rev,
          voyageRevision: plan.published_rev,
          publishedAt: plan.published_at ? plan.published_at.toISOString() : null,
          layout: this.serializeVoyageLayout(v, plan.published_rev!, data),
        };
      }

      // 航次当前修订号必须仍等于方案来源修订号，否则报告冲突且保留方案
      if (v.rev !== plan.source_rev) {
        throw HttpError.conflict(
          'publish_conflict',
          `航次当前修订号 ${v.rev} 已偏离方案来源修订号 ${plan.source_rev}，发布冲突；方案保留，可重新读取航次后新建方案或继续调整`,
          {
            planId,
            sourceRevision: plan.source_rev,
            currentRevision: v.rev,
            planRevision: plan.rev,
          },
        );
      }

      const data = await loadPlanData(client, plan, v);

      // 防御性复验（方案布局仅由受控接口产生，正常不会触发）
      const violations: Violation[] = validateLayout({
        geometry: data.geometry,
        boxes: data.boxes,
        placements: data.placements,
        columnLimits: data.constraints.columnLimits,
        defaultColumnLimit: data.constraints.defaultLimit,
        rules: data.constraints.rules,
      });
      if (violations.length > 0) {
        throw HttpError.validationFailed(violations);
      }

      const nextRev = v.rev + 1;

      // 方案布局原子写入航次新修订号
      await client.query(
        `INSERT INTO placements (voyage_id, rev, box_no, bay, row, tier)
         SELECT $1, $2, box_no, bay, row, tier FROM plan_placements
         WHERE plan_id=$3 AND rev=$4`,
        [v.id, nextRev, plan.id, plan.rev],
      );
      // 新修订号继承方案固定的约束快照
      await client.query(
        `INSERT INTO constraint_defaults (voyage_id, rev, weight_limit)
         SELECT $1, $2, weight_limit FROM plan_constraint_defaults WHERE plan_id=$3`,
        [v.id, nextRev, plan.id],
      );
      await client.query(
        `INSERT INTO constraint_column_limits (voyage_id, rev, bay, row, weight_limit)
         SELECT $1, $2, bay, row, weight_limit FROM plan_constraint_column_limits WHERE plan_id=$3`,
        [v.id, nextRev, plan.id],
      );
      await client.query(
        `INSERT INTO constraint_incompat_rules (voyage_id, rev, cat_a, cat_b, min_distance)
         SELECT $1, $2, cat_a, cat_b, min_distance FROM plan_constraint_incompat_rules WHERE plan_id=$3`,
        [v.id, nextRev, plan.id],
      );

      // 航次修订号 +1；当前默认列承重冗余列与快照保持同步（值与来源修订号一致）
      await client.query(`UPDATE voyages SET rev=$2, default_column_limit=$3 WHERE id=$1`, [
        v.id,
        nextRev,
        data.constraints.defaultLimit.toString(),
      ]);

      // 方案转为只读，记录发布结果供幂等重放
      const published = await client.query(
        `UPDATE stowage_plans SET status='published', published_at=now(), published_rev=$2
         WHERE id=$1 RETURNING ${PLAN_COLS}`,
        [plan.id, nextRev],
      );
      const publishedPlan = published.rows[0] as PlanRow;

      await client.query('COMMIT');
      return {
        published: true,
        replay: false,
        planId: plan.id,
        voyageId: plan.voyage_id,
        sourceRevision: plan.source_rev,
        planRevision: plan.rev,
        voyageRevision: nextRev,
        publishedAt: publishedPlan.published_at ? publishedPlan.published_at.toISOString() : null,
        layout: this.serializeVoyageLayout({ ...v, rev: nextRev }, nextRev, data),
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
