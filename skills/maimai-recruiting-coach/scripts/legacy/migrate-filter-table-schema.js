#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import {
  createTableField,
  getTenantAccessToken,
  listTableFields,
  listTableRecords,
  parseBitableUrl
} from "../lib/feishu-bitable.js";

const FEISHU_OPEN_API = "https://open.feishu.cn/open-apis";

const SINGLE_SELECT_FIELDS = {
  "是否启用": ["是", "否"],
  "关键词逻辑(所有/任一)": ["所有", "任一"],
  "学历要求": ["不限", "大专及以上", "本科及以上", "硕士及以上", "博士及以上"],
  "工作年限": ["不限", "3年以上", "5年以上", "8年以上", "10年以上", "15年以上"],
  "性别": ["不限", "男", "女"],
  "年龄": ["不限", "30岁及以下", "35岁及以下", "40岁及以下", "45岁及以下"],
  "期望月薪": ["不限", "20k以上", "30k以上", "50k以上", "70k以上", "100k以上"],
  "智能筛选_公开求职意向": ["是", "否"],
  "智能筛选_近期有动向": ["是", "否"],
  "智能筛选_有附件简历": ["是", "否"],
  "智能筛选_有过意向": ["是", "否"],
  "智能筛选_企业号互动": ["是", "否"],
  "排序方式": ["匹配度优先", "活跃度优先", "最近更新优先"],
  "执行状态": ["running", "success", "failed"]
};

const MULTI_SELECT_FIELDS = {
  "城市地区": ["北京", "上海", "深圳", "广州", "杭州", "苏州", "南京", "成都", "武汉"],
  "职位名称": ["目标岗位负责人", "目标岗位总监", "目标岗位负责人", "业务经理", "FP&A", "资金总监"],
  "行业方向": [
    "互联网",
    "企业服务",
    "计算机软件",
    "云计算/大数据/人工智能",
    "制造业",
    "消费品",
    "医药医疗",
    "新能源"
  ],
  "家乡": []
};

const TEXT_FIELDS = [
  "职位需求",
  "筛选策略",
  "场景名称",
  "关键词",
  "就职公司",
  "毕业学校",
  "专业",
  "结果摘要",
  "异常原因",
  "备注"
];
const NUMBER_FIELDS = ["结果人数"];
const DATETIME_FIELDS = ["最近执行时间"];

const YES_VALUES = new Set(["是", "true", "1", "yes", "y", "启用"]);
const NO_VALUES = new Set(["否", "false", "0", "no", "n", "禁用"]);
const MULTI_DELIMITER = /[;；,，、|]/;

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

function normalizeString(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeString(item)).filter(Boolean).join(";");
  }
  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return value.text.trim();
    }
    if (typeof value.name === "string") {
      return value.name.trim();
    }
    return "";
  }
  return String(value);
}

function normalizeSingleValue(fieldName, value) {
  const text = normalizeString(value);
  if (!text) {
    return "";
  }
  if (fieldName === "是否启用") {
    const lower = text.toLowerCase();
    if (YES_VALUES.has(lower)) {
      return "是";
    }
    if (NO_VALUES.has(lower)) {
      return "否";
    }
  }
  if (fieldName.startsWith("智能筛选_")) {
    const lower = text.toLowerCase();
    if (YES_VALUES.has(lower)) {
      return "是";
    }
    if (NO_VALUES.has(lower)) {
      return "否";
    }
  }
  return text;
}

function parseMultiValues(value) {
  const text = normalizeString(value);
  if (!text) {
    return [];
  }
  return text
    .split(MULTI_DELIMITER)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeNumberValue(value) {
  const text = normalizeString(value);
  if (!text) {
    return null;
  }
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return numeric;
}

function normalizeDateValue(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const text = normalizeString(value);
  if (!text) {
    return null;
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) {
    return null;
  }
  return ms;
}

function dedupeOptions(list) {
  const seen = new Set();
  const result = [];
  for (const item of list) {
    const text = normalizeString(item);
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    result.push(text);
  }
  return result;
}

function buildSelectProperty(optionNames) {
  const options = dedupeOptions(optionNames).map((name, index) => ({
    name,
    color: index % 54
  }));
  return { options };
}

async function requestJsonWithAuth(url, method, tenantAccessToken, body) {
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
    throw new Error(`HTTP ${response.status} ${text}`);
  }
  if (payload.code !== 0) {
    throw new Error(`code=${payload.code}, msg=${payload.msg ?? "unknown"}, body=${text}`);
  }
  return payload;
}

