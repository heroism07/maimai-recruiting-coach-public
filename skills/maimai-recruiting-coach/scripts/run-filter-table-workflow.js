#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  getTenantAccessToken,
  listTableFields,
  listTableRecords,
  parseBitableUrl,
  updateRecordFields
} from "./lib/feishu-bitable.js";
import {
  extractRecordTemplateMeta,
  getTemplateNameFromFields,
  parseTemplateVersionName,
  pickTemplateRecordByQuery
} from "./lib/template-version.js";
import {
  extractBitableUrlFromFields,
  mergeRuntimeConfig,
  pickFirstNonEmpty,
  readRuntimeConfig,
  sanitizeConfigPatch
} from "./lib/runtime-config.js";

const YES_VALUES = new Set(["是", "true", "1", "yes", "y", "启用"]);
const TEMPLATE_FIELD_ALIASES = ["模版名称", "模板名称", "场景名称"];

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
    return value.map((item) => toPlainText(item)).filter(Boolean).join("；");
  }
  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return value.text.trim();
    }
    return JSON.stringify(value);
  }
  return String(value);
}

function isEnabledValue(value) {
  const text = toPlainText(value).toLowerCase();
  return YES_VALUES.has(text);
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

function parsePositiveInt(value, fallbackValue) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return fallbackValue;
  }
  return Math.trunc(n);
}

function toTimestamp(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const text = toPlainText(value);
    if (!text) continue;
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
    const n = Number(text);
    if (Number.isFinite(n) && n > 0) {
      return n > 1e12 ? n : n * 1000;
    }
  }
  return 0;
}

