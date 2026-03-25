#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import {
  createTableField,
  getTenantAccessToken,
  listTableFields,
  listTableRecords,
  parseBitableUrl
} from "../lib/feishu-bitable.js";
import { buildVersionedTemplateName, parseTemplateVersionName } from "../lib/template-version.js";

const FEISHU_OPEN_API = "https://open.feishu.cn/open-apis";

const STRUCTURED_FIELDS = [
  { name: "模版基础名", type: 1 },
  { name: "模版版本", type: 2 },
  { name: "父记录ID", type: 1 },
  { name: "变更摘要", type: 1 },
  { name: "职位需求", type: 1 },
  { name: "筛选策略", type: 1 },
  { name: "筛选模式", type: 3, options: ["结构化模式(新字段优先)", "兼容模式(旧字段)"] },
  { name: "筛选条件JSON", type: 1 },
  { name: "招呼语要求", type: 1 },
  { name: "城市口径", type: 4, options: ["期望", "现居"] },
  { name: "城市地区_列表", type: 1 },
  { name: "学历_最低", type: 3, options: ["不限", "专科", "本科", "硕士", "博士"] },
  { name: "学历_最高", type: 3, options: ["不限", "专科", "本科", "硕士", "博士"] },
  { name: "工作年限_最低(年)", type: 2 },
  { name: "工作年限_最高(年)", type: 2 },
  { name: "工作年限_在校应届", type: 3, options: ["默认(不筛选)", "是"] },
  { name: "年龄_最低", type: 2 },
  { name: "年龄_最高", type: 2 },
  { name: "期望月薪_最低K", type: 2 },
  { name: "期望月薪_最高K", type: 2 },
  { name: "就职公司_范围", type: 4, options: ["正任职", "曾任职"] },
  { name: "就职公司_列表", type: 1 },
  { name: "智能筛选_公开求职意向_开关", type: 3, options: ["默认(不筛选)", "启用"] },
  {
    name: "智能筛选_公开求职意向_状态",
    type: 4,
    options: ["正在看机会", "关注行情", "半年不看机会"]
  },
  { name: "智能筛选_近期有动向_开关", type: 3, options: ["默认(不筛选)", "启用"] },
  { name: "智能筛选_近期有动向_范围", type: 3, options: ["近7天", "近14天", "近1个月", "近3个月"] },
  { name: "智能筛选_有附件简历_开关", type: 3, options: ["默认(不筛选)", "启用"] },
  { name: "智能筛选_有过意向_开关", type: 3, options: ["默认(不筛选)", "启用"] },
  { name: "智能筛选_企业号互动_开关", type: 3, options: ["默认(不筛选)", "启用"] },
  {
    name: "智能筛选_企业号互动_类型",
    type: 4,
    options: ["企业号粉丝", "企业职位互动", "企业动态互动", "精准营销推广"]
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

function normalizeText(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeText(item)).filter(Boolean).join(";");
  }
  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return value.text.trim();
    }
    if (typeof value.name === "string") {
      return value.name.trim();
    }
  }
  return "";
}

function parseNumberFromText(text) {
  const n = Number(text);
  if (Number.isFinite(n)) {
    return n;
  }
  return null;
}

