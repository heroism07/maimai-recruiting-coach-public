---
name: maimai-recruiting-coach
description: 脉脉招聘端人机协同技能（AI接管优先）。当用户提到脉脉候选人筛选、职位模板复用、可沟通/储备观察同步飞书、筛选条件沉淀复用时都应使用本技能。默认由 AI 接管页面执行，脚本仅负责结构化、同步与版本化。
---

# Maimai Recruiting Coach

## 核心目标

把“岗位画像 -> 脉脉筛选 -> 候选人评估 -> 飞书同步”做成稳定闭环，且满足：
1. AI 接管优先，页面自动化不依赖硬编码 selector 主链路。
2. 候选人入库白名单固定：仅 `可沟通`、`储备观察`。
3. 职位筛选条件可存储、可版本化、可复用。
4. 详情评估规则（三维匹配+评分阈值）可模板化沉淀并复用。
5. 脚本数量受治理，不允许无边界扩张。

## 执行边界（必须遵守）

1. 页面控制默认使用 AI 接管；脚本不作为默认页面点击主链路。
2. 仅允许在 `*.maimai.cn` 页面自动化；出现验证码/风控立即转人工。
3. 必须使用独立浏览器空间：`data/maimai-browser-profile`。
4. 脚本负责数据处理与飞书同步，不负责绕过平台安全机制。
5. 浏览器必须为可见窗口（headed）；禁止默认无头模式执行线上筛选。

## 已登录页面接管优先级（新增）

1. 先检查是否存在“独立浏览器 + 已登录脉脉人才银行/搜索页”，命中即直接接管，禁止先 `goto` 覆盖页面。
2. 固定顺序：`tab-list -> tab-select(人才银行/搜索页) -> snapshot确认筛选区 -> 应用模板筛选 -> 执行候选人评估`。
3. 仅当当前会话无可接管分页时，才新开可见窗口并复用 `data/maimai-browser-profile`；必要时 `state-load` 恢复登录态后进入人才银行。
4. 页面接管与后续操作必须使用同一会话、同一控制通道（禁止混用多套浏览器控制通道导致会话漂移）。

## 生产主链路（唯一权威流程）

### 阶段A：职位模板准备与复用

1. 与用户确认岗位要求，生成筛选建议与职位筛选策略。
2. 策略写入飞书职位模板，采用版本化命名（`模板基础名@vNNN`）。
3. 执行时优先拉取已存模板；未命中时再生成新版本。

### 阶段B：AI 接管筛选与评估

1. 打开 `https://maimai.cn/ent/v41/index` 并先检查登录态。
2. 未登录时暂停，等待用户登录后继续。
3. 进入“招人 -> 搜索”，由 AI 一次性应用指定模板的完整筛选条件（如关键词、城市地区、职位名称、行业方向、就职公司、年龄等），并做回读校验。
4. 联想控件（尤其 `职位名称`、`就职公司`）必须逐项执行“输入 -> 点击候选项”；禁止用 Enter/Tab/失焦作为选中兜底。
5. 筛选条件设置完成后，必须点击“搜索”按钮并确认结果已刷新；未点击“搜索”不得进入候选人评估（该项属于流程动作，不属于六项检查）。
6. 每位候选人必须执行六项业务检查：基础信息完整、硬性条件匹配、相关经验对口、职业稳定性可接受、求职意愿与沟通可达性明确、风险备注完整。
7. 六项检查结果仅表示“完整性是否通过”，不表示候选人质量是否通过：
   - 六项均已判断且有依据（允许出现负向判断）=> `六项检查结果=通过`；
   - 任一项未判断/留空/仅写未知或待补充/无依据 => `六项检查结果=不通过`。
8. 单项负向结论（如“低意向”“不匹配”）仍视为“已判断”，不会单独导致完整性不通过；是否进入白名单由业务结论决定。
9. 候选人评估完成后，必须写入字段 `六项检查结果` 和 `六项判断依据摘要`。
10. 六项检查必须逐项留痕：每项均需记录“单项结论（通过/不通过）+依据来源（卡片/详情/附件）”。
11. 按分页执行候选人评估：
   - 每页必须按卡片顺序逐一判定，禁止整页浏览后再回看。
   - 卡片明显不匹配：直接跳过。
   - 卡片初判为“可沟通/储备观察倾向”时进入详情页复核，最终结论以详情+附件复核后结果为准。
   - 详情判定必须按模板中的三维评估规则执行（`industry_core_background`、`party_a_core_background`、`domain_relevance`），并执行硬排除复判；命中硬排除时直接判定不合适。硬排除规则口径以 `references/filter-rules.md` 为准。
   - 不合适：不入库。
12. 每页评估结果只做本地汇总，不立即同步飞书。

### 阶段C：飞书同步与闭环

