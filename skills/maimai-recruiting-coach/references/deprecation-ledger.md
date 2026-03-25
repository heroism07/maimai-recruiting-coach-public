# Deprecated 脚本台账

更新时间：2026-03-24

## 当前停用脚本

1. `migrate-filter-table-schema.js`

状态：`deprecated`  
默认行为：阻断执行并提示替代路径。  
若确需执行历史逻辑，必须显式追加 `--allow-deprecated`。

## 替代方案

1. 字段升级：`upgrade-filter-table-v2.js`
2. 冗余字段清理：`prune-filter-table-fields.js`

推荐顺序：
1. 先执行升级脚本。
2. 再执行清理脚本。
3. 最后通过 `npm run skill:audit:scripts` 验证治理状态。

## 下线准则

满足以下条件后可考虑物理删除 deprecated 实现文件：
1. 连续 30 天无业务调用。
2. 升级+清理替代链路稳定通过。
3. 对应运行手册和 SOP 无旧脚本引用。


## 2026-03-25 评分标准来源声明（校正版）

1. legacy 路径（如 `legacy/run-online-candidate-capture.js`）中的评分逻辑仅为维护态兜底，不作为主链评分标准。  
2. 主链评分标准唯一来源为模板中的 `detail_evaluation_rule`（三维、阈值、硬排除、判定流程）。  
3. 当 legacy 逻辑与模板规则冲突时，以模板规则为准。  
