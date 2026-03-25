#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { getTenantAccessToken, listTableFields, parseBitableUrl } from "../lib/feishu-bitable.js";

const FEISHU_OPEN_API = "https://open.feishu.cn/open-apis";

const DEFAULT_REDUNDANT_FIELDS = [
  "城市地区",
  "学历要求",
  "工作年限",
  "就职公司",
  "年龄",
  "期望月薪",
  "智能筛选_公开求职意向",
  "智能筛选_近期有动向",
  "智能筛选_有附件简历",
  "智能筛选_有过意向",
  "智能筛选_企业号互动"
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

async function requestJsonWithAuth(url, method, tenantAccessToken) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      "Content-Type": "application/json; charset=utf-8"
    }
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

async function deleteField(tenantAccessToken, appToken, tableId, fieldId) {
  await requestJsonWithAuth(
    `${FEISHU_OPEN_API}/bitable/v1/apps/${appToken}/tables/${tableId}/fields/${fieldId}`,
    "DELETE",
    tenantAccessToken
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = args["base-url"] ?? process.env.BASE_URL;
  const appId = args["app-id"] ?? process.env.FEISHU_APP_ID;
  const appSecret = args["app-secret"] ?? process.env.FEISHU_APP_SECRET;
  const output = args.output ?? "./data/feishu-filter-table-prune.report.json";
  const dryRun = Boolean(args["dry-run"]);

  if (!baseUrl || !appId || !appSecret) {
    throw new Error("缺少 base-url / app-id / app-secret（可使用环境变量）");
  }

  const names = args.fields
    ? args.fields
        .split(/[;,，]/)
        .map((item) => item.trim())
        .filter(Boolean)
    : DEFAULT_REDUNDANT_FIELDS;

  const { appToken, tableId } = parseBitableUrl(baseUrl);
  if (!appToken || !tableId) {
    throw new Error("base-url 解析失败，缺少 app_token 或 table_id");
  }

  const token = await getTenantAccessToken(appId, appSecret);
  const fields = await listTableFields(token, appToken, tableId);
  const byName = new Map(fields.map((item) => [item.field_name, item]));

  const actions = [];
  for (const name of names) {
    const field = byName.get(name);
    if (!field) {
      actions.push({ action: "missing", field_name: name });
      continue;
    }
    if (field.is_primary) {
      actions.push({ action: "skipped_primary", field_name: name, field_id: field.field_id });
      continue;
    }
    if (dryRun) {
      actions.push({ action: "would_delete", field_name: name, field_id: field.field_id });
      continue;
    }
    await deleteField(token, appToken, tableId, field.field_id);
    actions.push({ action: "deleted", field_name: name, field_id: field.field_id });
  }

  const report = {
    dry_run: dryRun,
    app_token: appToken,
    table_id: tableId,
    executed_at: new Date().toISOString(),
    requested_count: names.length,
    actions
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

