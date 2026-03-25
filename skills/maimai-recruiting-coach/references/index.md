# 脉脉技能文档索引

更新时间：2026-03-24

## 先看哪份文档

1. 想直接执行主流程：看 `SKILL.md`
2. 想确认 AI 页面接管细则：看 `ai-takeover-default.md`
3. 想理解业务闭环和模板批处理：看 `maimai-workflow.md`
4. 想确认成功路径复用规则：看 `path-reuse-rules.md`
5. 想确认飞书字段与入库边界：看 `feishu-sync-rules.md`
6. 想给 HR 同学直接执行：看 `hrbp-one-click-sop.md`
7. 想查看停用脚本与替代关系：看 `deprecation-ledger.md`
8. 想核对脉脉每个筛选控件怎么操作：看 `filter-ui-operation-rules.md`

## 专题文档

- 字段映射：`filter-field-mapping.current.md`
- 模板版本：`template-versioning-rules.md`
- 画像转筛选：`profile-to-filter-rules.md`
- 招呼语约束：`greeting-guardrails.md`
- 候选人字段定义：`candidate-fields.md`
- 筛选控件操作：`filter-ui-operation-rules.md`
- 快速验收：`quick-validate.md`
- Deprecated 台账：`deprecation-ledger.md`
- 一键执行 SOP：`hrbp-one-click-sop.md`

## 文档边界约定

1. `SKILL.md` 只保留“执行主链路 + 核心命令 + 治理边界”。
2. 细节规则放 `references/`，避免主文档重复。
3. 同一规则只在一处定义，其他文档仅做链接或引用。
4. `maintenance/deprecated` 脚本实现归档在 `scripts/legacy/`，详见 `scripts/legacy/README.md`。

## 当前统一口径（2026-03-25）

1. 六项检查为业务检查，固定为：基础信息完整、硬性条件匹配、相关经验对口、职业稳定性可接受、求职意愿与沟通可达性明确、风险备注完整。
2. 六项检查结果字段固定为 `六项检查结果`，取值仅允许 `通过` / `不通过`。
3. “点击搜索并确认结果刷新”属于流程动作，不属于六项检查。
4. “六项检查结果=通过”仅表示完整性通过（六项都已判断且有依据），不表示候选人质量通过。
5. 六项定义与验收细则以 `quick-validate.md` 为唯一权威。
