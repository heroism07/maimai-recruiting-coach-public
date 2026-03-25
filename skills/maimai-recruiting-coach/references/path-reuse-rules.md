# 成功路径优先复用规则

更新时间：2026-03-24

## 1. 目标

将筛选落地流程统一为：
`success_path_exact -> success_path_fallback -> generated -> learned`。

默认行为分场景：
- 在线执行：`reuse-success-path=exact`
- 离线回放：`reuse-success-path=auto`

## 2. 匹配与降级

1. 精确命中：`template_base_name + page_signature_hash`。  
2. 降级命中：同 `template_base_name` 下按健康度排序挑最佳路径（仅离线或人工确认场景启用）。  
3. 仍未命中：回退到 runtime 生成操作。  
4. 无可生成操作：标记 `learned`，交给学习模式/人工接管。

在线约束：
1. 默认拒绝 `success_path_fallback`，避免跨页面结构误复用。
2. 仅 `success_path_exact` 可直接复用。

## 3. 排序规则

路径选择按以下顺序排序：
1. `success_runs` 高优先  
2. `last_success_at` 新优先

## 4. 健康度与熔断

每条路径记录：
- `total_runs`
- `success_runs`
- `fail_runs`
- `last_success_at`
- `last_fail_at`
- `consecutive_failures`

熔断规则：
- 同一 `path_id` 连续失败 `>=2`，自动标记 `deprecated`。
- `deprecated` 路径不参与优先复用。

## 5. 合规检查输出字段

所有主流程输出应包含：
- `apply_ops_source`: `success_path_exact|success_path_fallback|generated|learned`
- `path_reuse_miss_reason`: `reuse_disabled|no_template|no_signature_match|no_path|no_generated_operations`
- `selected_path_id`: 命中路径时返回

## 6. 观测指标

从本地路径库统计并输出：
- `path_hit_rate`
- `avg_apply_retry_count`
- `apply_success_rate`
- `exact_hit_rate`
- `fallback_blocked_count`

说明：
- `path_hit_rate = (exact + fallback) / resolve_total`
- `avg_apply_retry_count = apply_retry_total / apply_total`
- `apply_success_rate = apply_success / apply_total`
- `exact_hit_rate = exact / resolve_total`

