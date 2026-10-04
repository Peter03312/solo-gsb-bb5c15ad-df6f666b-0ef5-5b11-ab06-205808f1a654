import { z } from 'zod';

const weightString = z
  .string()
  .regex(/^\d+(\.\d+)?$/, '必须为非负十进制数字（单位 kg）')
  .refine((s) => Number(s) > 0, '必须为正数');

const positiveInt = z.number().int('必须为整数').positive('必须为正整数');
const nonNegativeInt = z.number().int('必须为整数').min(0, '必须为非负整数');

export const positionSchema = z.object({
  bay: positiveInt,
  row: positiveInt,
  tier: nonNegativeInt,
});

const moveInputSchema = z.object({
  boxNo: z.string().trim().min(1, '箱号不能为空'),
  position: positionSchema.nullable(),
});

const columnLimitSchema = z.object({
  bay: positiveInt,
  row: positiveInt,
  weightLimit: weightString,
});

const boxSchema = z.object({
  boxNo: z.string().trim().min(1, '箱号不能为空').max(32),
  weight: weightString,
  category: z.string().trim().min(1, '危险品类别不能为空').max(16),
});

const ruleSchema = z.object({
  categoryA: z.string().trim().min(1).max(16),
  categoryB: z.string().trim().min(1).max(16),
  minDistance: positiveInt,
});

const createVoyageInput = z.object({
  voyageNo: z.string().trim().min(1, '航次号不能为空').max(64),
  bays: positiveInt,
  rows: positiveInt,
  tiers: positiveInt,
  defaultColumnWeightLimit: weightString,
  columnWeightLimits: z.array(columnLimitSchema).optional(),
  boxes: z.array(boxSchema).optional(),
  incompatRules: z.array(ruleSchema).optional(),
});

export const createVoyageSchema = createVoyageInput.transform((d) => ({
  voyageNo: d.voyageNo,
  bays: d.bays,
  rows: d.rows,
  tiers: d.tiers,
  defaultColumnWeightLimit: d.defaultColumnWeightLimit,
  columnWeightLimits: d.columnWeightLimits ?? [],
  boxes: d.boxes ?? [],
  incompatRules: d.incompatRules ?? [],
}));

const applyMovesInput = z.object({
  baseRevision: nonNegativeInt,
  moves: z.array(moveInputSchema).optional(),
});

export const applyMovesSchema = applyMovesInput.transform((d) => ({
  baseRevision: d.baseRevision,
  moves: d.moves ?? [],
}));

/**
 * 安全约束整批变更：携带所见 baseRevision，提交整套
 * 默认列承重 / 按列覆盖限额 / 不相容类别对（全量替换：未列出即撤销）。
 * 正数、列坐标、类别对唯一性的业务规则在 service 层沿用登记校验。
 */
export const updateConstraintsSchema = z
  .object({
    baseRevision: nonNegativeInt,
    defaultColumnWeightLimit: weightString,
    columnWeightLimits: z.array(columnLimitSchema).optional(),
    incompatRules: z.array(ruleSchema).optional(),
  })
  .transform((d) => ({
    baseRevision: d.baseRevision,
    defaultColumnWeightLimit: d.defaultColumnWeightLimit,
    columnWeightLimits: d.columnWeightLimits ?? [],
    incompatRules: d.incompatRules ?? [],
  }));

export const issueManifestSchema = z.object({
  expectedRevision: nonNegativeInt,
});

// ---- 试排方案 ----

/**
 * 建立试排方案：从航次当前修订号派生独立工作区（以当前布局为初值、固定当前约束快照）。
 * 请求体可整体省略；label 仅用于区分同一航次下的多个方案。
 */
export const createPlanSchema = z
  .object({
    label: z.string().trim().min(1, '方案名不能为空').max(64).optional(),
  })
  .nullish()
  .transform((d) => ({ label: d?.label ?? null }));

/**
 * 方案内整批调整：与正式航次整批调整同构（baseRevision 为方案修订号）。
 * 直接复用 applyMovesSchema。
 */

// ---- 现场装船核对 ----

export const openCheckJobSchema = z.object({
  /** 作为核对基准的已签发清单修订号 */
  manifestRevision: nonNegativeInt,
});

/**
 * 单次核对上报：
 *   position 非 null  → 实装位置（坐标需在舱位范围内）
 *   position 为 null  → 撤销标记（该箱未装）
 * 每次上报必须携带全作业唯一的 reportNo（幂等键）。
 */
export const checkReportSchema = z.object({
  reportNo: z.string().trim().min(1, '上报号不能为空').max(64),
  boxNo: z.string().trim().min(1, '箱号不能为空').max(32),
  position: positionSchema.nullable(),
});
