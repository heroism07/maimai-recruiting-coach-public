#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  batchCreateRecordsDetailed,
  getTenantAccessToken,
  listTableRecords,
  listTableFields,
  parseBitableUrl,
  updateRecordFields
} from "./lib/feishu-bitable.js";
import {
  buildTemplateVersionFields,
  extractRecordTemplateMeta,
  filterTemplateRecordsByBase,
  getNextTemplateVersion,
  parseTemplateVersionName,
  pickLatestTemplateRecord,
  pickTemplateRecordByQuery
} from "./lib/template-version.js";

const TEMPLATE_FIELD_ALIASES = ["模版名称", "模板名称", "场景名称"];
const TEMPLATE_META_FIELDS = ["模版名称", "模板名称", "模版基础名", "模版版本", "父记录ID", "变更摘要"];
const LEGACY_FIELD_FALLBACK_REQUIREMENTS = {
  模板名称: ["模版名称"],
  城市地区: ["城市地区_列表"],
  学历要求: ["学历_最低", "学历_最高"],
  工作年限: ["工作年限_最低(年)", "工作年限_最高(年)", "工作年限_在校应届"],
  就职公司: ["就职公司_列表", "就职公司_范围"],
  年龄: ["年龄_最低", "年龄_最高"],
  期望月薪: ["期望月薪_最低K", "期望月薪_最高K"],
  智能筛选_公开求职意向: ["智能筛选_公开求职意向_开关"],
  智能筛选_近期有动向: ["智能筛选_近期有动向_开关", "智能筛选_近期有动向_范围"],
  智能筛选_有附件简历: ["智能筛选_有附件简历_开关"],
  智能筛选_有过意向: ["智能筛选_有过意向_开关"],
  智能筛选_企业号互动: ["智能筛选_企业号互动_开关", "智能筛选_企业号互动_类型"]
};

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

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = toPlainText(value);
    if (text) {
      return text;
    }
  }
  return "";
}

function isTrueFlag(value) {
  const text = toPlainText(value).toLowerCase();
  return new Set(["1", "true", "yes", "y", "on"]).has(text);
}

function toPlainText(value) {
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
    return value
      .map((item) => toPlainText(item))
      .filter(Boolean)
      .join(";");
  }
  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return value.text.trim();
    }
    return JSON.stringify(value);
  }
  return String(value);
}