function normalizeScenarioRecord(record) {
  const f = record.fields ?? {};
  const mode = firstNonEmpty(f["筛选模式"], "兼容模式(旧字段)");
  const cityList = firstNonEmpty(f["城市地区_列表"], f["城市地区"]);
  const companyList = firstNonEmpty(f["就职公司_列表"], f["就职公司"]);
  const positionRequirement = firstNonEmpty(toPlainText(f["职位需求"]), toPlainText(f["场景名称"]));
  const templateName = getTemplateNameFromFields(f, TEMPLATE_FIELD_ALIASES);
  const templateMeta = parseTemplateVersionName(templateName);
  const candidateBaseUrl = extractBitableUrlFromFields(f, {
    preferredKeys: [
      "候选人表URL",
      "候选人表Url",
      "候选人表链接",
      "候选人多维表URL",
      "candidate_base_url",
      "candidateBaseUrl"
    ],
    keyHints: ["候选", "candidate", "talent", "人才"]
  });
  const maimaiListUrl = pickFirstNonEmpty(
    toPlainText(f["脉脉招聘搜索URL"]),
    toPlainText(f["脉脉列表URL"]),
    toPlainText(f["脉脉搜索URL"]),
    toPlainText(f["maimai_list_url"]),
    toPlainText(f["maimaiListUrl"])
  );
  const storageStatePath = pickFirstNonEmpty(
    toPlainText(f["登录态文件"]),
    toPlainText(f["登录态路径"]),
    toPlainText(f["storage_state_path"]),
    toPlainText(f["storageStatePath"])
  );
  const browserProfileDir = pickFirstNonEmpty(
    toPlainText(f["浏览器空间路径"]),
    toPlainText(f["浏览器Profile目录"]),
    toPlainText(f["browser_profile_dir"]),
    toPlainText(f["browserProfileDir"])
  );

  return {
    record_id: record.record_id,
    筛选模式: mode,
    模版名称: templateName,
    模板名称: templateName,
    模版基础名: firstNonEmpty(toPlainText(f["模版基础名"]), templateMeta.base_name),
    模版版本: firstNonEmpty(toPlainText(f["模版版本"]), templateMeta.version),
    父记录ID: toPlainText(f["父记录ID"]),
    变更摘要: toPlainText(f["变更摘要"]),
    职位需求: positionRequirement,
    场景名称: firstNonEmpty(positionRequirement, templateName),
    是否启用: toPlainText(f["是否启用"]),
    关键词: toPlainText(f["关键词"]),
    关键词逻辑: toPlainText(f["关键词逻辑(所有/任一)"]),
    城市地区: cityList,
    城市口径: toPlainText(f["城市口径"]),
    学历要求: toPlainText(f["学历要求"]),
    学历_最低: toPlainText(f["学历_最低"]),
    学历_最高: toPlainText(f["学历_最高"]),
    工作年限: toPlainText(f["工作年限"]),
    工作年限_最低_年: toPlainText(f["工作年限_最低(年)"]),
    工作年限_最高_年: toPlainText(f["工作年限_最高(年)"]),
    工作年限_在校应届: toPlainText(f["工作年限_在校应届"]),
    就职公司: toPlainText(f["就职公司"]),
    就职公司_范围: toPlainText(f["就职公司_范围"]),
    就职公司_列表: companyList,
    职位名称: toPlainText(f["职位名称"]),
    行业方向: toPlainText(f["行业方向"]),
    毕业学校: toPlainText(f["毕业学校"]),
    专业: toPlainText(f["专业"]),
    性别: toPlainText(f["性别"]),
    年龄: toPlainText(f["年龄"]),
    年龄_最低: toPlainText(f["年龄_最低"]),
    年龄_最高: toPlainText(f["年龄_最高"]),
    期望月薪: toPlainText(f["期望月薪"]),
    期望月薪_最低K: toPlainText(f["期望月薪_最低K"]),
    期望月薪_最高K: toPlainText(f["期望月薪_最高K"]),
    家乡: toPlainText(f["家乡"]),
    智能筛选_公开求职意向: toPlainText(f["智能筛选_公开求职意向"]),
    智能筛选_公开求职意向_开关: toPlainText(f["智能筛选_公开求职意向_开关"]),
    智能筛选_公开求职意向_状态: toPlainText(f["智能筛选_公开求职意向_状态"]),
    智能筛选_近期有动向: toPlainText(f["智能筛选_近期有动向"]),
    智能筛选_近期有动向_开关: toPlainText(f["智能筛选_近期有动向_开关"]),
    智能筛选_近期有动向_范围: toPlainText(f["智能筛选_近期有动向_范围"]),
    智能筛选_有附件简历: toPlainText(f["智能筛选_有附件简历"]),
    智能筛选_有附件简历_开关: toPlainText(f["智能筛选_有附件简历_开关"]),
    智能筛选_有过意向: toPlainText(f["智能筛选_有过意向"]),
    智能筛选_有过意向_开关: toPlainText(f["智能筛选_有过意向_开关"]),
    智能筛选_企业号互动: toPlainText(f["智能筛选_企业号互动"]),
    智能筛选_企业号互动_开关: toPlainText(f["智能筛选_企业号互动_开关"]),
    智能筛选_企业号互动_类型: toPlainText(f["智能筛选_企业号互动_类型"]),
    排序方式: toPlainText(f["排序方式"]),
    招呼语要求: toPlainText(f["招呼语要求"]),
    筛选策略: toPlainText(f["筛选策略"]),
    筛选条件JSON: toPlainText(f["筛选条件JSON"]),
    备注: toPlainText(f["备注"]),
    candidate_base_url: candidateBaseUrl,
    maimai_list_url: maimaiListUrl,
    storage_state_path: storageStatePath,
    browser_profile_dir: browserProfileDir
  };
}

async function buildFeishuContext(args) {
  const runtimeConfigState = await readRuntimeConfig(args.config);
  const runtimeConfig = runtimeConfigState.config ?? {};
  const appId = process.env.FEISHU_APP_ID ?? args["app-id"];
  const appSecret = process.env.FEISHU_APP_SECRET ?? args["app-secret"];
  if (!appId || !appSecret) {
    throw new Error("缺少 FEISHU_APP_ID / FEISHU_APP_SECRET");
  }
  const baseUrl = pickFirstNonEmpty(args["base-url"], process.env.FEISHU_FILTER_BASE_URL, runtimeConfig.filter_base_url);
  if (!baseUrl) {
    throw new Error("缺少 --base-url");
  }
  args["base-url"] = baseUrl;
  const parsed = parseBitableUrl(baseUrl);
  if (!parsed.appToken || !parsed.tableId) {
    throw new Error("base-url 解析失败，缺少 app_token 或 table_id");
  }
  const token = await getTenantAccessToken(appId, appSecret);
  return {
    token,
    appToken: parsed.appToken,
    tableId: parsed.tableId,
    viewId: parsed.viewId
  };
}