function extractLegacyList(value) {
  const text = normalizeText(value);
  if (!text) {
    return [];
  }
  return text
    .split(/[;；,，、|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function deriveYears(raw) {
  const text = normalizeText(raw);
  const result = {
    min: null,
    max: null,
    campus: "默认(不筛选)"
  };
  if (!text) {
    return result;
  }
  if (text.includes("在校") || text.includes("应届")) {
    result.campus = "是";
    return result;
  }
  const between = text.match(/(\d+)\s*[-~～到至]\s*(\d+)/);
  if (between) {
    result.min = parseNumberFromText(between[1]);
    result.max = parseNumberFromText(between[2]);
    return result;
  }
  const gte = text.match(/(\d+)\s*年?\s*以?上/);
  if (gte) {
    result.min = parseNumberFromText(gte[1]);
    return result;
  }
  const lte = text.match(/(\d+)\s*年?\s*以内?/);
  if (lte) {
    result.max = parseNumberFromText(lte[1]);
    return result;
  }
  const single = text.match(/^\d+$/);
  if (single) {
    result.min = parseNumberFromText(text);
    result.max = parseNumberFromText(text);
  }
  return result;
}

function deriveAge(raw) {
  const text = normalizeText(raw);
  const result = { min: null, max: null };
  if (!text) {
    return result;
  }
  const between = text.match(/(\d+)\s*[-~～到至]\s*(\d+)\s*岁?/);
  if (between) {
    result.min = parseNumberFromText(between[1]);
    result.max = parseNumberFromText(between[2]);
    return result;
  }
  const gte = text.match(/(\d+)\s*岁?\s*以?上/);
  if (gte) {
    result.min = parseNumberFromText(gte[1]);
    return result;
  }
  const lte = text.match(/(\d+)\s*岁?\s*及?以下/);
  if (lte) {
    result.max = parseNumberFromText(lte[1]);
    return result;
  }
  const single = text.match(/(\d+)\s*岁/);
  if (single) {
    result.min = parseNumberFromText(single[1]);
    result.max = parseNumberFromText(single[1]);
  }
  return result;
}

function deriveSalaryK(raw) {
  const text = normalizeText(raw).toLowerCase();
  const result = { minK: null, maxK: null };
  if (!text) {
    return result;
  }
  const between = text.match(/(\d+)\s*k?\s*[-~～到至]\s*(\d+)\s*k?/i);
  if (between) {
    result.minK = parseNumberFromText(between[1]);
    result.maxK = parseNumberFromText(between[2]);
    return result;
  }
  const gte = text.match(/(\d+)\s*k?\s*以?上/i);
  if (gte) {
    result.minK = parseNumberFromText(gte[1]);
    return result;
  }
  const lte = text.match(/(\d+)\s*k?\s*以?下/i);
  if (lte) {
    result.maxK = parseNumberFromText(lte[1]);
    return result;
  }
  return result;
}

function deriveEducation(raw) {
  const text = normalizeText(raw);
  const result = { min: "", max: "" };
  if (!text) {
    return result;
  }
  if (text.includes("不限")) {
    result.min = "不限";
    result.max = "不限";
    return result;
  }
  if (text.includes("博士")) {
    if (text.includes("及以上")) {
      result.min = "博士";
      result.max = "不限";
      return result;
    }
    result.min = "博士";
    result.max = "博士";
    return result;
  }
  if (text.includes("硕士")) {
    result.min = "硕士";
    result.max = text.includes("及以上") ? "不限" : "硕士";
    return result;
  }
  if (text.includes("本科")) {
    result.min = "本科";
    result.max = text.includes("及以上") ? "不限" : "本科";
    return result;
  }
  if (text.includes("专科") || text.includes("大专")) {
    result.min = "专科";
    result.max = text.includes("及以上") ? "不限" : "专科";
  }
  return result;
}

function mapSwitch(raw) {
  const text = normalizeText(raw).toLowerCase();
  if (text === "是" || text === "true" || text === "1" || text === "启用") {
    return "启用";
  }
  return "默认(不筛选)";
}

function buildSelectProperty(options) {
  const deduped = [];
  const seen = new Set();
  for (const item of options) {
    const text = normalizeText(item);
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    deduped.push(text);
  }
  return {
    options: deduped.map((name, index) => ({
      name,
      color: index % 54
    }))
  };
}

async function requestJsonWithAuth(url, method, tenantAccessToken, body = null) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  if (payload.code !== 0) {
    throw new Error(`code=${payload.code}, msg=${payload.msg ?? "unknown"}`);
  }
  return payload;
}

async function updateFieldDefinition(tenantAccessToken, appToken, tableId, fieldId, fieldName, type, property) {
  const body = {
    field_name: fieldName,
    type
  };
  if (property && typeof property === "object") {
    body.property = property;
  }
  await requestJsonWithAuth(
    `${FEISHU_OPEN_API}/bitable/v1/apps/${appToken}/tables/${tableId}/fields/${fieldId}`,
    "PUT",
    tenantAccessToken,
    body
  );
}

async function batchUpdateRecords(tenantAccessToken, appToken, tableId, updates, batchSize = 100) {
  let total = 0;
  for (let i = 0; i < updates.length; i += batchSize) {
    const chunk = updates.slice(i, i + batchSize);
    await requestJsonWithAuth(
      `${FEISHU_OPEN_API}/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_update`,
      "POST",
      tenantAccessToken,
      { records: chunk }
    );
    total += chunk.length;
  }
  return total;
}

async function ensureStructuredFields(tenantToken, appToken, tableId, fields) {
  const existing = await listTableFields(tenantToken, appToken, tableId);
  const existingByName = new Map(existing.map((f) => [f.field_name, f]));
  const actions = [];

  for (const field of fields) {
    const old = existingByName.get(field.name);
    const property = field.options ? buildSelectProperty(field.options) : null;
    if (!old) {
      const created = await createTableField(
        tenantToken,
        appToken,
        tableId,
        field.name,
        field.type,
        property
      );
      actions.push({
        action: "created",
        field_name: field.name,
        field_id: created?.field_id ?? "",
        from_type: null,
        to_type: field.type
      });
      continue;
    }

    const sameType = Number(old.type) === Number(field.type);
    if (sameType && !field.options) {
      actions.push({
        action: "kept",
        field_name: field.name,
        field_id: old.field_id,
        from_type: old.type,
        to_type: field.type
      });
      continue;
    }

    if (!sameType || field.options) {
      await updateFieldDefinition(
        tenantToken,
        appToken,
        tableId,
        old.field_id,
        field.name,
        field.type,
        property
      );
      actions.push({
        action: sameType ? "updated_property" : "updated_type",
        field_name: field.name,
        field_id: old.field_id,
        from_type: old.type,
        to_type: field.type
      });
    }
  }

  return actions;
}

function buildStructuredPayload(fields) {
  const payload = {};
  const positionRequirement = normalizeText(fields["职位需求"] || fields["场景名称"]);
  if (positionRequirement) {
    payload["职位需求"] = positionRequirement;
  }
  const strategyText = normalizeText(fields["筛选策略"]);
  if (strategyText) {
    payload["筛选策略"] = strategyText;
  }
  const rawTemplate = normalizeText(
    fields["模版名称"] || fields["模板名称"] || fields["模版基础名"] || fields["场景名称"]
  );
  if (rawTemplate) {
    const parsed = parseTemplateVersionName(rawTemplate);
    const baseName = parsed.base_name || rawTemplate;
    const version = parsed.version || 1;
    payload["模版基础名"] = baseName;
    payload["模版版本"] = version;
    payload["模版名称"] = buildVersionedTemplateName(baseName, version);
  }

  const cityValues = Array.isArray(fields["城市地区"])
    ? fields["城市地区"]
    : extractLegacyList(fields["城市地区"]);
  if (cityValues.length > 0) {
    payload["城市口径"] = ["期望", "现居"];
    payload["城市地区_列表"] = cityValues.join(";");
  }

  const education = deriveEducation(fields["学历要求"]);
  if (education.min) payload["学历_最低"] = education.min;
  if (education.max) payload["学历_最高"] = education.max;

  const years = deriveYears(fields["工作年限"]);
  if (years.min !== null) payload["工作年限_最低(年)"] = years.min;
  if (years.max !== null) payload["工作年限_最高(年)"] = years.max;
  payload["工作年限_在校应届"] = years.campus;

  const age = deriveAge(fields["年龄"]);
  if (age.min !== null) payload["年龄_最低"] = age.min;
  if (age.max !== null) payload["年龄_最高"] = age.max;

  const salary = deriveSalaryK(fields["期望月薪"]);
  if (salary.minK !== null) payload["期望月薪_最低K"] = salary.minK;
  if (salary.maxK !== null) payload["期望月薪_最高K"] = salary.maxK;

  const companyText = normalizeText(fields["就职公司"]);
  if (companyText) {
    payload["就职公司_范围"] = ["正任职", "曾任职"];
    payload["就职公司_列表"] = companyText;
  }

  payload["智能筛选_公开求职意向_开关"] = mapSwitch(fields["智能筛选_公开求职意向"]);
  if (payload["智能筛选_公开求职意向_开关"] === "启用") {
    payload["智能筛选_公开求职意向_状态"] = ["正在看机会", "关注行情", "半年不看机会"];
  }

  payload["智能筛选_近期有动向_开关"] = mapSwitch(fields["智能筛选_近期有动向"]);
  if (payload["智能筛选_近期有动向_开关"] === "启用") {
    payload["智能筛选_近期有动向_范围"] = "近3个月";
  }

  payload["智能筛选_有附件简历_开关"] = mapSwitch(fields["智能筛选_有附件简历"]);
  payload["智能筛选_有过意向_开关"] = mapSwitch(fields["智能筛选_有过意向"]);
  payload["智能筛选_企业号互动_开关"] = mapSwitch(fields["智能筛选_企业号互动"]);
  if (payload["智能筛选_企业号互动_开关"] === "启用") {
    payload["智能筛选_企业号互动_类型"] = [
      "企业号粉丝",
      "企业职位互动",
      "企业动态互动",
      "精准营销推广"
    ];
  }

  payload["筛选模式"] = "结构化模式(新字段优先)";
  payload["筛选条件JSON"] = JSON.stringify(
    {
      source: "legacy-to-structured",
      migrated_at: new Date().toISOString(),
      legacy: {
        城市地区: normalizeText(fields["城市地区"]),
        学历要求: normalizeText(fields["学历要求"]),
        工作年限: normalizeText(fields["工作年限"]),
        就职公司: normalizeText(fields["就职公司"]),
        年龄: normalizeText(fields["年龄"]),
        期望月薪: normalizeText(fields["期望月薪"])
      }
    },
    null,
    0
  );

  return payload;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args["base-url"] ?? process.env.BASE_URL;
  const appId = args["app-id"] ?? process.env.FEISHU_APP_ID;
  const appSecret = args["app-secret"] ?? process.env.FEISHU_APP_SECRET;
  const dryRun = Boolean(args["dry-run"]);
  const output = args.output ?? "./data/feishu-filter-table-v2-upgrade.report.json";

  if (!baseUrl || !appId || !appSecret) {
    throw new Error("缺少 base-url / app-id / app-secret（可使用环境变量）");
  }

  const { appToken, tableId, viewId } = parseBitableUrl(baseUrl);
  if (!appToken || !tableId) {
    throw new Error("base-url 解析失败，缺少 app_token 或 table_id");
  }

  const token = await getTenantAccessToken(appId, appSecret);
  const records = await listTableRecords(token, appToken, tableId, {
    pageSize: 500,
    viewId
  });

  const schemaActions = dryRun ? [] : await ensureStructuredFields(token, appToken, tableId, STRUCTURED_FIELDS);

  const updates = [];
  for (const record of records) {
    const fields = record.fields ?? {};
    const structuredPayload = buildStructuredPayload(fields);
    if (Object.keys(structuredPayload).length > 0) {
      updates.push({
        record_id: record.record_id,
        fields: structuredPayload
      });
    }
  }

  let updatedCount = 0;
  if (!dryRun && updates.length > 0) {
    updatedCount = await batchUpdateRecords(token, appToken, tableId, updates, 100);
  }

  const report = {
    app_token: appToken,
    table_id: tableId,
    dry_run: dryRun,
    executed_at: new Date().toISOString(),
    schema_action_count: schemaActions.length,
    schema_actions: schemaActions,
    record_count: records.length,
    updates_prepared: updates.length,
    updated_count: updatedCount
  };

  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`执行失败: ${error.message}`);
  process.exit(1);
});

