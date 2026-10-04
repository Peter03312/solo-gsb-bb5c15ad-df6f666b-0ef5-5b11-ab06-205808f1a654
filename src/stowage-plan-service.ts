import { Pool, PoolClient } from 'pg';
import { HttpError } from './errors';
import {
  Move,
  Placement,
  Position,
  RequestIssue,
  Violation,
  checkMoves,
  validateLayout,
} from './domain';
import {
  LoadedVoyageData,
  VoyageRow,
  VoyageService,
  buildLayoutFields,
  loadBoxes,
  loadConstraints,
  loadVoyageRow,
} from './service';

/* ---------- DTO ---------- */

export interface CreateStowagePlanInput {
  /**
   * 调度员所见的航次修订号。缺省即取航次当前修订号；显式给出且与当前不一致时
   * 409 stale_revision（方案只能从“当前修订号”fork）。
   */
  baseRevision?: number;
}

export interface ApplyPlanMovesInput {
  /** 调度员所见的方案修订号（planRevision） */
  baseRevision: number;
  moves: Move[];
}

type PlanStatus = 'draft' | 'published';

interface StowagePlanRow {
  id: string;
  voyage_id: string;
  source_rev: number;
  plan_rev: number;
  status: PlanStatus;
  published_voyage_rev: number | null;
  created_at: Date;
  published_at: Date | null;
}

/* ---------- 读取辅助 ---------- */

