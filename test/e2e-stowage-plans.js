/* eslint-disable no-console */
// 端到端验证：试排方案（stowage plan）
//   - 从航次当前修订号建立多个相互独立的方案；创建时布局为初值、约束快照固定
//   - 方案内整批调整沿用箱号/坐标/最终布局校验；按方案修订号乐观并发；失败不改变方案
//   - 查询返回当前试排布局/约束/版本；未知方案 404
//   - 正式航次、清单、核对作业不受试排影响
//   - 发布：航次当前修订号==来源修订号才原子写入新修订号并继承约束；否则冲突保留方案
//   - 发布后只读；重复发布幂等返回首次结果
//   - 历史布局、旧清单、在办核对的冻结语义不变；既有接口保持可用
// 运行: npm run build && node test/e2e-stowage-plans.js
const path = require('path');
process.env.SCHEMA_PATH = path.join(__dirname, '..', 'src', 'schema.sql');
const EmbeddedPostgres = require('embedded-postgres').default;

const PORT = 30199;
const BASE = `http://127.0.0.1:${PORT}/api`;
let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`, extra ?? '');
  }
}

async function http(method, url, body, expectedStatus) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (expectedStatus !== undefined && res.status !== expectedStatus) {
    throw new Error(`${method} ${url} 期望 ${expectedStatus} 实际 ${res.status}: ${JSON.stringify(json)}`);
  }
  return { status: res.status, body: json };
}

const posOf = (planJson, boxNo) => {
  const p = planJson.layout.placements.find((x) => x.boxNo === boxNo);
  return p ? p.position : null;
};

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: path.join('/tmp', 'pgdata-e2e-plans'),
    user: 'stowage',
    password: 'stowage',
    port: 54399,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('stowage');

  const { createPool, waitForDatabase, initSchema } = require('../dist/src/db');
  const { createApp } = require('../dist/src/app');
  const pool = createPool({
    databaseUrl: 'postgres://stowage:stowage@127.0.0.1:54399/stowage',
    schemaPath: process.env.SCHEMA_PATH,
  });
  await waitForDatabase(pool, 30);
  await initSchema(pool, { schemaPath: process.env.SCHEMA_PATH });
  const server = await new Promise((resolve) => {
    const s = createApp(pool).listen(PORT, '127.0.0.1', () => resolve(s));
  });

  try {
    // ---- 登记：3 bay x 3 row x 2 tier；默认 10000；(1,1) 覆盖 1200；规则 1-3 距离 3 ----
    const createBody = {
      voyageNo: 'V-PLAN-001',
      bays: 3, rows: 3, tiers: 2,
      defaultColumnWeightLimit: '10000',
      columnWeightLimits: [{ bay: 1, row: 1, weightLimit: '1200' }],
      boxes: [
        { boxNo: 'B1', weight: '500', category: '1' },
        { boxNo: 'B2', weight: '600', category: '3' },
        { boxNo: 'B3', weight: '400', category: '5' },
        { boxNo: 'B4', weight: '300', category: '1' },
      ],
      incompatRules: [{ categoryA: '1', categoryB: '3', minDistance: 3 }],
    };

    const { body: voyage } = await http('POST', `${BASE}/voyages`, createBody, 201);
    const vid = voyage.id;
    check('登记 revision=0', voyage.revision === 0);

    // ---- 正式布局 rev=0 -> 1（满足登记约束）----
    await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 0,
      moves: [
        { boxNo: 'B1', position: { bay: 1, row: 1, tier: 0 } },
        { boxNo: 'B4', position: { bay: 1, row: 1, tier: 1 } },
        { boxNo: 'B2', position: { bay: 3, row: 3, tier: 0 } },
        { boxNo: 'B3', position: { bay: 2, row: 2, tier: 0 } },
      ],
    }, 200);

    // ---- 1. 从当前修订号建立两个相互独立的方案（初值=创建时布局，约束固定）----
    const c1 = await http('POST', `${BASE}/voyages/${vid}/stowage-plans`, {}, 201);
    const p1 = c1.body.plan;
    check('方案1 创建：sourceRevision=1 planRevision=0 draft',
      p1.sourceRevision === 1 && p1.planRevision === 0 && p1.status === 'draft' &&
      p1.published === false && p1.publishedVoyageRevision === null,
      JSON.stringify(p1));
    check('方案1 以创建时布局为初值（4 箱全配位）',
      p1.layout.placements.length === 4 && posOf(p1, 'B1').bay === 1 &&
      posOf(p1, 'B1').tier === 0 && posOf(p1, 'B2').bay === 3);
    check('方案1 固定创建时约束（默认 10000 / (1,1)=1200 / 规则 1-3 距离 3）',
      p1.layout.defaultColumnWeightLimit === '10000' &&
      p1.layout.columnWeightLimits.length === 1 &&
      p1.layout.columnWeightLimits[0].weightLimit === '1200' &&
      p1.layout.incompatRules.length === 1 &&
      p1.layout.incompatRules[0].categoryB === '3');
    check('方案1 返回航次当前修订号且 sourceCurrent=true',
      p1.voyageCurrentRevision === 1 && p1.sourceCurrent === true);

    const c2 = await http('POST', `${BASE}/voyages/${vid}/stowage-plans`, { baseRevision: 1 }, 201);
    const p2 = c2.body.plan;
    check('方案2 携带匹配 baseRevision 创建成功（与方案1独立 ID）',
      p2.sourceRevision === 1 && p2.id !== p1.planId);

    const staleCreate = await http('POST', `${BASE}/voyages/${vid}/stowage-plans`, { baseRevision: 0 });
    check('携带过期 baseRevision 建方案 -> 409 stale_revision 返回当前修订号',
      staleCreate.status === 409 && staleCreate.body.error.code === 'stale_revision' &&
      staleCreate.body.error.details.currentRevision === 1);

    const list = (await http('GET', `${BASE}/voyages/${vid}/stowage-plans`, undefined, 200)).body;
    check('方案列表含 2 个方案（带版本/状态，不含布局明细）',
      list.plans.length === 2 &&
      list.plans.every((x) => x.sourceRevision === 1 && x.placedCount === 4) &&
      list.plans[0].planId === p2.planId,
      JSON.stringify(list));

    // ---- 2. 方案1 调整：B2 从 (3,3) 移到 (2,3)（距 B1 = |1|+|2|=3 达标）-> planRevision 1 ----
    const m1 = await http('POST', `${BASE}/stowage-plans/${p1.planId}/moves`, {
      baseRevision: 0,
      moves: [{ boxNo: 'B2', position: { bay: 2, row: 3, tier: 0 } }],
    }, 200);
    check('方案调整成功 planRevision 0->1',
      m1.body.planRevision === 1 && m1.body.previousPlanRevision === 0 &&
      posOf(m1.body.plan, 'B2').bay === 2);

    // 方案2 不受影响，仍保持初值 B2@(3,3)
    const p2view = (await http('GET', `${BASE}/stowage-plans/${p2.planId}`, undefined, 200)).body.plan;
    check('方案间相互独立：方案2 布局仍为初值 B2@(3,3)',
      p2view.planRevision === 0 && posOf(p2view, 'B2').bay === 3);

    // 正式航次不受试排影响：当前仍 rev=1，B2@(3,3)
    const official = (await http('GET', `${BASE}/voyages/${vid}/layout`, undefined, 200)).body;
    check('试排不影响正式航次：rev 仍 1，B2 仍 (3,3)',
      official.revision === 1 && official.placements.find((x) => x.boxNo === 'B2').position.bay === 3);

    // ---- 3. 规则违反整批拒绝：B2 贴到 (1,2) 距 B1=1 < 3 -> 422，方案不变 ----
    const bad = await http('POST', `${BASE}/stowage-plans/${p1.planId}/moves`, {
      baseRevision: 1,
      moves: [{ boxNo: 'B2', position: { bay: 1, row: 2, tier: 0 } }],
    });
    check('违反不相容距离 -> 422 validation_failed（含箱号/位置/原因）',
      bad.status === 422 && bad.body.error.code === 'validation_failed' &&
      bad.body.error.details.violations.some((x) =>
        x.reason === 'incompatible_too_close' && x.boxA === 'B1' && x.boxB === 'B2' &&
        x.distance === 1 && x.minDistance === 3));
    const p1afterBad = (await http('GET', `${BASE}/stowage-plans/${p1.planId}`, undefined, 200)).body.plan;
    check('校验失败不改变方案：planRevision 仍 1，B2 仍 (2,3)',
      p1afterBad.planRevision === 1 && posOf(p1afterBad, 'B2').bay === 2 &&
      posOf(p1afterBad, 'B2').row === 3);

    // ---- 4. 请求级错误（与正式 /moves 同构）----
    const unknownBox = await http('POST', `${BASE}/stowage-plans/${p1.planId}/moves`, {
      baseRevision: 1,
      moves: [{ boxNo: 'NOPE', position: { bay: 1, row: 1, tier: 0 } }],
    });
    check('未知箱号 -> 400 unknown_box',
      unknownBox.status === 400 &&
      JSON.stringify(unknownBox.body).includes('unknown_box'));

    const badCoord = await http('POST', `${BASE}/stowage-plans/${p1.planId}/moves`, {
      baseRevision: 1,
      moves: [{ boxNo: 'B1', position: { bay: 9, row: 1, tier: 0 } }],
    });
    check('坐标越界 -> 400 invalid_coordinates',
      badCoord.status === 400 &&
      JSON.stringify(badCoord.body).includes('invalid_coordinates'));

    const dup = await http('POST', `${BASE}/stowage-plans/${p1.planId}/moves`, {
      baseRevision: 1,
      moves: [
        { boxNo: 'B3', position: null },
        { boxNo: 'B3', position: { bay: 3, row: 1, tier: 0 } },
      ],
    });
    check('同批重复箱号 -> 400 duplicate_box_in_batch',
      dup.status === 400 && JSON.stringify(dup.body).includes('duplicate_box_in_batch'));
    const p1afterReqErrs = (await http('GET', `${BASE}/stowage-plans/${p1.planId}`, undefined, 200)).body.plan;
    check('请求级错误同样不改变方案（planRevision 仍 1）', p1afterReqErrs.planRevision === 1);

    // ---- 5. 方案修订号乐观并发：409 stale_revision，且 details.revisionScope=plan ----
    const stale = await http('POST', `${BASE}/stowage-plans/${p1.planId}/moves`, {
      baseRevision: 0,
      moves: [{ boxNo: 'B3', position: null }],
    });
    check('过期方案修订号 -> 409 stale_revision 带回方案当前修订号',
      stale.status === 409 && stale.body.error.code === 'stale_revision' &&
      stale.body.error.details.revisionScope === 'plan' &&
      stale.body.error.details.expectedRevision === 0 &&
      stale.body.error.details.currentRevision === 1,
      JSON.stringify(stale.body));

    // 撤位（position=null）合法：B3 暂留空，planRevision 1->2
    const revoke = await http('POST', `${BASE}/stowage-plans/${p1.planId}/moves`, {
      baseRevision: 1,
      moves: [{ boxNo: 'B3', position: null }],
    }, 200);
    check('撤位合法：B3 进入 unplacedBoxNos，planRevision=2',
      revoke.body.planRevision === 2 &&
      posOf(revoke.body.plan, 'B3') === null &&
      revoke.body.plan.layout.unplacedBoxNos.includes('B3'));

    // 同方案并发：相同 baseRevision 只有一个成功
    const payload = {
      baseRevision: 2,
      moves: [{ boxNo: 'B3', position: { bay: 3, row: 1, tier: 0 } }],
    };
    const [cc1, cc2] = await Promise.all([
      http('POST', `${BASE}/stowage-plans/${p1.planId}/moves`, payload),
      http('POST', `${BASE}/stowage-plans/${p1.planId}/moves`, payload),
    ]);
    const statuses = [cc1.status, cc2.status].sort();
    check('同方案并发同修订号：一个 200 一个 409',
      statuses[0] === 200 && statuses[1] === 409, JSON.stringify([cc1.status, cc2.status]));
    const p1final = (await http('GET', `${BASE}/stowage-plans/${p1.planId}`, undefined, 200)).body.plan;
    check('并发后方案修订号恰好为 3', p1final.planRevision === 3, String(p1final.planRevision));

    // ---- 6. 未知方案明确报错 ----
    const nf = await http('GET', `${BASE}/stowage-plans/00000000-0000-0000-0000-000000000000`);
    check('未知方案 GET -> 404 stowage_plan_not_found',
      nf.status === 404 && nf.body.error.code === 'stowage_plan_not_found');
    const nfMove = await http('POST', `${BASE}/stowage-plans/00000000-0000-0000-0000-000000000000/moves`, {
      baseRevision: 0, moves: [],
    });
    check('未知方案调整 -> 404', nfMove.status === 404);
    const nfPub = await http('POST', `${BASE}/stowage-plans/00000000-0000-0000-0000-000000000000/publish`);
    check('未知方案发布 -> 404', nfPub.status === 404);
    const badId = await http('GET', `${BASE}/stowage-plans/not-a-uuid`);
    check('非法方案 ID -> 400', badId.status === 400);

    // ---- 7. 方案约束快照固定：正式约束变更（rev1->2）后，方案仍按旧约束校验 ----
    // 正式收紧默认承重到 700：当前正式布局 (1,1)=500+300=800 会冲突 -> 422；改 9500 通过 -> rev2
    const cstrChange = await http('POST', `${BASE}/voyages/${vid}/constraints`, {
      baseRevision: 1,
      defaultColumnWeightLimit: '9500',
      columnWeightLimits: [],
      incompatRules: [],
    }, 200);
    check('正式约束变更成功 rev=2（布局继承）', cstrChange.body.revision === 2);

    // 方案1 仍持旧约束（默认 10000 / (1,1)=1200 / 规则 1-3）
    const p1frozen = (await http('GET', `${BASE}/stowage-plans/${p1.planId}`, undefined, 200)).body.plan;
    check('方案约束快照不变：仍含 (1,1)=1200 覆盖与 1-3 规则',
      p1frozen.layout.defaultColumnWeightLimit === '10000' &&
      p1frozen.layout.columnWeightLimits.length === 1 &&
      p1frozen.layout.incompatRules.length === 1);
    check('方案查询此时标记 sourceCurrent=false（航次已到 rev2）',
      p1frozen.voyageCurrentRevision === 2 && p1frozen.sourceCurrent === false);
    // 方案内按旧约束：把 B2 贴到 (1,2) 在新正式约束（无 1-3 规则）下合法、在方案旧约束下仍应 422
    const stillOldRule = await http('POST', `${BASE}/stowage-plans/${p1.planId}/moves`, {
      baseRevision: 3,
      moves: [{ boxNo: 'B2', position: { bay: 1, row: 2, tier: 0 } }],
    });
    check('方案内仍按固定的旧约束拒绝（1-3 距离不足）',
      stillOldRule.status === 422 &&
      stillOldRule.body.error.details.violations.some((x) => x.reason === 'incompatible_too_close'));

    // ---- 8. 发布冲突：航次已从来源修订号演进（rev2 != source1），方案保留 ----
    const conflictPub = await http('POST', `${BASE}/stowage-plans/${p1.planId}/publish`);
    check('来源修订号过期 -> 409 plan_publish_conflict（保留方案）',
      conflictPub.status === 409 && conflictPub.body.error.code === 'plan_publish_conflict' &&
      conflictPub.body.error.details.sourceRevision === 1 &&
      conflictPub.body.error.details.currentRevision === 2,
      JSON.stringify(conflictPub.body));
    const p1retained = (await http('GET', `${BASE}/stowage-plans/${p1.planId}`, undefined, 200)).body.plan;
    check('冲突后方案保留且仍 draft、可继续调整',
      p1retained.status === 'draft' && p1retained.planRevision === 3);

    // ---- 9. 正式清单与核对作业不受试排影响（既有接口可用）----
    // 在 rev2 正式布局上把 B2 收回原位以便全配位签发（rev2->3）
    await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 2,
      moves: [{ boxNo: 'B2', position: { bay: 3, row: 3, tier: 0 } }],
    }, 200); // -> rev3
    const manifest = await http('POST', `${BASE}/voyages/${vid}/manifests`, { expectedRevision: 3 }, 201);
    check('正式清单签发成功（试排方案存在且未发布不影响）',
      manifest.body.current === true && manifest.body.boxCount === 4);
    const job = await http('POST', `${BASE}/voyages/${vid}/check-jobs`, { manifestRevision: 3 }, 201);
    const jobId = job.body.job.jobId;
    check('核对作业可正常开工', job.body.job.manifestRevision === 3);

    // ---- 10. 干净路径：新航次/方案发布成功，原子写入新修订号并继承来源约束 ----
    const v2body = {
      voyageNo: 'V-PLAN-002',
      bays: 3, rows: 3, tiers: 2,
      defaultColumnWeightLimit: '10000',
      columnWeightLimits: [{ bay: 1, row: 1, weightLimit: '1200' }],
      boxes: [
        { boxNo: 'B1', weight: '500', category: '1' },
        { boxNo: 'B2', weight: '600', category: '3' },
        { boxNo: 'B3', weight: '400', category: '5' },
      ],
      incompatRules: [{ categoryA: '1', categoryB: '3', minDistance: 3 }],
    };
    const v2 = (await http('POST', `${BASE}/voyages`, v2body, 201)).body;
    // 从 rev0（空布局）建方案，方案内把 B1/B2 摆到满足约束的位置；允许有箱未配位
    const planA = (await http('POST', `${BASE}/voyages/${v2.id}/stowage-plans`, {}, 201)).body.plan;
    await http('POST', `${BASE}/stowage-plans/${planA.planId}/moves`, {
      baseRevision: 0,
      moves: [
        { boxNo: 'B1', position: { bay: 1, row: 1, tier: 0 } },
        { boxNo: 'B2', position: { bay: 3, row: 3, tier: 0 } },
      ],
    }, 200); // planRevision 1（B3 未配位，试排允许）

    const pub = await http('POST', `${BASE}/stowage-plans/${planA.planId}/publish`, undefined, 201);
    check('发布成功 201：航次 rev 0->1，来源 0，方案修订号 1，约束继承',
      pub.body.voyageRevision === 1 && pub.body.previousVoyageRevision === 0 &&
      pub.body.sourceRevision === 0 && pub.body.planRevision === 1 &&
      pub.body.replay === false && pub.body.constraintsInherited === true,
      JSON.stringify(pub.body));
    check('发布返回写入后的正式布局（2 箱配位、B3 未配位）',
      pub.body.layout.revision === 1 && pub.body.layout.current === true &&
      pub.body.layout.placements.length === 2 &&
      pub.body.layout.unplacedBoxNos.includes('B3'));
    const v2official = (await http('GET', `${BASE}/voyages/${v2.id}/layout`, undefined, 200)).body;
    check('正式布局即方案布局：B1@(1,1,0) B2@(3,3,0)',
      v2official.revision === 1 &&
      v2official.placements.find((x) => x.boxNo === 'B1').position.bay === 1 &&
      v2official.placements.find((x) => x.boxNo === 'B2').position.bay === 3 &&
      v2official.placements.length === 2);
    check('正式新修订号继承来源约束（(1,1)=1200 / 规则 1-3 距离 3）',
      v2official.defaultColumnWeightLimit === '10000' &&
      v2official.columnWeightLimits.length === 1 &&
      v2official.columnWeightLimits[0].weightLimit === '1200' &&
      v2official.incompatRules.length === 1);
    const hist = (await http('GET', `${BASE}/voyages/${v2.id}/layout?rev=0`, undefined, 200)).body;
    check('历史布局 rev=0 仍为空布局、约束快照齐全（冻结语义不变）',
      hist.placements.length === 0 && hist.incompatRules.length === 1);

    // ---- 11. 发布后方案只读；重复发布幂等返回首次结果 ----
    const pubView = (await http('GET', `${BASE}/stowage-plans/${planA.planId}`, undefined, 200)).body.plan;
    check('发布后方案 published 且记录 publishedVoyageRevision=1',
      pubView.status === 'published' && pubView.published === true &&
      pubView.publishedVoyageRevision === 1 && pubView.publishedAt !== null);
    const moveAfterPub = await http('POST', `${BASE}/stowage-plans/${planA.planId}/moves`, {
      baseRevision: 1,
      moves: [{ boxNo: 'B1', position: { bay: 2, row: 1, tier: 0 } }],
    });
    check('已发布方案调整 -> 409 plan_readonly',
      moveAfterPub.status === 409 && moveAfterPub.body.error.code === 'plan_readonly');
    const repub = await http('POST', `${BASE}/stowage-plans/${planA.planId}/publish`, undefined, 200);
    check('重复发布 -> 200 replay:true，返回首次发布结果（voyageRevision 仍 1）',
      repub.body.replay === true && repub.body.voyageRevision === 1 &&
      repub.body.sourceRevision === 0 && repub.body.planRevision === 1);
    const v2afterRepub = (await http('GET', `${BASE}/voyages/${v2.id}`, undefined, 200)).body;
    check('重复发布不产生新修订号（航次仍 rev1）', v2afterRepub.revision === 1);

    // ---- 12. 同源两方案：先发布者成功，后发布者冲突且方案保留 ----
    const planB = (await http('POST', `${BASE}/voyages/${v2.id}/stowage-plans`, {}, 201)).body.plan;
    check('可从新当前修订号再建方案（planB source=1）', planB.sourceRevision === 1);
    // 把 B3 也配位（方案 B 的差异化布局，满足约束）
    await http('POST', `${BASE}/stowage-plans/${planB.planId}/moves`, {
      baseRevision: 0,
      moves: [{ boxNo: 'B3', position: { bay: 2, row: 2, tier: 0 } }],
    }, 200);
    // 航次当前 rev 已为 2? 否——planA 发布只 +1，当前 rev=1 == planB.source，可直接发布成功
    const pubB = await http('POST', `${BASE}/stowage-plans/${planB.planId}/publish`, undefined, 201);
    check('方案B 来源仍匹配当前 rev1 -> 发布成功 rev=2（布局含 3 箱）',
      pubB.body.voyageRevision === 2 && pubB.body.layout.placements.length === 3,
      JSON.stringify(pubB.body));
    // planA 已发布（只读、幂等），不受 planB 发布影响
    const planAAgain = (await http('GET', `${BASE}/stowage-plans/${planA.planId}`, undefined, 200)).body.plan;
    check('方案A 仍只读且 publishedVoyageRevision=1（首次发布结果不变）',
      planAAgain.status === 'published' && planAAgain.publishedVoyageRevision === 1);

    // ---- 13. 在办核对不受“试排与发布”影响：作业仍以冻结清单 rev3 为基准 ----
    const st = (await http('GET', `${BASE}/check-jobs/${jobId}`, undefined, 200)).body;
    check('在办核对仍开放、应装 4 箱（不受方案/发布影响）',
      st.status === 'open' && st.counts.expected === 4);

    // ---- 14. 既有航次接口与错误约定保持可用（冒烟）----
    const voyList = await http('GET', `${BASE}/voyages`, undefined, 200);
    check('GET /voyages 正常返回 2 个航次', voyList.body.length === 2);
    const staleOfficial = await http('POST', `${BASE}/voyages/${vid}/moves`, {
      baseRevision: 0, moves: [],
    });
    check('正式 /moves 过期修订号仍 409 stale_revision',
      staleOfficial.status === 409 && staleOfficial.body.error.code === 'stale_revision');

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
    process.exitCode = failed === 0 ? 0 : 1;
  } catch (e) {
    console.error('E2E 异常:', e);
    process.exitCode = 1;
  } finally {
    await new Promise((r) => server.close(r));
    await pool.end();
    await pg.stop();
  }
}

main();