async function updateFieldDefinition(tenantAccessToken, appToken, tableId, fieldId, fieldName, type, property) {
  const payload = {
    field_name: fieldName,
    type
  };
  if (property && typeof property === "object") {
    payload.property = property;
  }
  await requestJsonWithAuth(
    `${FEISHU_OPEN_API}/bitable/v1/apps/${appToken}/tables/${tableId}/fields/${fieldId}`,
    "PUT",
    tenantAccessToken,
    payload
  );
}

async function batchUpdateRecords(tenantAccessToken, appToken, tableId, updates, batchSize = 100) {
  let updated = 0;
  for (let i = 0; i < updates.length; i += batchSize) {
    const batch = updates.slice(i, i + batchSize);
    await requestJsonWithAuth(
      `${FEISHU_OPEN_API}/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_update`,
      "POST",
      tenantAccessToken,
      {
        records: batch
      }
    );
    updated += batch.length;
  }
  return updated;
}

async function ensureField(tenantAccessToken, appToken, tableId, existingByName, fieldName, type, property) {
  const existing = existingByName.get(fieldName);
  if (!existing) {
    const created = await createTableField(tenantAccessToken, appToken, tableId, fieldName, type, property);
    return {
      action: "created",
      field_name: fieldName,
      field_id: created?.field_id ?? "",
      from_type: null,
      to_type: type
    };
  }

  const sameType = Number(existing.type) === Number(type);
  if (sameType && (type === 1 || type === 2 || type === 5)) {
    return {
      action: "kept",
      field_name: fieldName,
      field_id: existing.field_id,
      from_type: existing.type,
      to_type: type
    };
  }

  await updateFieldDefinition(
    tenantAccessToken,
    appToken,
    tableId,
    existing.field_id,
    fieldName,
    type,
    property
  );
  return {
    action: sameType ? "updated_property" : "updated_type",
    field_name: fieldName,
    field_id: existing.field_id,
    from_type: existing.type,
    to_type: type
  };
}

function optionsFromRecordsForSingle(records, fieldName) {
  const values = [];
  for (const record of records) {
    const normalized = normalizeSingleValue(fieldName, record.fields?.[fieldName]);
    if (normalized) {
      values.push(normalized);
    }
  }
  return values;
}