async function loadPlan(
  client: PoolClient,
  planId: string,
  forUpdate: boolean,
): Promise<StowagePlanRow | null> {
  const res = await client.query(
    `SELECT id, voyage_id, source_rev, plan_rev, status,
            published_voyage_rev, created_at, published_at
     FROM stowage_plans WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [planId],
  );
  return (res.rows[0] as StowagePlanRow | undefined) ?? null;
}

async function loadPlanPlacements(client: PoolClient, planId: string): Promise<Placement[]> {
  const res = await client.query(
    `SELECT box_no, bay, row, tier FROM stowage_plan_placements WHERE plan_id=$1 ORDER BY box_no`,
    [planId],
  );
  return res.rows.map(
    (r): Placement => ({
      boxNo: r.box_no as string,
      position: { bay: r.bay, row: r.row, tier: r.tier } as Position,
    }),
  );
}

/** 组装方案沙箱的完整视图：舱位/箱档案 + 来源修订号约束快照 + 方案当前布局 */
async function loadPlanData(
  client: PoolClient,
  v: VoyageRow,
  plan: StowagePlanRow,
): Promise<LoadedVoyageData> {
  const [boxes, constraints, placements] = await Promise.all([
    loadBoxes(client, v.id),
    loadConstraints(client, v.id, plan.source_rev),
    loadPlanPlacements(client, plan.id),
  ]);
  return {
    geometry: { bays: v.n_bays, rows: v.n_rows, tiers: v.n_tiers },
    boxes,
    constraints,
    placements,
  };
}

/* ---------- 服务 ---------- */

export class StowagePlanService {
  private readonly voyageService: VoyageService;

  constructor(private readonly pool: Pool) {
    this.voyageService = new VoyageService(pool);
  }

  /**
   * 从航次当前修订号建立试排方案：
   *  - 以创建时的布局为初值（复制当前 placements 到方案沙箱）；
   *  - 固定当时的安全约束快照（之后按 source_rev 引用既有不可变约束快照）；
   *  - 记录来源修订号 source_rev 与独立的方案修订号 plan_rev（初始 0）。
   * 多个方案相互独立，且不触碰正式航次修订号、清单与核对作业。
   */
  async createPlan(voyageId: string, input: CreateStowagePlanInput) {
    if (
      input.baseRevision !== undefined &&
      (!Number.isInteger(input.baseRevision) || input.baseRevision < 0)
    ) {
      throw HttpError.badRequest('invalid_revision', 'baseRevision 必须为非负整数');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const v = await loadVoyageRow(client, voyageId, true);
      if (!v) {
        throw HttpError.notFound('voyage_not_found', `航次 ${voyageId} 不存在`);
      }
      if (input.baseRevision !== undefined && input.baseRevision !== v.rev) {
        throw HttpError.staleRevision(v.rev, input.baseRevision);
      }

      const inserted = await client.query(
        `INSERT INTO stowage_plans (voyage_id, source_rev, plan_rev, status)
         VALUES ($1, $2, 0, 'draft')
         RETURNING id, voyage_id, source_rev, plan_rev, status,
                   published_voyage_rev, created_at, published_at`,
        [v.id, v.rev],
      );
      const plan = inserted.rows[0] as StowagePlanRow;

      // 以创建时的布局为初值
      await client.query(
        `INSERT INTO stowage_plan_placements (plan_id, box_no, bay, row, tier)
         SELECT $2, box_no, bay, row, tier FROM placements
         WHERE voyage_id=$1 AND rev=$3`,
        [v.id, plan.id, v.rev],
      );

      const data = await loadPlanData(client, v, plan);
      await client.query('COMMIT');
      return { plan: this.serializePlan(plan, data, v.rev) };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 方案内整批调整：沿用既有箱号/坐标/最终布局五项校验规则，但
   *  - 乐观并发按【方案修订号 plan_rev】判定（与航次修订号互不影响）；
   *  - 校验使用创建时固定的安全约束快照（source_rev 约束）；
   *  - 请求级错误 / 规则违反 / 修订号过期全部回滚，方案布局与 plan_rev 不变。
   */
  async applyMoves(planId: string, input: ApplyPlanMovesInput) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const plan = await loadPlan(client, planId, true);
      if (!plan) {
        throw HttpError.notFound('stowage_plan_not_found', `试排方案 ${planId} 不存在`);
      }
      if (plan.status === 'published') {
        throw HttpError.conflict(
          'plan_readonly',
          `试排方案已发布（写入正式修订号 ${plan.published_voyage_rev}），方案只读，不能再调整`,
          { planId, publishedVoyageRevision: plan.published_voyage_rev },
        );
      }
      if (!Number.isInteger(input.baseRevision) || input.baseRevision < 0) {
        throw HttpError.badRequest('invalid_revision', 'baseRevision 必须为非负整数');
      }
      if (plan.plan_rev !== input.baseRevision) {
        throw HttpError.stalePlanRevision(plan.plan_rev, input.baseRevision);
      }

      const v = await loadVoyageRow(client, plan.voyage_id, false);
      if (!v) {
        throw HttpError.notFound('voyage_not_found', `航次 ${plan.voyage_id} 不存在`);
      }
      const data = await loadPlanData(client, v, plan);

      // 请求级错误：未知箱 / 无效坐标 / 同批重复箱号（与正式整批调整一致）
      const knownBoxes = new Set(data.boxes.map((b) => b.boxNo));
      const requestIssues: RequestIssue[] = checkMoves(input.moves, data.geometry, knownBoxes);
      if (requestIssues.length > 0) {
        throw HttpError.invalidRequest(
          'invalid_adjustment',
          '试排方案整批调整请求包含非法指令，已拒绝',
          { issueCount: requestIssues.length, issues: requestIssues },
        );
      }

      // 最终布局（撤位=null；未出现的箱保持方案当前位置）
      const finalPositions = new Map<string, Position | null>();
      for (const p of data.placements) finalPositions.set(p.boxNo, p.position);
      for (const move of input.moves) {
        if (move.position === null) finalPositions.set(move.boxNo, null);
        else finalPositions.set(move.boxNo, move.position);
      }
      const finalPlacements: Placement[] = [...finalPositions.entries()]
        .filter((entry): entry is [string, Position] => entry[1] !== null)
        .map(([boxNo, position]) => ({ boxNo, position }));

      // 规则校验使用方案固定的来源修订号约束：任何违反整批拒绝（方案不变）
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

      // 整批替换方案当前布局（先全部删除再写入，同一事务内完成）
      await client.query(`DELETE FROM stowage_plan_placements WHERE plan_id=$1`, [plan.id]);
      if (finalPlacements.length > 0) {
        const values: string[] = [];
        const params: (string | number)[] = [plan.id];
        let i = 2;
        for (const p of finalPlacements) {
          values.push(`($1, $${i++}, $${i++}, $${i++}, $${i++})`);
          params.push(p.boxNo, p.position.bay, p.position.row, p.position.tier);
        }
        await client.query(
          `INSERT INTO stowage_plan_placements (plan_id, box_no, bay, row, tier)
           VALUES ${values.join(',')}`,
          params,
        );
      }
      const nextPlanRev = plan.plan_rev + 1;
      await client.query(`UPDATE stowage_plans SET plan_rev=$2 WHERE id=$1`, [
        plan.id,
        nextPlanRev,
      ]);

      const updatedPlan: StowagePlanRow = { ...plan, plan_rev: nextPlanRev };
      const newData: LoadedVoyageData = { ...data, placements: finalPlacements };
      await client.query('COMMIT');
      return {
        planRevision: nextPlanRev,
        previousPlanRevision: plan.plan_rev,
        applied: input.moves.length,
        plan: this.serializePlan(updatedPlan, newData, v.rev),
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** 查询方案：返回当前试排布局、创建时固定的约束以及全部版本信息 */
  async getPlan(planId: string) {
    const client = await this.pool.connect();
    try {
      const plan = await loadPlan(client, planId, false);
      if (!plan) {
        throw HttpError.notFound('stowage_plan_not_found', `试排方案 ${planId} 不存在`);
      }
      const v = await loadVoyageRow(client, plan.voyage_id, false);
      if (!v) {
        throw HttpError.notFound('voyage_not_found', `航次 ${plan.voyage_id} 不存在`);
      }
      const data = await loadPlanData(client, v, plan);
      return { plan: this.serializePlan(plan, data, v.rev) };
    } finally {
      client.release();
    }
  }

  /** 列出航次下全部试排方案（含方案当前修订号与发布状态；不含布局明细） */
  async listPlans(voyageId: string) {
    const client = await this.pool.connect();
    try {
      const exists = await client.query(`SELECT 1 FROM voyages WHERE id=$1`, [voyageId]);
      if (exists.rows.length === 0) {
        throw HttpError.notFound('voyage_not_found', `航次 ${voyageId} 不存在`);
      }
      const res = await client.query(
        `SELECT p.id, p.voyage_id, p.source_rev, p.plan_rev, p.status,
                p.published_voyage_rev, p.created_at, p.published_at,
                v.rev AS voyage_rev,
                (SELECT count(*) FROM stowage_plan_placements sp WHERE sp.plan_id = p.id) AS placed_count
         FROM stowage_plans p JOIN voyages v ON v.id = p.voyage_id
         WHERE p.voyage_id=$1
         ORDER BY p.created_at DESC, p.id DESC`,
        [voyageId],
      );
      return {
        plans: res.rows.map((r) => ({
          planId: r.id as string,
          voyageId: r.voyage_id as string,
          sourceRevision: Number(r.source_rev),
          planRevision: Number(r.plan_rev),
          status: r.status as PlanStatus,
          published: r.status === 'published',
          publishedVoyageRevision:
            r.published_voyage_rev === null ? null : Number(r.published_voyage_rev),
          voyageCurrentRevision: Number(r.voyage_rev),
          sourceCurrent: Number(r.source_rev) === Number(r.voyage_rev),
          placedCount: Number(r.placed_count),
          createdAt: (r.created_at as Date).toISOString(),
          publishedAt: r.published_at ? (r.published_at as Date).toISOString() : null,
        })),
      };
    } finally {
      client.release();
    }
  }

  /**
   * 发布试排方案到正式航次：
   *  - 仅当航次当前修订号仍等于方案来源修订号时可发布；否则 409 plan_publish_conflict，方案保留；
   *  - 原子地把方案布局写入航次新修订号（placements），并继承来源修订号的约束快照；
   *  - 发布成功后方案只读；重复发布幂等，返回首次发布结果（replay:true）。
   * 历史布局、旧清单与在办核对继续遵循各自的既有冻结语义。
   */
  async publishPlan(planId: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 先锁方案行（固定加锁顺序：方案 -> 航次，避免并发发布死锁）
      const plan = await loadPlan(client, planId, true);
      if (!plan) {
        throw HttpError.notFound('stowage_plan_not_found', `试排方案 ${planId} 不存在`);
      }

      // 重复发布：返回首次发布结果（幂等，不产生新修订号）
      if (plan.status === 'published') {
        const v = await loadVoyageRow(client, plan.voyage_id, false);
        if (!v) {
          throw HttpError.notFound('voyage_not_found', `航次 ${plan.voyage_id} 不存在`);
        }
        const data = await loadPlanData(client, v, plan);
        await client.query('COMMIT');
        return {
          replay: true,
          voyageRevision: plan.published_voyage_rev!,
          sourceRevision: plan.source_rev,
          planRevision: plan.plan_rev,
          plan: this.serializePlan(plan, data, v.rev),
        };
      }

      const v = await loadVoyageRow(client, plan.voyage_id, true);
      if (!v) {
        throw HttpError.notFound('voyage_not_found', `航次 ${plan.voyage_id} 不存在`);
      }

      if (v.rev !== plan.source_rev) {
        // 航次已自来源修订号继续演进：报告冲突并保留方案（仍可继续调整或放弃）
        throw HttpError.conflict(
          'plan_publish_conflict',
          `试排方案来源修订号为 ${plan.source_rev}，航次当前修订号已为 ${v.rev}，发布可能覆盖正式调整，已拒绝；方案已保留`,
          {
            planId,
            sourceRevision: plan.source_rev,
            currentRevision: v.rev,
            planRevision: plan.plan_rev,
          },
        );
      }

      const data = await loadPlanData(client, v, plan);

      // 防御性复验：沙箱写入受控，正常不会触发；发布为正式布局前再做一次最终校验。
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
      if (data.placements.length > 0) {
        const values: string[] = [];
        const params: (string | number)[] = [v.id, nextRev];
        let i = 3;
        for (const p of data.placements) {
          values.push(`($1, $2, $${i++}, $${i++}, $${i++}, $${i++})`);
          params.push(p.boxNo, p.position.bay, p.position.row, p.position.tier);
        }
        await client.query(
          `INSERT INTO placements (voyage_id, rev, box_no, bay, row, tier) VALUES ${values.join(',')}`,
          params,
        );
      }
      // 继承来源修订号当时生效的约束快照（正式航次新修订号与方案固定约束一致）
      await this.voyageService.copyConstraintSnapshot(client, v.id, plan.source_rev, nextRev);
      await client.query(`UPDATE voyages SET rev=$2 WHERE id=$1`, [v.id, nextRev]);

      const updated = await client.query(
        `UPDATE stowage_plans
           SET status='published', published_voyage_rev=$2, published_at=now()
         WHERE id=$1
         RETURNING id, voyage_id, source_rev, plan_rev, status,
                   published_voyage_rev, created_at, published_at`,
        [plan.id, nextRev],
      );
      const publishedPlan = updated.rows[0] as StowagePlanRow;

      const newData: LoadedVoyageData = { ...data };
      await client.query('COMMIT');
      return {
        replay: false,
        voyageRevision: nextRev,
        previousVoyageRevision: v.rev,
        sourceRevision: plan.source_rev,
        planRevision: publishedPlan.plan_rev,
        constraintsInherited: true,
        plan: this.serializePlan(publishedPlan, newData, nextRev),
        layout: {
          voyageId: v.id,
          voyageNo: v.voyage_no,
          revision: nextRev,
          current: true,
          ...buildLayoutFields(newData),
        },
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private serializePlan(plan: StowagePlanRow, data: LoadedVoyageData, voyageCurrentRev?: number) {
    return {
      planId: plan.id,
      voyageId: plan.voyage_id,
      sourceRevision: plan.source_rev,
      planRevision: plan.plan_rev,
      status: plan.status,
      published: plan.status === 'published',
      publishedVoyageRevision: plan.published_voyage_rev,
      createdAt: plan.created_at.toISOString(),
      publishedAt: plan.published_at ? plan.published_at.toISOString() : null,
      ...(voyageCurrentRev !== undefined
               ? { voyageCurrentRevision: voyageCurrentRev, sourceCurrent: voyageCurrentRev === plan.source_rev }
        : {}),
      layout: buildLayoutFields(data),
    };
  }
}
