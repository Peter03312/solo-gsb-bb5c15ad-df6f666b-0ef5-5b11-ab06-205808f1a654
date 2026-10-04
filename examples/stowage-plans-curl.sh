#!/usr/bin/env bash
# 船舶危险货箱配载审定服务 —— 试排方案（stowage plan）curl 调用示例
#
# 用法: BASE=http://localhost:3000 bash examples/stowage-plans-curl.sh
#
# 演示：
#   航次A：正式配位 -> 建两个独立方案 -> 方案内调整(成功/422/方案修订号409) ->
#          方案与正式航次互不影响 -> 正式航次继续演进 -> 发布冲突(409, 方案保留)。
#   航次B：从当前修订号建方案 -> 方案内试排（允许箱未配位）-> 发布成功(201, 航次修订号+1、继承约束) ->
#          重复发布幂等(200 replay) -> 发布后只读(409) -> 未知方案 404。
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
API="$BASE/api"

say() { printf '\n=== %s ===\n' "$1"; }
jq_get() { sed -n 's/.*"'"$2"'":"\?\([^",}]*\)"\?.*/\1/p' <<<"$1" | head -1; }

say "健康检查"
curl -sS "$BASE/health"; echo

# ============================================================
# 航次 A：演示方案独立性、方案修订号与发布冲突
# ============================================================

say "A1) 登记航次 A（3x3x2，默认 10000，(1,1) 覆盖 1200，类别1-3 最小距离 3）"
A_JSON=$(curl -sS -X POST "$API/voyages" -H 'content-type: application/json' -d '{
  "voyageNo": "V-PLAN-A-'$(date +%s)'",
  "bays": 3, "rows": 3, "tiers": 2,
  "defaultColumnWeightLimit": "10000",
  "columnWeightLimits": [{ "bay": 1, "row": 1, "weightLimit": "1200" }],
  "boxes": [
    { "boxNo": "B1", "weight": "500", "category": "1" },
    { "boxNo": "B2", "weight": "600", "category": "3" },
    { "boxNo": "B3", "weight": "400", "category": "5" },
    { "boxNo": "B4", "weight": "300", "category": "1" }
  ],
  "incompatRules": [{ "categoryA": "1", "categoryB": "3", "minDistance": 3 }]
}')
echo "$A_JSON"
AID=$(jq_get "$A_JSON" id)
echo "voyageId=$AID"

say "A2) 正式整批配位（航次 revision 0 -> 1）"
curl -sS -X POST "$API/voyages/$AID/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [
    { "boxNo": "B1", "position": { "bay": 1, "row": 1, "tier": 0 } },
    { "boxNo": "B4", "position": { "bay": 1, "row": 1, "tier": 1 } },
    { "boxNo": "B2", "position": { "bay": 3, "row": 3, "tier": 0 } },
    { "boxNo": "B3", "position": { "bay": 2, "row": 2, "tier": 0 } }
  ]
}'; echo

say "A3) 从当前修订号建立试排方案 P1（初值=当前布局，约束快照固定，planRevision=0）"
P1_JSON=$(curl -sS -X POST "$API/voyages/$AID/stowage-plans" -H 'content-type: application/json' -d '{}')
echo "$P1_JSON"
P1=$(jq_get "$P1_JSON" planId)
echo "planId=$P1 sourceRevision/planRevision 见上"

say "A4) 再建一个独立方案 P2（两个方案互不影响；携带 baseRevision 做读后确认）"
curl -sS -X POST "$API/voyages/$AID/stowage-plans" -H 'content-type: application/json' \
  -d '{ "baseRevision": 1 }'; echo

say "A5) 方案列表（航次下全部方案：版本/状态/已配位箱数，不含布局明细）"
curl -sS "$API/voyages/$AID/stowage-plans"; echo

say "A6) P1 方案内整批调整：B2 (3,3)->(2,3)，距 B1=3 达标（按方案修订号 baseRevision=0）"
curl -sS -X POST "$API/stowage-plans/$P1/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [{ "boxNo": "B2", "position": { "bay": 2, "row": 3, "tier": 0 } }]
}'; echo

say "A7) 规则违反整批拒绝：B2 贴到 (1,2) 距 B1=1 < 3 -> 422，方案不变"
curl -sS -X POST "$API/stowage-plans/$P1/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 1,
  "moves": [{ "boxNo": "B2", "position": { "bay": 1, "row": 2, "tier": 0 } }]
}'; echo

