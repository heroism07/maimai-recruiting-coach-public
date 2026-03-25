#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildApplyOperationsFromScenario, parseFilterSummaryToScenario } from "./lib/filter-bridge.js";
import {
  findBestFilterPath,
  loadFilterPathMemory,
  reportApplyExecution,
  recordSuccessfulFilterPath,
  resolveApplyOperations
} from "./lib/filter-path-memory.js";

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

function toText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value).trim();
  return String(value).trim();
}

function parseOperationsPayload(rawPayload) {
  if (Array.isArray(rawPayload)) {
    return {
      template_name: "",
      operations: rawPayload
    };
  }
  if (rawPayload && typeof rawPayload === "object") {
    return {
      template_name: toText(rawPayload.template_name),
      operations: Array.isArray(rawPayload.operations) ? rawPayload.operations : []
    };
  }
  return {
    template_name: "",
    operations: []
  };
}

function toInteger(value, fallbackValue = 0) {
  const n = Number(value);
  if (Number.isFinite(n)) {
    return Math.max(0, Math.trunc(n));
  }
  return fallbackValue;
}

function resolveTemplateName(args, scenario = {}, fallbackName = "") {
  return (
    toText(args["template-name"]) ||
    toText(args.template) ||
    toText(scenario["模版名称"]) ||
    toText(scenario["模板名称"]) ||
    toText(scenario["模版基础名"]) ||
    toText(scenario["职位需求"]) ||
    toText(scenario["场景名称"]) ||
    toText(fallbackName)
  );
}

async function buildApplyOpsPayload(args, scenario = {}, generatedOperations = [], mode = "build-apply-ops") {
  const templateName = resolveTemplateName(args, scenario);
  const resolved = await resolveApplyOperations(
    {
      templateName,
      pageSignature: toText(args["page-signature"]),
      generatedOperations,
      reuseMode: toText(args["reuse-success-path"]) || "auto"
    },
    args.memory
  );

  return {
    generated_at: new Date().toISOString(),
    mode,
    template_name: templateName,
    apply_ops_source: resolved.apply_ops_source,
    path_reuse_miss_reason: resolved.path_reuse_miss_reason,
    selected_path_id: resolved.selected_path_id,
    reuse_mode: resolved.reuse_mode,
    observability: resolved.observability,
    operations: resolved.operations
  };
}

async function runBuildApplyOps(args) {
  if (!args.runtime || !args.output) {
    throw new Error("build-apply-ops 需要 --runtime 与 --output");
  }
  const runtime = JSON.parse(await readFile(resolve(args.runtime), "utf8"));
  const scenario = runtime?.scenario ?? {};
  const operations = buildApplyOperationsFromScenario(scenario);
  const payload = await buildApplyOpsPayload(args, scenario, operations, "build-apply-ops");
  await writeFile(resolve(args.output), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload, null, 2));
}

async function runReadSummary(args) {
  if (!args.input || !args.output) {
    throw new Error("read-summary 需要 --input 与 --output");
  }
  const summary = JSON.parse(await readFile(resolve(args.input), "utf8"));
  const scenarioPatch = parseFilterSummaryToScenario(Array.isArray(summary) ? summary : summary.items ?? []);
  let applyOpsPayload = null;
  if (args.runtime && args["apply-output"]) {
    const runtime = JSON.parse(await readFile(resolve(args.runtime), "utf8"));
    const mergedScenario = {
      ...(runtime?.scenario ?? {}),
      ...scenarioPatch
    };
    const generatedOps = buildApplyOperationsFromScenario(mergedScenario);
    applyOpsPayload = await buildApplyOpsPayload(args, mergedScenario, generatedOps, "read-summary-apply");
    await writeFile(resolve(args["apply-output"]), `${JSON.stringify(applyOpsPayload, null, 2)}\n`, "utf8");
  }
  const payload = {
    captured_at: new Date().toISOString(),
    mode: "read-summary",
    scenario: scenarioPatch,
    apply_ops_output: applyOpsPayload ? resolve(args["apply-output"]) : null,
    apply_ops_source: applyOpsPayload?.apply_ops_source ?? null,
    path_reuse_miss_reason: applyOpsPayload?.path_reuse_miss_reason ?? null,
    selected_path_id: applyOpsPayload?.selected_path_id ?? null
  };
  await writeFile(resolve(args.output), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload, null, 2));
}

