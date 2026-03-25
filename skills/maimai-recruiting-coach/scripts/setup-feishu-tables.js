#!/usr/bin/env node
import {
  batchCreateRecords,
  createTableField,
  getTenantAccessToken,
  listTableFields,
  parseBitableUrl,
  updateTableField
} from "./lib/feishu-bitable.js";

const YES_NO_UNKNOWN_OPTIONS = {
  options: [
    { name: "是", color: 0 },
    { name: "否", color: 1 },
    { name: "未知", color: 2 }
  ]
};

const CONCLUSION_OPTIONS = {
  options: [
    { name: "可沟通", color: 0 },
    { name: "储备观察", color: 1 },
    { name: "不合适", color: 2 }
  ]
};

const DATA_STATUS_OPTIONS = {
  options: [
    { name: "已复核", color: 0 },
    { name: "待补全", color: 1 }
  ]
};

const FIELD_SOURCE_OPTIONS = {
  options: [
    { name: "详情页", color: 0 },
    { name: "附件简历", color: 1 },
    { name: "卡片(禁写核心字段)", color: 2 }
  ]
};

const CANDIDATE_FIELD_NAMES = [
  { name: "评估时间", type: 1 },
  { name: "年龄", type: 1 },
  { name: "状态情况", type: 1 },
  { name: "求职职位", type: 1 },
  { name: "学历情况", type: 1 },
  { name: "工作履历任职情况", type: 1 },
  { name: "履历中的工作内容和亮点", type: 1 },
  { name: "有无附件简历", type: 3, property: YES_NO_UNKNOWN_OPTIONS },
  { name: "附件简历附件", type: 17 },
  { name: "详情页已复核", type: 3, property: YES_NO_UNKNOWN_OPTIONS },
  { name: "附件简历已查看", type: 3, property: YES_NO_UNKNOWN_OPTIONS },
  { name: "职位匹配度", type: 1 },
  { name: "匹配度结构化", type: 1 },
  { name: "评分", type: 1 },
  { name: "结论", type: 3, property: CONCLUSION_OPTIONS },
  { name: "结论原因", type: 1 },
  { name: "打招呼话术草稿", type: 1 },
  { name: "职业标签", type: 1 },
  { name: "数据状态", type: 3, property: DATA_STATUS_OPTIONS },
  { name: "待补全原因", type: 1 },
  { name: "字段来源", type: 3, property: FIELD_SOURCE_OPTIONS },
  { name: "采集时间", type: 5 }
];

