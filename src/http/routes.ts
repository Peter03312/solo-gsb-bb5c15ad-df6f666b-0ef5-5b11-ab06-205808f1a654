import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { VoyageService } from '../service';
import { CheckService } from '../check-service';
import { PlanService } from '../plan-service';
import { HttpError } from '../errors';
import {
  applyMovesSchema,
  checkReportSchema,
  createPlanSchema,
  createVoyageSchema,
  issueManifestSchema,
  openCheckJobSchema,
  updateConstraintsSchema,
} from './schemas';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createApiRouter(
  service: VoyageService,
  checkService: CheckService,
  planService: PlanService,
): Router {
  const router = Router();

  function parseVoyageId(req: Request): string {
    const id = req.params['id'] ?? '';
    if (!UUID_RE.test(id)) {
      throw HttpError.badRequest('invalid_voyage_id', `航次 ID 格式非法: ${id}`);
    }
    return id;
  }

  function parseBody<Schema extends z.ZodTypeAny>(schema: Schema, body: unknown): z.infer<Schema> {
    const result = schema.safeParse(body);
    if (!result.success) {
      throw HttpError.badRequest(
        'invalid_request_body',
        '请求体校验失败',
        result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      );
    }
    return result.data;
  }

  // 创建航次（登记三维舱位、列承重、箱、不相容类别对）
  router.post('/voyages', (req, res, next) => {
    (async () => {
      const input = parseBody(createVoyageSchema, req.body);
      const voyage = await service.createVoyage(input);
      res.status(201).json(voyage);
    })().catch(next);
  });

  router.get('/voyages', (_req, res, next) => {
    service.listVoyages().then((v) => res.json(v)).catch(next);
  });

  router.get('/voyages/:id', (req, res, next) => {
    const id = parseVoyageId(req);
    service.getVoyage(id).then((v) => res.json(v)).catch(next);
  });

  // 布局：当前修订号或指定历史修订号 ?rev=N
  router.get('/voyages/:id/layout', (req, res, next) => {
    const id = parseVoyageId(req);
    const revRaw = req.query.rev;
    let rev: number | undefined;
    if (revRaw !== undefined) {
      if (typeof revRaw !== 'string' || !/^\d+$/.test(revRaw)) {
        throw HttpError.badRequest('invalid_revision', 'rev 必须为非负整数');
      }
      rev = Number(revRaw);
    }
    service.getLayout(id, rev).then((v) => res.json(v)).catch(next);
  });

  // 整批调整（携带所见修订号，允许同批交换）
  router.post('/voyages/:id/moves', (req, res, next) => {
    const id = parseVoyageId(req);
    const input = parseBody(applyMovesSchema, req.body);
    service
      .applyMoves(id, input)
      .then((v) => res.status(200).json(v))
      .catch(next);
  });

  // 安全约束变更（携带所见修订号，整套替换；受理前按新约束复验当前布局）
  router.post('/voyages/:id/constraints', (req, res, next) => {
    const id = parseVoyageId(req);
    const input = parseBody(updateConstraintsSchema, req.body);
    service
      .updateConstraints(id, input)
      .then((v) => res.status(200).json(v))
      .catch(next);
  });

  // 签发装载清单（冻结当前布局，旧清单保留）
  router.post('/voyages/:id/manifests', (req, res, next) => {
    const id = parseVoyageId(req);
    const input = parseBody(issueManifestSchema, req.body);
    service
      .issueManifest(id, input.expectedRevision)
      .then((r) => res.status(r.reused ? 200 : 201).json(r.manifest))
      .catch(next);
  });

  router.get('/voyages/:id/manifests', (req, res, next) => {
    const id = parseVoyageId(req);
    service.listManifests(id).then((v) => res.json(v)).catch(next);
  });

  router.get('/voyages/:id/manifests/:rev', (req, res, next) => {
    const id = parseVoyageId(req);
    const raw = req.params['rev'] ?? '';
    if (!/^\d+$/.test(raw)) {
      throw HttpError.badRequest('invalid_revision', '修订号必须为非负整数');
    }
    service.getManifest(id, Number(raw)).then((v) => res.json(v)).catch(next);
  });

  // ---- 现场装船核对 ----

  // 航次下的核对作业列表
  router.get('/voyages/:id/check-jobs', (req, res, next) => {
    const id = parseVoyageId(req);
    checkService.listJobs(id).then((v) => res.json(v)).catch(next);
  });

  // 以某修订号的已签发清单为基准开启核对作业（同一清单最多一个）
  router.post('/voyages/:id/check-jobs', (req, res, next) => {
    const id = parseVoyageId(req);
    const input = parseBody(openCheckJobSchema, req.body);
    checkService
      .openJob(id, input)
      .then((v) => res.status(201).json(v))
      .catch(next);
  });

  // 查询核对状态：应装/已核对/缺失/错位/清单外箱
  router.get('/check-jobs/:jobId', (req, res, next) => {
    const jobId = parseJobId(req);
    checkService.getStatus(jobId).then((v) => res.json(v)).catch(next);
  });

  // 上报留痕
  router.get('/check-jobs/:jobId/reports', (req, res, next) => {
    const jobId = parseJobId(req);
    checkService.listReports(jobId).then((v) => res.json(v)).catch(next);
  });

  // 现场上报：箱号 + 实装位置/撤销 + 唯一上报号
  router.post('/check-jobs/:jobId/reports', (req, res, next) => {
    const jobId = parseJobId(req);
    const input = parseBody(checkReportSchema, req.body);
    checkService
      .submitReport(jobId, input)
      .then((v) => res.status(v.replay ? 200 : 201).json(v))
      .catch(next);
  });

  // 结案：全部一致且无清单外箱才冻结，否则返回差异且作业继续开放
  router.post('/check-jobs/:jobId/close', (req, res, next) => {
    const jobId = parseJobId(req);
    checkService
      .closeJob(jobId)
      .then((v) => res.status(v.replay ? 200 : 201).json(v))
      .catch(next);
  });

  // ---- 试排方案 ----

  // 从航次当前修订号建立试排方案（以当前布局为初值、固定当前约束快照）
  router.post('/voyages/:id/plans', (req, res, next) => {
    (async () => {
      const id = parseVoyageId(req);
      const input = parseBody(createPlanSchema, req.body);
      const plan = await planService.createPlan(id, input);
      res.status(201).json(plan);
    })().catch(next);
  });

  // 航次下的试排方案列表
  router.get('/voyages/:id/plans', (req, res, next) => {
    const id = parseVoyageId(req);
    planService.listPlans(id).then((v) => res.json(v)).catch(next);
  });

  // 查询方案：当前试排布局、固定约束与版本（来源修订号/方案修订号/状态）
  router.get('/plans/:planId', (req, res, next) => {
    const planId = parsePlanId(req);
    planService.getPlan(planId).then((v) => res.json(v)).catch(next);
  });

  // 方案内整批调整（携带所见方案修订号；与正式航次同一套校验规则；失败不改变方案）
  router.post('/plans/:planId/moves', (req, res, next) => {
    const planId = parsePlanId(req);
    const input = parseBody(applyMovesSchema, req.body);
    planService
      .applyMoves(planId, input)
      .then((v) => res.status(200).json(v))
      .catch(next);
  });

  // 发布方案：航次当前修订号仍等于方案来源修订号时，原子写入航次新修订号并继承方案约束；
  // 否则 409 冲突且保留方案；已发布方案重复发布幂等返回首次结果
  router.post('/plans/:planId/publish', (req, res, next) => {
    const planId = parsePlanId(req);
    planService
      .publish(planId)
      .then((v) => res.status(v.replay ? 200 : 201).json(v))
      .catch(next);
  });

  function parsePlanId(req: Request): string {
    const id = req.params['planId'] ?? '';
    if (!UUID_RE.test(id)) {
      throw HttpError.badRequest('invalid_plan_id', `试排方案 ID 格式非法: ${id}`);
    }
    return id;
  }

  function parseJobId(req: Request): string {
    const id = req.params['jobId'] ?? '';
    if (!UUID_RE.test(id)) {
      throw HttpError.badRequest('invalid_check_job_id', `核对作业 ID 格式非法: ${id}`);
    }
    return id;
  }

  return router;
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error('[unhandled]', err);
  res.status(500).json({ error: { code: 'internal_error', message } });
}