async function runRecordSuccess(args) {
  if (!args.input) {
    throw new Error("record-success 需要 --input");
  }
  const rawPayload = JSON.parse(await readFile(resolve(args.input), "utf8"));
  const parsedPayload = parseOperationsPayload(rawPayload);
  const templateName = toText(args["template-name"]) || parsedPayload.template_name;
  if (!templateName) {
    throw new Error("record-success 需要 --template-name（或 input 中包含 template_name）");
  }

  const recorded = await recordSuccessfulFilterPath(
    {
      templateName,
      operations: parsedPayload.operations,
      pageSignature: toText(args["page-signature"]),
      note: toText(args.note)
    },
    args.memory
  );

  const payload = {
    mode: "record-success",
    template_name: templateName,
    memory_path: recorded.memory_path,
    path_id: recorded.best_path?.path_id ?? "",
    operations_count: Array.isArray(recorded.best_path?.operations) ? recorded.best_path.operations.length : 0,
    observability: recorded.observability
  };
  if (args.output) {
    await writeFile(resolve(args.output), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload, null, 2));
}

async function runPullSuccess(args) {
  const templateName = toText(args["template-name"]);
  if (!templateName) {
    throw new Error("pull-success 需要 --template-name");
  }
  if (!args.output) {
    throw new Error("pull-success 需要 --output");
  }
  const { path: memoryPath, memory } = await loadFilterPathMemory(args.memory);
  const matched = findBestFilterPath(memory.paths ?? [], {
    templateName,
    pageSignature: toText(args["page-signature"])
  });
  if (!matched.path) {
    throw new Error(`未找到可复用成功路径: ${templateName}`);
  }

  const payload = {
    generated_at: new Date().toISOString(),
    mode: "pull-success",
    memory_path: memoryPath,
    template_name: matched.path.template_name || templateName,
    path_id: matched.path.path_id,
    match_type: matched.match_type,
    path_reuse_miss_reason: matched.miss_reason || "",
    operations: matched.path.operations ?? []
  };
  await writeFile(resolve(args.output), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload, null, 2));
}

async function runReportApplyResult(args) {
  const templateName = toText(args["template-name"]);
  if (!templateName) {
    throw new Error("report-apply-result 需要 --template-name");
  }
  const status = toText(args.status || args.result || "success");
  let operations = [];
  if (args.input) {
    const rawPayload = JSON.parse(await readFile(resolve(args.input), "utf8"));
    operations = parseOperationsPayload(rawPayload).operations;
  }
  const reported = await reportApplyExecution(
    {
      templateName,
      pageSignature: toText(args["page-signature"]),
      operations,
      status,
      retryCount: toInteger(args["retry-count"], 0),
      selectedPathId: toText(args["selected-path-id"]),
      note: toText(args.note)
    },
    args.memory
  );
  const payload = {
    mode: "report-apply-result",
    template_name: templateName,
    status: reported.status,
    selected_path_id: reported.selected_path_id,
    selected_path_status: reported.selected_path_status,
    operations_changed: reported.operations_changed,
    deprecated: reported.deprecated,
    observability: reported.observability
  };
  if (args.output) {
    await writeFile(resolve(args.output), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command] = args._;

  if (!command || args.help || args.h) {
    // eslint-disable-next-line no-console
    console.log(
      "用法: build-apply-ops --runtime <runtime.json> --output <apply-ops.json> [--reuse-success-path auto|on|off] [--page-signature <sig>] | read-summary --input <captured-summary.json> --output <runtime.patch.json> [--runtime <runtime.json> --apply-output <apply-ops.json>] [--reuse-success-path auto|on|off] [--page-signature <sig>] | record-success --input <apply-ops.json> --template-name <name> [--page-signature <sig>] | pull-success --template-name <name> --output <apply-ops.json> [--page-signature <sig>] | report-apply-result --template-name <name> [--input <apply-ops.json>] --status <success|failed> [--retry-count <n>] [--selected-path-id <id>]"
    );
    return;
  }

  if (command === "build-apply-ops") {
    await runBuildApplyOps(args);
    return;
  }
  if (command === "read-summary") {
    await runReadSummary(args);
    return;
  }
  if (command === "record-success") {
    await runRecordSuccess(args);
    return;
  }
  if (command === "pull-success") {
    await runPullSuccess(args);
    return;
  }
  if (command === "report-apply-result") {
    await runReportApplyResult(args);
    return;
  }
  throw new Error(`未知命令: ${command}`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`执行失败: ${error.message}`);
  process.exit(1);
});