async function runPullActive(args) {
  const ctx = await buildFeishuContext(args);
  const records = await listTableRecords(ctx.token, ctx.appToken, ctx.tableId, {
    viewId: ctx.viewId
  });
  const templateName = firstNonEmpty(
    args["template-name"],
    args["template"],
    args["模版名称"],
    args["模板名称"],
    args["场景名称"]
  );

  let selected = null;
  if (templateName) {
    selected = pickTemplateRecordByQuery(records, templateName, TEMPLATE_FIELD_ALIASES);
    if (!selected) {
      throw new Error(`未找到模版名称为 "${templateName}" 的记录`);
    }
  } else {
    selected = records.find((item) => isEnabledValue(item.fields?.["是否启用"])) ?? records[0];
  }

  if (!selected) {
    throw new Error("筛选表为空，未找到可执行场景");
  }
  const scenario = normalizeScenarioRecord(selected);
  const selectedTemplateMeta = extractRecordTemplateMeta(selected, TEMPLATE_FIELD_ALIASES);
  const payload = {
    pulled_at: new Date().toISOString(),
    selected_by: templateName ? "模版名称索引" : "是否启用",
    selected_template_name: selectedTemplateMeta.template_name || templateName || scenario.模版名称 || "",
    selected_template_base: selectedTemplateMeta.base_name || scenario.模版基础名 || "",
    selected_template_version: selectedTemplateMeta.version ?? "",
    scenario
  };
  const runtimePatch = sanitizeConfigPatch({
    filter_base_url: args["base-url"],
    candidate_base_url: scenario.candidate_base_url,
    maimai_list_url: scenario.maimai_list_url,
    storage_state_path: scenario.storage_state_path,
    browser_profile_dir: scenario.browser_profile_dir
  });
  if (Object.keys(runtimePatch).length > 0) {
    await mergeRuntimeConfig(runtimePatch, args.config);
  }

  if (args.output) {
    await writeFile(resolve(args.output), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload, null, 2));
}

async function runWriteResult(args) {
  const ctx = await buildFeishuContext(args);
  const recordId = args["record-id"];
  if (!recordId) {
    throw new Error("write-result 缺少 --record-id");
  }
  const desiredFields = {
    结果人数: Number(args["result-count"] ?? 0),
    结果摘要: args["result-summary"] ?? "",
    执行状态: args.status ?? "success",
    最近执行时间: Date.now(),
    异常原因: args.error ?? "",
    筛选建议摘要: args["suggestion-summary"] ?? "",
    筛选建议JSON: args["suggestion-json"] ?? "",
    建议触发原因: args["suggestion-trigger"] ?? "",
    建议变更Diff: args["suggestion-diff"] ?? ""
  };
  const tableFields = await listTableFields(ctx.token, ctx.appToken, ctx.tableId);
  const fieldNameSet = new Set(tableFields.map((item) => item.field_name).filter(Boolean));
  const fields = Object.fromEntries(
    Object.entries(desiredFields).filter(([fieldName]) => fieldNameSet.has(fieldName))
  );
  if (Object.keys(fields).length === 0) {
    throw new Error("write-result 未找到可写入字段，请检查表结构");
  }
  await updateRecordFields(ctx.token, ctx.appToken, ctx.tableId, recordId, fields);
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        mode: "write-result",
        record_id: recordId,
        updated_fields: fields
      },
      null,
      2
    )
  );
}

