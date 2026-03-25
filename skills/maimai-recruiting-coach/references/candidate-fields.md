# 候选人返回字段规范（可对接飞书多维表格）

## 目标

将每位候选人的评估结果统一结构化输出，便于：

1. 自动留档（包含不合适候选人）。
2. 接入飞书多维表格。
3. 后续复盘和策略优化。

## 标准字段

- `candidate_name`: 候选人姓名
- `employment_history`: 工作履历的任职情况（公司/职位/时间）
- `employment_highlights`: 履历中的工作内容和亮点（数组）
- `education_summary`: 学历情况（学校 + 学历 + 在校时间整合展示）
- `desired_position`: 求职职位
- `candidate_status`: 状态情况（含动态明细，如“近期有动向（更改求职状态为正在看机会 3月5日；活跃值提升 2月2日）”）
- `status_change_detail`: 状态动态明细文本（优先于 `status_change_date`）
- `age`: 年龄（未知可为 `null`）
- `position_match_note`: 职位匹配度说明（含行业核心背景 + 甲方核心岗位背景）
- `position_match_levels.industry_core_background`: 行业核心背景强弱
- `position_match_levels.party_a_core_background`: 甲方核心岗位背景强弱
- `position_match_levels.domain_relevance`: 科技互联网相关性强弱
- `score`: 评分（0-100）
- `conclusion`: 结论（可沟通 / 储备观察 / 不合适）
- `conclusion_reason`: 结论理由（不合适也必须填写）
- `six_check_result`: 六项检查结果（通过 / 不通过，完整性字段）
- `six_check_basis`: 六项判断依据摘要（文本；缺失任一项依据视为未完成）
- `has_attachment_resume`: 有无附件简历
- `attachment_resume_local_path`: 可选，本地 PDF 简历路径（优先上传该文件）
- `tags`: 职业标签（写入“职业标签”字段）
- `detail_reviewed`: 是否已进详情页复核
- `attachment_reviewed`: 若有附件，是否已预览附件简历

字段语义补充：
1. `six_check_result=通过` 仅表示六项均已判断且有依据，不表示候选人质量通过。
2. 单项可为负向判断（如低意向），仍计入“已判断”。
3. `six_check_result` 与 `conclusion`（业务结论）解耦管理。

## 命令行

1. 标准化并输出 JSON：

```bash
node skills/maimai-recruiting-coach/scripts/run-candidate-pipeline.js normalize \
  --input examples/candidate-assessments-page1.raw.json \
  --output data/candidate-evaluations.normalized.json \
  --append-ndjson
```

2. 同步飞书多维表格（字段按别名自动映射）：

```bash
set FEISHU_APP_ID=你的AppID
set FEISHU_APP_SECRET=你的AppSecret
node skills/maimai-recruiting-coach/scripts/run-candidate-pipeline.js sync-feishu \
  --input data/candidate-evaluations.normalized.json \
  --base-url "https://xxx.feishu.cn/base/xxxx?table=tblxxxx&view=vewxxxx" \
  --greeting-from-template \
  --filter-base-url "https://xxx.feishu.cn/base/xxxx?table=筛选模板表ID&view=视图ID" \
  --template-name "关键岗位模板0323"
```

建议先加 `--dry-run` 验证映射结果，再正式写入。


## 2026-03-25 标准样例（关键岗位，校正版）

候选人：毛玉娇  
状态情况：近1月活跃；正在看机会；近期有动向（2026-03-24）  
求职职位：北京·60k-90k·董事会秘书/核心岗位负责人/目标岗位总监  
学历情况：上海交通大学 硕士(行业研究学)（硕士 2011-2014）；上海交通大学 本科(专业背景A)（本科 2007-2011）  
工作履历任职情况：商汤科技｜目标岗位负责人执行助理｜2023-至今；商汤科技｜投资总监｜2018-2023；摩根士丹利证券｜分析师｜2014-2017  
履历中的工作内容和亮点：投资与行业B市场履历突出，科技行业相关性强；现岗位为目标岗位负责人执行助理，需确认独立目标岗位负责人能力；有附件简历且已预览，建议在终面重点核验“独立核心岗位一号位”经验。  
职业标签：目标岗位负责人；关键项目；行业B运作

补充约束：
1. 工作履历任职情况必须使用“公司｜职位｜任职时间”三元组。
2. 履历中的工作内容和亮点必须写清“与岗位匹配原因”。
3. 主求职方向明显偏离岗位主线时，必须在结论原因中显式说明。
4. 可沟通/储备观察且有附件时，需写明附件状态（已预览/已下载）。


