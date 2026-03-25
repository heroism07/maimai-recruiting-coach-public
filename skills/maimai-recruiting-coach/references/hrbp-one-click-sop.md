# HR 一键执行 SOP（可直接照跑）

更新时间：2026-03-24

## 目标

让非技术同学用最少命令完成“模板筛选 -> 候选人评估 -> 飞书同步”。

## 首次准备（只做一次）

1. 先配置飞书和运行参数：

```bash
node skills/maimai-recruiting-coach/scripts/init-feishu-env.js
```

2. 检查 `data/maimai-runtime-config.json` 是否包含：
- `filter_base_url`
- `candidate_base_url`
- `maimai_list_url`
- `browser_profile_dir`（建议 `data/maimai-browser-profile`）

## 日常执行（推荐）

### 方式A：指定模板列表

```bash
npm run skill:hrbp:run -- --template-names "目标岗位主模板A,目标岗位主模板B"
```

### 方式B：自动拉取启用模板

```bash
npm run skill:hrbp:run -- --use-existing-templates true --template-limit 3
```

## 一键命令会自动带上的安全默认值

1. `execution-mode=realtime`
2. `online-filter=true`
3. `humanize=true`
4. `greeting-only-for=可沟通`
5. `greeting-write-policy=empty_only`
6. `max-retry-per-page=2`
7. `pause-on-consecutive-page-failures=2`

## 候选人同步策略（当前默认）

1. 每页仅执行评估与汇总，不即时入库。  
2. 每位候选人评估后必须写入字段 `六项检查结果`，取值仅允许 `通过` / `不通过`。  
3. 当前模板全部页面评估完成后，一次性同步 `可沟通`、`储备观察` 到飞书，且仅同步 `六项检查结果=通过` 的候选人。  
4. 可沟通/储备观察且有附件简历的候选人，必须在该候选人评估当下完成附件处理，不得整页评估后回头补处理。  
5. 若中途暂停/异常，默认不自动同步，等待人工确认。  
6. 若 `六项检查结果=不通过`，必须回写未判断项与依据缺失原因，并标记 `待人工复核`，本轮禁止同步该候选人。  

## 同步前六项检查（业务口径）

执行口诀：先看“六项是否都判断了”，再看“结论是否在白名单”。
说明：`通过` 仅表示完整性通过，不等于候选人质量通过。

1. 基础信息是否完整（至少可用于后续联系与判断）。  
2. 硬性条件是否匹配（年限/行业/职级等岗位硬条件）。  
3. 相关经验是否对口（与目标岗位核心职责匹配）。  
4. 职业稳定性是否可接受（关键经历连续性与合理性）。  
5. 求职意愿与沟通可达性是否明确。  
6. 风险备注是否完整（疑点、冲突点、待核实点是否写清）。  

## 运行中人工接管规则

出现以下情况立即接管：
1. 验证码或风控提示。
2. 登录异常无法恢复。
3. 连续页面失败达到阈值。

## 执行后检查

1. 查看会话汇总：`data/search-session.last.json`
2. 核对候选人记录中 `六项检查结果` 是否已写入，且仅出现 `通过` / `不通过`。  
3. 核对本轮同步名单是否全部满足：`结论=可沟通/储备观察` 且 `六项检查结果=通过`。  
4. 抽检六项判断依据是否完整；无依据项按未判断处理，并将该候选人 `六项检查结果` 置为 `不通过`。  
5. 运行治理合规检查：

```bash
npm run skill:audit:scripts
```