async function runListTemplates(args) {
  const ctx = await buildFeishuContext(args);
  const records = await listTableRecords(ctx.token, ctx.appToken, ctx.tableId, {
    viewId: ctx.viewId
  });
  const limit = parsePositiveInt(args.limit, 20);
  const baseFilter = toPlainText(args["base-name"]);
  const onlyEnabled = toPlainText(args["only-enabled"]).toLowerCase() === "true";
  const latestOnly = toPlainText(args["latest-only"]).toLowerCase() !== "false";

  const grouped = new Map();
  for (const record of records) {
    const scenario = normalizeScenarioRecord(record);
    const meta = extractRecordTemplateMeta(record, TEMPLATE_FIELD_ALIASES);
    const baseName = meta.base_name || scenario.模版基础名 || meta.template_name;
    if (!baseName) continue;
    if (baseFilter && baseName !== baseFilter) continue;
    if (onlyEnabled && !isEnabledValue(scenario.是否启用)) continue;

    const item = {
      record_id: record.record_id,
      template_name: meta.template_name || scenario.模版名称 || "",
      template_base_name: baseName,
      template_version: Number.isFinite(meta.version) ? meta.version : Number(scenario.模版版本 || 0),
      enabled: isEnabledValue(scenario.是否启用),
      status: toPlainText(record.fields?.["执行状态"]),
      result_count: toPlainText(record.fields?.["结果人数"]),
      result_summary: toPlainText(record.fields?.["结果摘要"]),
      last_run_at: toPlainText(record.fields?.["最近执行时间"]),
      updated_at: toTimestamp(
        record.fields?.["最近执行时间"],
        record.last_modified_time,
        record.created_time
      )
    };
    const list = grouped.get(baseName) ?? [];
    list.push(item);
    grouped.set(baseName, list);
  }

  const entries = [];
  for (const [baseName, list] of grouped.entries()) {
    const sorted = [...list].sort((a, b) => {
      if ((b.template_version ?? 0) !== (a.template_version ?? 0)) {
        return (b.template_version ?? 0) - (a.template_version ?? 0);
      }
      return (b.updated_at ?? 0) - (a.updated_at ?? 0);
    });
    if (latestOnly) {
      entries.push(sorted[0]);
      continue;
    }
    entries.push(...sorted);
  }
  const sortedEntries = entries
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
    .slice(0, limit);
  const payload = {
    generated_at: new Date().toISOString(),
    mode: "list-templates",
    total: sortedEntries.length,
    latest_only: latestOnly,
    templates: sortedEntries.map((item) => ({
      record_id: item.record_id,
      template_name: item.template_name,
      template_base_name: item.template_base_name,
      template_version: item.template_version,
      enabled: item.enabled,
      status: item.status,
      result_count: item.result_count,
      last_run_at: item.last_run_at,
      result_summary: item.result_summary
    }))
  };
  if (args.output) {
    await writeFile(resolve(args.output), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload, null, 2));
}

async function runMarkRunning(args) {
  const ctx = await buildFeishuContext(args);
  const recordId = args["record-id"];
  if (!recordId) {
    throw new Error("mark-running 缺少 --record-id");
  }
  const fields = {
    执行状态: "running",
    最近执行时间: Date.now(),
    异常原因: ""
  };
  await updateRecordFields(ctx.token, ctx.appToken, ctx.tableId, recordId, fields);
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        mode: "mark-running",
        record_id: recordId
      },
      null,
      2
    )
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command] = args._;

  if (!command || args.help || args.h) {
    // eslint-disable-next-line no-console
    console.log(
      "用法: pull-active | mark-running | write-result | list-templates；均需 --base-url，可配合 FEISHU_APP_ID/FEISHU_APP_SECRET；pull-active 支持 --template-name（输入基础名默认取最新版本，输入@vNNN可精确命中）"
    );
    process.exit(0);
  }

  if (command === "pull-active") {
    await runPullActive(args);
    return;
  }
  if (command === "mark-running") {
    await runMarkRunning(args);
    return;
  }
  if (command === "write-result") {
    await runWriteResult(args);
    return;
  }
  if (command === "list-templates") {
    await runListTemplates(args);
    return;
  }

  throw new Error(`未知命令: ${command}`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`执行失败: ${error.message}`);
  process.exit(1);
});