const FILTER_FIELD_NAMES = [
  { name: "模版名称", type: 1 },
  { name: "模版基础名", type: 1 },
  { name: "模版版本", type: 2 },
  { name: "父记录ID", type: 1 },
  { name: "变更摘要", type: 1 },
  { name: "职位需求", type: 1 },
  { name: "筛选策略", type: 1 },
  {
    name: "是否启用",
    type: 3,
    property: {
      options: [
        { name: "是", color: 0 },
        { name: "否", color: 1 }
      ]
    }
  },
  { name: "关键词", type: 1 },
  {
    name: "关键词逻辑(所有/任一)",
    type: 3,
    property: {
      options: [
        { name: "所有", color: 0 },
        { name: "任一", color: 1 }
      ]
    }
  },
  { name: "城市地区", type: 4 },
  { name: "学历要求", type: 3 },
  { name: "工作年限", type: 3 },
  { name: "就职公司", type: 1 },
  { name: "职位名称", type: 4 },
  { name: "行业方向", type: 4 },
  { name: "毕业学校", type: 1 },
  { name: "专业", type: 1 },
  { name: "性别", type: 3 },
  { name: "年龄", type: 3 },
  { name: "期望月薪", type: 3 },
  { name: "家乡", type: 4 },
  { name: "智能筛选_公开求职意向", type: 3 },
  { name: "智能筛选_近期有动向", type: 3 },
  { name: "智能筛选_有附件简历", type: 3 },
  { name: "智能筛选_有过意向", type: 3 },
  { name: "智能筛选_企业号互动", type: 3 },
  { name: "排序方式", type: 3 },
  { name: "招呼语要求", type: 1 },
  { name: "结果人数", type: 2 },
  { name: "结果摘要", type: 1 },
  { name: "执行状态", type: 3 },
  { name: "最近执行时间", type: 5 },
  { name: "异常原因", type: 1 },
  { name: "备注", type: 1 },

  // v2 结构化字段：用于完整表达脉脉“可自定义区间/二级状态”。
  { name: "筛选模式", type: 3 },
  { name: "筛选条件JSON", type: 1 },
  { name: "城市口径", type: 4 },
  { name: "城市地区_列表", type: 1 },
  { name: "学历_最低", type: 3 },
  { name: "学历_最高", type: 3 },
  { name: "工作年限_最低(年)", type: 2 },
  { name: "工作年限_最高(年)", type: 2 },
  { name: "工作年限_在校应届", type: 3 },
  { name: "年龄_最低", type: 2 },
  { name: "年龄_最高", type: 2 },
  { name: "期望月薪_最低K", type: 2 },
  { name: "期望月薪_最高K", type: 2 },
  { name: "就职公司_范围", type: 4 },
  { name: "就职公司_列表", type: 1 },
  { name: "智能筛选_公开求职意向_开关", type: 3 },
  { name: "智能筛选_公开求职意向_状态", type: 4 },
  { name: "智能筛选_近期有动向_开关", type: 3 },
  { name: "智能筛选_近期有动向_范围", type: 3 },
  { name: "智能筛选_有附件简历_开关", type: 3 },
  { name: "智能筛选_有过意向_开关", type: 3 },
  { name: "智能筛选_企业号互动_开关", type: 3 },
  { name: "智能筛选_企业号互动_类型", type: 4 }
];

const FILTER_EXAMPLE_ROWS = [
  {
    "模版名称": "行业背景-关键岗位-精准版@v001",
    "模版基础名": "行业背景-关键岗位-精准版",
    "模版版本": 1,
    "父记录ID": "",
    "变更摘要": "初始化示例模板",
    "职位需求": "目标岗位负责人；行业背景；近年甲方核心岗位经历；偏泛科技/互联网",
    "筛选策略":
      "must: 行业背景 + 甲方核心岗位经历\nnice: 科技互联网行业经历\nreject: 纯乙方咨询长期背景\n关键词逻辑: 任一，优先覆盖岗位词与核心经历词",
    "是否启用": "是",
    "关键词": "目标岗位总监 行业A 目标岗位负责人",
    "关键词逻辑(所有/任一)": "所有",
    "城市地区": "北京;上海;深圳",
    "学历要求": "本科及以上",
    "工作年限": "10年以上",
    "就职公司": "互联网/科技中大型企业优先",
    "职位名称": "目标岗位负责人;目标岗位总监;目标岗位负责人",
    "行业方向": "互联网;企业服务;软件;AI",
    "毕业学校": "",
    "专业": "目标岗位;专业A;行业研究;经济",
    "性别": "不限",
    "年龄": "40岁及以下(可放宽到42)",
    "期望月薪": "70k以上",
    "家乡": "",
    "智能筛选_公开求职意向": "是",
    "智能筛选_近期有动向": "是",
    "智能筛选_有附件简历": "是",
    "智能筛选_有过意向": "否",
    "智能筛选_企业号互动": "否",
    "排序方式": "匹配度优先",
    "结果人数": "",
    "结果摘要": "",
    "执行状态": "",
    "最近执行时间": "",
    "异常原因": "",
    "备注": "保密岗位，对外统一称高阶岗位"
  }
];