say "A8) 方案修订号过期：仍带 baseRevision=0（实际已为 1）-> 409 stale_revision(revisionScope=plan)"
curl -sS -X POST "$API/stowage-plans/$P1/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [{ "boxNo": "B3", "position": null }]
}'; echo

say "A9) 查询 P1：当前试排布局 + 创建时固定约束 + 来源/方案/航次版本（当前 planRevision=1）"
curl -sS "$API/stowage-plans/$P1"; echo

say "A10) 正式航次未受试排影响：GET 正式布局仍 revision=1，B2 仍在 (3,3)"
curl -sS "$API/voyages/$AID/layout"; echo

say "A11) 正式航次继续演进：约束变更（默认承重 9500、清空覆盖与类别对）revision 1 -> 2"
curl -sS -X POST "$API/voyages/$AID/constraints" -H 'content-type: application/json' -d '{
  "baseRevision": 1,
  "defaultColumnWeightLimit": "9500",
  "columnWeightLimits": [],
  "incompatRules": []
}'; echo

say "A12) P1 约束快照固定不变（仍默认10000/(1,1)=1200/规则1-3），且 sourceCurrent 已为 false"
curl -sS "$API/stowage-plans/$P1"; echo

say "A13) 发布冲突：航次当前 revision=2 != 方案来源 1 -> 409 plan_publish_conflict，方案保留"
curl -sS -X POST "$API/stowage-plans/$P1/publish"; echo

# ============================================================
# 航次 B：演示干净发布、原子写入、约束继承、幂等与只读
# ============================================================

say "B1) 登记航次 B"
B_JSON=$(curl -sS -X POST "$API/voyages" -H 'content-type: application/json' -d '{
  "voyageNo": "V-PLAN-B-'$(date +%s)'",
  "bays": 3, "rows": 3, "tiers": 2,
  "defaultColumnWeightLimit": "10000",
  "columnWeightLimits": [{ "bay": 1, "row": 1, "weightLimit": "1200" }],
  "boxes": [
    { "boxNo": "B1", "weight": "500", "category": "1" },
    { "boxNo": "B2", "weight": "600", "category": "3" },
    { "boxNo": "B3", "weight": "400", "category": "5" }
  ],
  "incompatRules": [{ "categoryA": "1", "categoryB": "3", "minDistance": 3 }]
}')
BID=$(jq_get "$B_JSON" id)
echo "voyageId=$BID（初始 revision=0，空布局）"

say "B2) 从当前修订号 0 建立方案（初值为空布局）"
Q_JSON=$(curl -sS -X POST "$API/voyages/$BID/stowage-plans" -H 'content-type: application/json' -d '{}')
Q=$(jq_get "$Q_JSON" planId)
echo "planId=$Q"

say "B3) 方案内试排：只摆 B1@(1,1,0)、B2@(3,3,0)（B3 暂未配位，试排允许；planRevision 0->1）"
curl -sS -X POST "$API/stowage-plans/$Q/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 0,
  "moves": [
    { "boxNo": "B1", "position": { "bay": 1, "row": 1, "tier": 0 } },
    { "boxNo": "B2", "position": { "bay": 3, "row": 3, "tier": 0 } }
  ]
}'; echo

say "B4) 正式航次在发布前仍为空布局 revision=0（试排不影响正式航次/清单/核对）"
curl -sS "$API/voyages/$BID/layout"; echo

say "B5) 发布成功 201：航次 revision 0->1 原子写入方案布局，并继承来源约束快照"
curl -sS -X POST "$API/stowage-plans/$Q/publish"; echo

say "B6) 验证正式新布局 revision=1 即方案布局、约束为来源约束（(1,1)=1200 / 规则1-3）"
curl -sS "$API/voyages/$BID/layout"; echo

say "B7) 重复发布幂等 -> 200 replay:true，返回首次发布结果（voyageRevision 仍为 1）"
curl -sS -X POST "$API/stowage-plans/$Q/publish"; echo

say "B8) 发布后方案只读：再调整 -> 409 plan_readonly"
curl -sS -X POST "$API/stowage-plans/$Q/moves" -H 'content-type: application/json' -d '{
  "baseRevision": 1,
  "moves": [{ "boxNo": "B1", "position": { "bay": 2, "row": 1, "tier": 0 } }]
}'; echo

say "B9) 未知方案明确报错 -> 404 stowage_plan_not_found"
curl -sS "$API/stowage-plans/00000000-0000-0000-0000-000000000000"; echo

echo
echo "试排方案全流程演示完成。"