function parseMultiValues(value) {
  const text = toPlainText(value);
  if (!text) {
    return [];
  }
  return text
    .split(/[;；,，、|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNumeric(value) {
  const text = toPlainText(value);
  if (!text) {
    return null;
  }
  const n = Number(text);
  if (Number.isFinite(n)) {
    return n;
  }
  return null;
}

function shouldSkipLegacyFieldWrite(tableField, fieldNameSet, writeLegacyFields) {
  if (writeLegacyFields) {
    return false;
  }
  const fallbackTargets = LEGACY_FIELD_FALLBACK_REQUIREMENTS[tableField];
  if (!fallbackTargets) {
    return false;
  }
  return fallbackTargets.some((fieldName) => fieldNameSet.has(fieldName));
}

function buildPayloadFromScenario(scenario, fieldNameSet, options = {}) {
  const writeLegacyFields = Boolean(options.writeLegacyFields);
  const out = {};

  // 原始字段（兼容层）
  const basicFieldMap = {
    模版名称: "模版名称",
    模板名称: "模板名称",
    模版基础名: "模版基础名",
    模版版本: "模版版本",
    父记录ID: "父记录ID",
    变更摘要: "变更摘要",
    职位需求: "职位需求",
    场景名称: "场景名称",
    是否启用: "是否启用",
    关键词: "关键词",
    关键词逻辑: "关键词逻辑(所有/任一)",
    城市地区: "城市地区",
    学历要求: "学历要求",
    工作年限: "工作年限",
    就职公司: "就职公司",
    职位名称: "职位名称",
    行业方向: "行业方向",
    毕业学校: "毕业学校",
    专业: "专业",
    性别: "性别",
    年龄: "年龄",
    期望月薪: "期望月薪",
    家乡: "家乡",
    智能筛选_公开求职意向: "智能筛选_公开求职意向",
    智能筛选_近期有动向: "智能筛选_近期有动向",
    智能筛选_有附件简历: "智能筛选_有附件简历",
    智能筛选_有过意向: "智能筛选_有过意向",
    智能筛选_企业号互动: "智能筛选_企业号互动",
    排序方式: "排序方式",
    招呼语要求: "招呼语要求",
    筛选策略: "筛选策略",
    备注: "备注",
    筛选模式: "筛选模式",
    筛选条件JSON: "筛选条件JSON"
  };

  for (const [scenarioKey, tableField] of Object.entries(basicFieldMap)) {
    if (!fieldNameSet.has(tableField)) {
      continue;
    }
    if (shouldSkipLegacyFieldWrite(tableField, fieldNameSet, writeLegacyFields)) {
      continue;
    }
    const value = scenario[scenarioKey];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (["城市地区", "职位名称", "行业方向", "家乡"].includes(tableField)) {
      const arr = parseMultiValues(value);
      out[tableField] = arr.length > 0 ? arr : toPlainText(value);
      continue;
    }
    out[tableField] = toPlainText(value);
  }

  // 结构化字段（v2）
  const multiV2 = [
    ["城市口径", "城市口径"],
    ["就职公司_范围", "就职公司_范围"],
    ["智能筛选_公开求职意向_状态", "智能筛选_公开求职意向_状态"],
    ["智能筛选_企业号互动_类型", "智能筛选_企业号互动_类型"]
  ];
  for (const [scenarioKey, tableField] of multiV2) {
    if (!fieldNameSet.has(tableField)) continue;
    const arr = parseMultiValues(scenario[scenarioKey]);
    if (arr.length > 0) {
      out[tableField] = arr;
    }
  }

  const numericV2 = [
    ["工作年限_最低_年", "工作年限_最低(年)"],
    ["工作年限_最高_年", "工作年限_最高(年)"],
    ["年龄_最低", "年龄_最低"],
    ["年龄_最高", "年龄_最高"],
    ["期望月薪_最低K", "期望月薪_最低K"],
    ["期望月薪_最高K", "期望月薪_最高K"]
  ];
  for (const [scenarioKey, tableField] of numericV2) {
    if (!fieldNameSet.has(tableField)) continue;
    const n = parseNumeric(scenario[scenarioKey]);
    if (n !== null) {
      out[tableField] = n;
    }
  }

  const plainV2 = [
    ["城市地区", "城市地区_列表"],
    ["学历_最低", "学历_最低"],
    ["学历_最高", "学历_最高"],
    ["工作年限_在校应届", "工作年限_在校应届"],
    ["就职公司_列表", "就职公司_列表"],
    ["智能筛选_公开求职意向_开关", "智能筛选_公开求职意向_开关"],
    ["智能筛选_近期有动向_开关", "智能筛选_近期有动向_开关"],
    ["智能筛选_近期有动向_范围", "智能筛选_近期有动向_范围"],
    ["智能筛选_有附件简历_开关", "智能筛选_有附件简历_开关"],
    ["智能筛选_有过意向_开关", "智能筛选_有过意向_开关"],
    ["智能筛选_企业号互动_开关", "智能筛选_企业号互动_开关"]
  ];
  for (const [scenarioKey, tableField] of plainV2) {
    if (!fieldNameSet.has(tableField)) continue;
    const text = toPlainText(scenario[scenarioKey]);
    if (text) {
      out[tableField] = text;
    }
  }

  // 回写运行态结果字段（如存在）
  if (fieldNameSet.has("结果人数")) {
    const resultCount = parseNumeric(scenario["结果人数"]);
    if (resultCount !== null) {
      out["结果人数"] = resultCount;
    }
  }

  return out;
}

function ensureTemplateFields(payload, scenario, fieldNameSet, argsTemplateName) {
  const incomingName = firstNonEmpty(
    argsTemplateName,
    scenario["模版名称"],
    scenario["模板名称"],
    scenario["场景名称"],
    payload["模版名称"],
    payload["模板名称"],
    payload["场景名称"]
  );
  const incomingMeta = parseTemplateVersionName(incomingName);
  const baseName = firstNonEmpty(scenario["模版基础名"], incomingMeta.base_name);
  if (!baseName) {
    return {
      incoming_name: "",
      base_name: "",
      incoming_version: null
    };
  }

  if (fieldNameSet.has("模版基础名")) {
    payload["模版基础名"] = baseName;
  }
  if (fieldNameSet.has("模版版本")) {
    const inputVersion = Number.parseInt(firstNonEmpty(scenario["模版版本"], incomingMeta.version), 10);
    if (Number.isFinite(inputVersion) && inputVersion > 0) {
      payload["模版版本"] = inputVersion;
    }
  }
  if (incomingName) {
    for (const fieldName of TEMPLATE_FIELD_ALIASES) {
      if (fieldNameSet.has(fieldName) && !toPlainText(payload[fieldName])) {
        payload[fieldName] = incomingName;
      }
    }
  }

  return {
    incoming_name: incomingName,
    base_name: baseName,
    incoming_version: Number.isFinite(incomingMeta.version) ? incomingMeta.version : null
  };
}

function areFieldValuesEqual(payloadValue, recordValue) {
  if (Array.isArray(payloadValue) || Array.isArray(recordValue)) {
    const left = parseMultiValues(payloadValue).sort().join("||");
    const right = parseMultiValues(recordValue).sort().join("||");
    return left === right;
  }
  if (typeof payloadValue === "number") {
    const right = parseNumeric(recordValue);
    return right !== null && right === payloadValue;
  }
  return toPlainText(payloadValue) === toPlainText(recordValue);
}

function hasPayloadDiff(payload, existingFields = {}, ignoredFields = new Set()) {
  return Object.entries(payload).some(([fieldName, payloadValue]) => {
    if (ignoredFields.has(fieldName)) {
      return false;
    }
    const existingValue = existingFields[fieldName];
    return !areFieldValuesEqual(payloadValue, existingValue);
  });
}

function listChangedFields(payload, existingFields = {}, ignoredFields = new Set()) {
  return Object.entries(payload)
    .filter(([fieldName]) => !ignoredFields.has(fieldName))
    .filter(([fieldName, payloadValue]) => {
      const existingValue = existingFields[fieldName];
      return !areFieldValuesEqual(payloadValue, existingValue);
    })
    .map(([fieldName]) => fieldName);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtimePath = args.runtime ?? "./data/active-filter-scenario.runtime.json";
  const baseUrl = args["base-url"];
  const appId = process.env.FEISHU_APP_ID ?? args["app-id"];
  const appSecret = process.env.FEISHU_APP_SECRET ?? args["app-secret"];

  if (!baseUrl || !appId || !appSecret) {
    throw new Error("缺少 --base-url / FEISHU_APP_ID / FEISHU_APP_SECRET");
  }

  const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
  const scenario = runtime?.scenario ?? {};
  const forceUpdate = isTrueFlag(args["update-existing"]);
  const writeLegacyFields = isTrueFlag(args["write-legacy-fields"]);

  const { appToken, tableId, viewId } = parseBitableUrl(baseUrl);
  if (!appToken || !tableId) {
    throw new Error("base-url 解析失败，缺少 app_token 或 table_id");
  }
  const token = await getTenantAccessToken(appId, appSecret);
  const fields = await listTableFields(token, appToken, tableId);
  const fieldNameSet = new Set(fields.map((item) => item.field_name).filter(Boolean));
  const payload = buildPayloadFromScenario(scenario, fieldNameSet, {
    writeLegacyFields
  });
  const templateMeta = ensureTemplateFields(
    payload,
    scenario,
    fieldNameSet,
    args["template-name"] ?? args["template"]
  );
  const baseName = templateMeta.base_name;

  if (Object.keys(payload).length === 0) {
    throw new Error("没有可更新字段，请检查 runtime 内容或表结构");
  }
  if (!baseName) {
    throw new Error("缺少模版名称（或模版基础名），无法执行版本化同步");
  }

  const listViewId = isTrueFlag(args["respect-view"]) ? viewId : "";
  const records = await listTableRecords(token, appToken, tableId, {
    viewId: listViewId
  });
  const recordIdArg = firstNonEmpty(args["record-id"], scenario.record_id);
  const queryName = firstNonEmpty(args["template-name"], args["template"], templateMeta.incoming_name, baseName);
  const targetById = recordIdArg ? records.find((record) => record.record_id === recordIdArg) ?? null : null;
  const targetByQuery = queryName ? pickTemplateRecordByQuery(records, queryName, TEMPLATE_FIELD_ALIASES) : null;
  const matchedByBase = filterTemplateRecordsByBase(records, baseName, TEMPLATE_FIELD_ALIASES);
  const latestForBase = pickLatestTemplateRecord(matchedByBase, TEMPLATE_FIELD_ALIASES);

  const ignoredFields = new Set([
    ...TEMPLATE_META_FIELDS,
    "最近执行时间",
    "执行状态",
    "异常原因",
    "结果人数",
    "结果摘要"
  ]);
  const changedFields = latestForBase
    ? listChangedFields(payload, latestForBase.fields ?? {}, ignoredFields)
    : Object.keys(payload).filter((field) => !ignoredFields.has(field));
  const changed = changedFields.length > 0;

  if (forceUpdate) {
    const targetRecord = targetById ?? targetByQuery ?? latestForBase;
    const recordId = targetRecord?.record_id ?? "";
    if (!recordId) {
      throw new Error("update-existing 模式下缺少 record_id，且未匹配到可更新记录");
    }
    const targetMeta = extractRecordTemplateMeta(targetRecord, TEMPLATE_FIELD_ALIASES);
    const versionFields = buildTemplateVersionFields(
      targetMeta.base_name || baseName,
      targetMeta.version || templateMeta.incoming_version || 1
    );
    for (const [fieldName, fieldValue] of Object.entries(versionFields)) {
      if (fieldNameSet.has(fieldName)) {
        payload[fieldName] = fieldValue;
      }
    }
    if (fieldNameSet.has("父记录ID")) {
      payload["父记录ID"] = toPlainText(targetRecord?.fields?.["父记录ID"]);
    }
    if (fieldNameSet.has("变更摘要") && args["change-note"]) {
      payload["变更摘要"] = toPlainText(args["change-note"]);
    }
    await updateRecordFields(token, appToken, tableId, recordId, payload);
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          ok: true,
          action: "updated_existing",
          runtime: runtimePath,
          template_name: payload["模版名称"] ?? "",
          record_id: recordId,
          updated_count: Object.keys(payload).length,
          updated_fields: Object.keys(payload)
        },
        null,
        2
      )
    );
    return;
  }

  if (!changed) {
    const latestMeta = latestForBase
      ? extractRecordTemplateMeta(latestForBase, TEMPLATE_FIELD_ALIASES)
      : {
          template_name: "",
          base_name: baseName,
          version: null
        };
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          ok: true,
          action: "no_change_skip",
          runtime: runtimePath,
          template_name: latestMeta.template_name || "",
          template_base_name: latestMeta.base_name || baseName,
          template_version: latestMeta.version ?? "",
          matched_record_id: latestForBase?.record_id ?? "",
          compared_field_count: Object.keys(payload).length
        },
        null,
        2
      )
    );
    return;
  }

  const nextVersion = getNextTemplateVersion(records, baseName, TEMPLATE_FIELD_ALIASES);
  const versionFields = buildTemplateVersionFields(baseName, nextVersion);
  for (const [fieldName, fieldValue] of Object.entries(versionFields)) {
    if (fieldNameSet.has(fieldName)) {
      payload[fieldName] = fieldValue;
    }
  }
  if (fieldNameSet.has("父记录ID")) {
    payload["父记录ID"] = latestForBase?.record_id ?? targetByQuery?.record_id ?? "";
  }
  if (fieldNameSet.has("变更摘要")) {
    payload["变更摘要"] = toPlainText(
      args["change-note"] ??
        scenario["变更摘要"] ??
        (changedFields.length > 0 ? `字段变更: ${changedFields.join("、")}` : "")
    );
  }
  if (fieldNameSet.has("职位需求") && !toPlainText(payload["职位需求"])) {
    payload["职位需求"] = toPlainText(scenario["职位需求"]) || toPlainText(scenario["场景名称"]) || baseName;
  }
  if (fieldNameSet.has("场景名称") && !toPlainText(payload["场景名称"])) {
    payload["场景名称"] = toPlainText(payload["职位需求"]) || baseName;
  }

  const createdRecords = await batchCreateRecordsDetailed(token, appToken, tableId, [payload], 1);
  const createdRecordId = createdRecords[0]?.record_id ?? "";
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        ok: true,
        action: "created_new_version",
        runtime: runtimePath,
        template_name: payload["模版名称"] ?? "",
        template_base_name: payload["模版基础名"] ?? baseName,
        template_version: payload["模版版本"] ?? nextVersion,
        based_on_record_id: latestForBase?.record_id ?? targetByQuery?.record_id ?? "",
        created_count: createdRecords.length,
        created_record_id: createdRecordId,
        fields_written: Object.keys(payload)
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