1. 候选人按页 `normalize` 并汇总，模板结束后统一 `sync-feishu`。
2. 同步准入采用双门槛：仅当 `六项检查结果=通过` 且 `结论=可沟通/储备观察` 时，允许进入飞书同步。双门槛顺序固定：先判完整性（六项检查结果），再判业务结论白名单。
3. 若 `六项检查结果=不通过`，必须回写未判断项、依据缺失原因与处理状态（`待人工复核`），本轮禁止同步该候选人。
4. 可沟通/储备观察且有附件简历时，必须在该候选人评估当下完成附件处理；若附件处理失败，当前候选人标记 `附件处理失败` 并转人工复核，不中断整模板执行。
5. 话术草稿默认只对 `可沟通` 生成，且仅写空字段（避免覆盖人工内容）。
6. 每个模板完成后回写执行结果（人数/状态/建议），再进入下一个模板。
7. 若模板未完成（人工暂停/异常中断），默认不执行候选人同步，等待人工确认。
8. 术语统一：字段值仅使用 `可沟通` / `储备观察` / `不合适`；“待定”仅作口语描述，不作为字段值。

## 输入输出契约（MVP）

### 输入

1. 职位模板运行态：`active-filter.runtime.json`
2. 筛选操作集：`active-filter.apply-ops.json`
3. 候选人原始数据（AI 接管产出或离线分页文件）

候选人记录至少包含：
`candidate_name`、`candidate_status`、`desired_position`、`education_summary`、`employment_history`、`has_attachment_resume`、`detail_reviewed`、`attachment_reviewed`、`score`、`conclusion`、`六项检查结果`、`六项判断依据摘要`
建议最小扩展字段：`六项单项结论JSON`、`六项单项依据JSON`、`未判断项清单`、`依据缺失原因`、`处理状态`。

### 输出

1. 候选人多维表模板级批量写入结果（仅白名单结论）。
2. 模板表执行结果回写（状态、结果数、建议、错误摘要）。
3. 会话汇总文件：`data/search-session.last.json`。

## 脚本状态表（治理）

| 脚本 | 状态 | 说明 |
|---|---|---|
| `run-search-session.js` | `active` | 生产主编排入口 |
| `run-filter-table-workflow.js` | `active` | 模板拉取、标记执行中、结果回写 |
| `run-maimai-filter-bridge.js` | `active` | 构建筛选操作、路径复用、健康度回传 |
| `run-candidate-pipeline.js` | `active` | 候选人标准化、白名单同步、话术草稿 |
| `sync-runtime-filter-to-feishu.js` | `active` | 模板条件版本化回写 |
| `generate-filter-template.js` | `active` | 从画像生成筛选模板草案 |
| `init-feishu-env.js` | `support` | 首次环境引导 |
| `setup-feishu-tables.js` | `support` | 多维表字段初始化 |
| `run-online-filter-cycle.js` | `maintenance` | 在线脚本筛选兜底（非默认） |
| `run-online-candidate-capture.js` | `maintenance` | 在线脚本采集兜底（非默认） |
| `run-memory-workflow.js` | `maintenance` | 学习模式与流程沉淀 |
| `capture-maimai-auth-state.js` | `maintenance` | 手动采集登录态 |
| `backfill-candidate-attachments.js` | `maintenance` | 历史附件补写 |
| `upgrade-filter-table-v2.js` | `maintenance` | 字段迁移工具 |
| `prune-filter-table-fields.js` | `maintenance` | 冗余字段清理 |
| `migrate-filter-table-schema.js` | `deprecated` | 历史迁移脚本，默认停用 |

治理源：`scripts/script-registry.json`。新增脚本必须先登记再进入流程。
归档策略：`maintenance/deprecated` 实现位于 `scripts/legacy/`，主目录同名文件为兼容入口。

## 推荐命令

### 1) HR 一键执行（推荐）

```bash
npm run skill:hrbp:run -- --template-names "目标岗位主模板A,目标岗位主模板B"
```

### 2) 主编排（高级模式）

```bash
node skills/maimai-recruiting-coach/scripts/run-search-session.js \
  --template-names "目标岗位主模板A,目标岗位主模板B" \
  --filter-base-url "<职位多维表URL>" \
  --candidate-base-url "<候选人多维表URL>" \
  --page-manifest "data/page-manifest.json" \
  --execution-mode realtime \
  --online-filter true \
  --humanize true \
  --greeting-only-for "可沟通" \
  --greeting-write-policy empty_only \
  --max-retry-per-page 2 \
  --pause-on-consecutive-page-failures 2
```

### 3) 模板策略生成与回写

```bash
node skills/maimai-recruiting-coach/scripts/generate-filter-template.js \
  --profile <profile.json> \
  --output data/generated-filter-template.runtime.json \
  --base-url "<筛选表URL>"
```

### 4) 脚本治理合规检查

```bash
node skills/maimai-recruiting-coach/scripts/audit-scripts.js --strict
```

## 人工接管触发条件

出现任一条件立即暂停自动化并转人工：
1. 验证码、访问受限、登录异常、风险提示。
2. 连续失败页数达到阈值（默认 2）。
3. 关键字段覆盖/回读校验失败且无法自动修复。

## 参考文档

按任务入口查看：
- `references/index.md`
- `references/ai-takeover-default.md`
- `references/maimai-workflow.md`
- `references/path-reuse-rules.md`
- `references/feishu-sync-rules.md`
- `references/filter-field-mapping.current.md`
- `references/filter-ui-operation-rules.md`
- `references/template-versioning-rules.md`
- `references/profile-to-filter-rules.md`
- `references/greeting-guardrails.md`
- `references/candidate-fields.md`
- `references/quick-validate.md`
- `references/hrbp-one-click-sop.md`
- `references/deprecation-ledger.md`