function parseArgs(rawArgs) {
  const parsed = { _: [] };
  for (let i = 0; i < rawArgs.length; i += 1) {
    const token = rawArgs[i];
    if (!token.startsWith("--")) {
      parsed._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = rawArgs[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    i += 1;
  }
  return parsed;
}

function pickFieldSet(profile) {
  if (profile === "candidate") {
    return CANDIDATE_FIELD_NAMES;
  }
  if (profile === "filter") {
    return FILTER_FIELD_NAMES;
  }
  throw new Error("profile 仅支持 candidate 或 filter");
}

async function ensureFields(tenantToken, appToken, tableId, fieldNames) {
  const existing = await listTableFields(tenantToken, appToken, tableId);
  const existingNames = new Set(existing.map((item) => item.field_name).filter(Boolean));
  const created = [];
  const renamed = [];

  // 针对历史筛选表做字段重命名：场景名称 -> 职位需求
  if (existingNames.has("场景名称") && !existingNames.has("职位需求")) {
    const legacyField = existing.find((item) => item.field_name === "场景名称");
    if (legacyField?.field_id) {
      await updateTableField(tenantToken, appToken, tableId, legacyField.field_id, {
        fieldName: "职位需求",
        type: Number(legacyField.type ?? 1)
      });
      existingNames.delete("场景名称");
      existingNames.add("职位需求");
      renamed.push("场景名称 -> 职位需求");
    }
  }

  for (const field of fieldNames) {
    const name = typeof field === "string" ? field : field.name;
    const type = typeof field === "string" ? 1 : Number(field.type ?? 1);
    const property = typeof field === "string" ? null : field.property ?? null;
    if (existingNames.has(name)) {
      continue;
    }
    await createTableField(tenantToken, appToken, tableId, name, type, property);
    created.push(name);
  }
  return {
    existing_count: existing.length,
    renamed_count: renamed.length,
    renamed_fields: renamed,
    created_count: created.length,
    created_fields: created
  };
}

async function seedFilterExamples(tenantToken, appToken, tableId, tableFields) {
  const names = new Set(tableFields.map((item) => item.field_name).filter(Boolean));
  const payload = FILTER_EXAMPLE_ROWS.map((row) => {
    const fields = {};
    for (const [k, v] of Object.entries(row)) {
      if (names.has(k)) {
        fields[k] = v;
      }
    }
    if (Object.keys(fields).length === 0 && names.has("文本")) {
      fields["文本"] = JSON.stringify(row);
    }
    return fields;
  }).filter((item) => Object.keys(item).length > 0);

  if (payload.length === 0) {
    return 0;
  }
  return await batchCreateRecords(tenantToken, appToken, tableId, payload);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command] = args._;
  if (!command || args.help || args.h) {
    // eslint-disable-next-line no-console
    console.log(
      "用法: node skills/maimai-recruiting-coach/scripts/setup-feishu-tables.js ensure-fields --profile <candidate|filter> --base-url <url> [--seed-example]"
    );
    process.exit(0);
  }

  if (command !== "ensure-fields") {
    throw new Error(`未知命令: ${command}`);
  }
  if (!args.profile || !args["base-url"]) {
    throw new Error("缺少 --profile 或 --base-url");
  }

  const appId = process.env.FEISHU_APP_ID ?? args["app-id"];
  const appSecret = process.env.FEISHU_APP_SECRET ?? args["app-secret"];
  if (!appId || !appSecret) {
    throw new Error("缺少 FEISHU_APP_ID / FEISHU_APP_SECRET");
  }

  const { appToken, tableId } = parseBitableUrl(args["base-url"]);
  if (!appToken || !tableId) {
    throw new Error("base-url 里缺少 app_token 或 table_id");
  }

  const token = await getTenantAccessToken(appId, appSecret);
  const profileFields = pickFieldSet(args.profile);
  const ensureResult = await ensureFields(token, appToken, tableId, profileFields);
  const refreshedFields = await listTableFields(token, appToken, tableId);

  let seeded = 0;
  if (args["seed-example"] && args.profile === "filter") {
    seeded = await seedFilterExamples(token, appToken, tableId, refreshedFields);
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        mode: "ensure-fields",
        profile: args.profile,
        app_token: appToken,
        table_id: tableId,
        ...ensureResult,
        total_fields_after: refreshedFields.length,
        seeded_example_rows: seeded
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`执行失败: ${error.message}`);
  process.exit(1);
});