function optionsFromRecordsForMulti(records, fieldName) {
  const values = [];
  for (const record of records) {
    const tokens = parseMultiValues(record.fields?.[fieldName]);
    for (const token of tokens) {
      values.push(token);
    }
  }
  return values;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args["base-url"] ?? process.env.BASE_URL;
  const appId = args["app-id"] ?? process.env.FEISHU_APP_ID;
  const appSecret = args["app-secret"] ?? process.env.FEISHU_APP_SECRET;
  const dryRun = Boolean(args["dry-run"]);
  const outputPath = args.output ?? "./data/feishu-filter-migration.report.json";

  if (!baseUrl || !appId || !appSecret) {
    throw new Error("缺少 base-url / app-id / app-secret（也可用环境变量）");
  }

  const { appToken, tableId } = parseBitableUrl(baseUrl);
  if (!appToken || !tableId) {
    throw new Error("base-url 解析失败，缺少 app_token 或 table_id");
  }

  const token = await getTenantAccessToken(appId, appSecret);
  const beforeFields = await listTableFields(token, appToken, tableId);
  const records = await listTableRecords(token, appToken, tableId, { pageSize: 500 });
  const existingByName = new Map(beforeFields.map((field) => [field.field_name, field]));

  const schemaActions = [];

  for (const fieldName of TEXT_FIELDS) {
    if (dryRun) {
      const oldType = existingByName.get(fieldName)?.type ?? null;
      schemaActions.push({
        action: oldType === null ? "would_create" : oldType === 1 ? "would_keep" : "would_update_type",
        field_name: fieldName,
        from_type: oldType,
        to_type: 1
      });
      continue;
    }
    schemaActions.push(await ensureField(token, appToken, tableId, existingByName, fieldName, 1, null));
  }

  for (const fieldName of NUMBER_FIELDS) {
    if (dryRun) {
      const oldType = existingByName.get(fieldName)?.type ?? null;
      schemaActions.push({
        action: oldType === null ? "would_create" : oldType === 2 ? "would_keep" : "would_update_type",
        field_name: fieldName,
        from_type: oldType,
        to_type: 2
      });
      continue;
    }
    schemaActions.push(await ensureField(token, appToken, tableId, existingByName, fieldName, 2, null));
  }

  for (const fieldName of DATETIME_FIELDS) {
    if (dryRun) {
      const oldType = existingByName.get(fieldName)?.type ?? null;
      schemaActions.push({
        action: oldType === null ? "would_create" : oldType === 5 ? "would_keep" : "would_update_type",
        field_name: fieldName,
        from_type: oldType,
        to_type: 5
      });
      continue;
    }
    schemaActions.push(await ensureField(token, appToken, tableId, existingByName, fieldName, 5, null));
  }

  for (const [fieldName, baseOptions] of Object.entries(SINGLE_SELECT_FIELDS)) {
    const observed = optionsFromRecordsForSingle(records, fieldName);
    const property = buildSelectProperty([...baseOptions, ...observed]);
    if (dryRun) {
      const oldType = existingByName.get(fieldName)?.type ?? null;
      schemaActions.push({
        action: oldType === null ? "would_create" : oldType === 3 ? "would_update_property" : "would_update_type",
        field_name: fieldName,
        from_type: oldType,
        to_type: 3,
        option_count: property.options.length
      });
      continue;
    }
    schemaActions.push(await ensureField(token, appToken, tableId, existingByName, fieldName, 3, property));
  }

  for (const [fieldName, baseOptions] of Object.entries(MULTI_SELECT_FIELDS)) {
    const observed = optionsFromRecordsForMulti(records, fieldName);
    const property = buildSelectProperty([...baseOptions, ...observed]);
    if (dryRun) {
      const oldType = existingByName.get(fieldName)?.type ?? null;
      schemaActions.push({
        action: oldType === null ? "would_create" : oldType === 4 ? "would_update_property" : "would_update_type",
        field_name: fieldName,
        from_type: oldType,
        to_type: 4,
        option_count: property.options.length
      });
      continue;
    }
    schemaActions.push(await ensureField(token, appToken, tableId, existingByName, fieldName, 4, property));
  }

  let updatedRecordCount = 0;
  const recordUpdates = [];
  if (!dryRun) {
    for (const record of records) {
      const fields = {};

      for (const fieldName of NUMBER_FIELDS) {
        const value = normalizeNumberValue(record.fields?.[fieldName]);
        if (value !== null) {
          fields[fieldName] = value;
        }
      }

      for (const fieldName of DATETIME_FIELDS) {
        const value = normalizeDateValue(record.fields?.[fieldName]);
        if (value !== null) {
          fields[fieldName] = value;
        }
      }

      for (const fieldName of Object.keys(SINGLE_SELECT_FIELDS)) {
        const value = normalizeSingleValue(fieldName, record.fields?.[fieldName]);
        if (value) {
          fields[fieldName] = value;
        }
      }

      for (const fieldName of Object.keys(MULTI_SELECT_FIELDS)) {
        const values = parseMultiValues(record.fields?.[fieldName]);
        if (values.length > 0) {
          fields[fieldName] = dedupeOptions(values);
        }
      }

      // 辅助默认值：已有结果人数但状态为空时，默认 success。
      if (!fields["执行状态"]) {
        const resultCount = normalizeNumberValue(record.fields?.["结果人数"]);
        if (resultCount !== null && resultCount > 0) {
          fields["执行状态"] = "success";
          fields["最近执行时间"] = Date.now();
        }
      }

      if (Object.keys(fields).length > 0) {
        recordUpdates.push({
          record_id: record.record_id,
          fields
        });
      }
    }

    if (recordUpdates.length > 0) {
      updatedRecordCount = await batchUpdateRecords(token, appToken, tableId, recordUpdates, 100);
    }
  }

  const afterFields = dryRun ? beforeFields : await listTableFields(token, appToken, tableId);

  const report = {
    dry_run: dryRun,
    app_token: appToken,
    table_id: tableId,
    executed_at: new Date().toISOString(),
    field_count_before: beforeFields.length,
    field_count_after: afterFields.length,
    record_count: records.length,
    updated_record_count: updatedRecordCount,
    schema_actions: schemaActions
  };

  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`执行失败: ${error.message}`);
  process.exit(1);
});


