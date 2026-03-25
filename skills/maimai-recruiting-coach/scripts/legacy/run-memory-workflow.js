#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { MockAdapter } from "../adapters/mock-adapter.js";
import { PlaywrightRecruitingAdapter } from "../adapters/playwright-adapter.js";
import { WorkflowService } from "../lib/workflow-service.js";
import { resolveApplyOperations } from "../lib/filter-path-memory.js";

function parseArgs(rawArgs) {
  const parsed = {
    _: []
  };
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

async function readJsonFile(filePath) {
  const content = await readFile(resolve(filePath), "utf8");
  return JSON.parse(content);
}

function toBoolean(value, defaultValue = false) {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const text = String(value).trim().toLowerCase();
  if (!text) {
    return defaultValue;
  }
  if (["1", "true", "yes", "y", "on"].includes(text)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(text)) {
    return false;
  }
  return defaultValue;
}

function splitList(value) {
  return String(value ?? "")
    .split(/[;,，；\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function printUsage() {
  const usage = `
用法:
  node skills/maimai-recruiting-coach/scripts/run-memory-workflow.js <command> [options]

命令:
  execute       执行匹配流程; 无匹配自动进入学习模式
  create-draft  从输入 JSON 生成待审核流程草稿
  promote       将草稿人工确认后入库/升级版本

execute 参数:
  --job-family <string>        岗位族，例如 backend-engineer
  --task-type <string>         场景，例如 greeting
  --context <json-file>        页面上下文 JSON
  --adapter <json-file>        Mock 执行结果 JSON（可选）
  --adapter-mode <mock|playwright> 适配器模式，默认 mock
  --list-url <url>             Playwright 模式目标页面 URL（可选）
  --headless <true|false>      Playwright 是否无头，默认 false
  --storage-state <json-file>  Playwright 登录态文件（可选）
  --context-markers <list>     Playwright 页面标记选择器，逗号分隔（可选）
  --allowed-hosts <list>       Playwright 允许域名后缀，默认 maimai.cn
  --learning-wait-ms <n>       学习模式等待用户操作时长（毫秒，默认 20000）
  --learning-selector-hints <json-file> 学习模式选择器提示（可选）
  --learning-draft <json-file> 学习模式草稿输入（仅无匹配时生效）
  --draft-output <json-file>   学习模式输出草稿路径（可选）
  --confirm-send               标记本次允许发送打招呼（默认不发送）
  --template-name <string>     学习模式前兜底复用成功路径时的模板名（可选）
  --page-signature <string>    成功路径匹配签名（可选）
  --reuse-success-path <mode>  auto|on|off，默认 auto（可选）
  --fallback-output <json-file> 学习模式兜底命中时输出 apply-ops（可选）
  --path-memory <path>         成功路径记忆库路径（可选）
  --memory <path>              覆盖流程记忆库路径（可选）
  --runs <path>                覆盖运行日志路径（可选）

create-draft 参数:
  --input <json-file>          草稿输入（job_family/task_type/steps/selectors/page_signature）
  --output <json-file>         输出草稿 JSON 文件

promote 参数:
  --draft <json-file>          草稿 JSON 文件
  --approved-by <name>         人工确认人
  --note <text>                审核备注（可选）
  --memory <path>              覆盖流程记忆库路径（可选）
  --runs <path>                覆盖运行日志路径（可选）
`;
  // eslint-disable-next-line no-console
  console.log(usage.trim());
}

function buildService(args) {
  return new WorkflowService({
    memoryPath: args.memory ? resolve(args.memory) : undefined,
    runsPath: args.runs ? resolve(args.runs) : undefined
  });
}

async function buildAdapter(args, context) {
  const mode = String(args["adapter-mode"] ?? "mock").trim().toLowerCase();
  if (mode !== "playwright") {
    const adapterPayload = args.adapter ? await readJsonFile(args.adapter) : {};
    const learningDraft = args["learning-draft"] ? await readJsonFile(args["learning-draft"]) : null;
    return {
      adapter: new MockAdapter({
        pageContext: context,
        stepOutcomes: adapterPayload.step_outcomes ?? {},
        riskSignals: adapterPayload.risk_signals ?? [],
        learningDraft
      }),
      close: async () => {}
    };
  }

  let playwright;
  try {
    playwright = await import("playwright");
  } catch (error) {
    throw new Error(
      `当前环境缺少 playwright 依赖，请先安装后重试（npm i playwright）。原始错误: ${String(error?.message ?? error)}`
    );
  }

  const launchOptions = {
    headless: toBoolean(args.headless, false)
  };
  const browser = await playwright.chromium.launch(launchOptions);
  const contextOptions = {};
  if (args["storage-state"]) {
    contextOptions.storageState = resolve(String(args["storage-state"]));
  }
  const browserContext = await browser.newContext(contextOptions);
  const page = await browserContext.newPage();
  const listUrl = String(args["list-url"] ?? "").trim();
  if (listUrl) {
    await page.goto(listUrl, { waitUntil: "domcontentloaded" });
  }
  const selectorHints = args["learning-selector-hints"]
    ? await readJsonFile(args["learning-selector-hints"])
    : {};
  const adapter = new PlaywrightRecruitingAdapter(page, {
    listUrl,
    contextMarkers: splitList(args["context-markers"]),
    allowedHostSuffixes: splitList(args["allowed-hosts"]),
    learningMode: true,
    learningWaitMs: Number(args["learning-wait-ms"] ?? 20000),
    learningSelectorHints: selectorHints
  });
  return {
    adapter,
    close: async () => {
      await browserContext.close();
      await browser.close();
    }
  };
}

async function runExecute(args) {
  if (!args["job-family"] || !args["task-type"]) {
    throw new Error("execute 需要 --job-family 与 --task-type。");
  }

  const context = args.context ? await readJsonFile(args.context) : {};
  const { adapter, close } = await buildAdapter(args, context);

  const service = buildService(args);
  let result;
  try {
    result = await service.execute(
      {
        jobFamily: args["job-family"],
        taskType: args["task-type"],
        pageContext: context,
        manualSendConfirm: Boolean(args["confirm-send"])
      },
      adapter
    );
  } finally {
    await close();
  }

  let fallbackApply = null;
  if (result.mode === "learn") {
    const templateName = args["template-name"] ?? "";
    const reuseMode = args["reuse-success-path"] ?? "auto";
    if (templateName && reuseMode !== "off") {
      fallbackApply = await resolveApplyOperations(
        {
          templateName,
          pageSignature: args["page-signature"] ?? "",
          generatedOperations: [],
          reuseMode
        },
        args["path-memory"]
      );
      if (args["fallback-output"] && Array.isArray(fallbackApply.operations)) {
        const payload = {
          generated_at: new Date().toISOString(),
          mode: "learning-fallback",
          template_name: templateName,
          apply_ops_source: fallbackApply.apply_ops_source,
          path_reuse_miss_reason: fallbackApply.path_reuse_miss_reason,
          selected_path_id: fallbackApply.selected_path_id,
          operations: fallbackApply.operations
        };
        await writeFile(resolve(args["fallback-output"]), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      }
    }
  }

  if (result.mode === "learn" && result.draftWorkflow && args["draft-output"]) {
    await writeFile(resolve(args["draft-output"]), `${JSON.stringify(result.draftWorkflow, null, 2)}\n`, "utf8");
  }
  const output = fallbackApply
    ? {
        ...result,
        fallback_apply_ops: {
          apply_ops_source: fallbackApply.apply_ops_source,
          path_reuse_miss_reason: fallbackApply.path_reuse_miss_reason,
          selected_path_id: fallbackApply.selected_path_id,
          operations_count: Array.isArray(fallbackApply.operations) ? fallbackApply.operations.length : 0
        }
      }
    : result;
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(output, null, 2));
}

async function runCreateDraft(args) {
  if (!args.input || !args.output) {
    throw new Error("create-draft 需要 --input 与 --output。");
  }
  const payload = await readJsonFile(args.input);
  const service = buildService(args);
  const draft = service.createDraftWorkflow(payload);
  await writeFile(resolve(args.output), `${JSON.stringify(draft, null, 2)}\n`, "utf8");
  // eslint-disable-next-line no-console
  console.log(`草稿已写入: ${resolve(args.output)}`);
}

async function runPromote(args) {
  if (!args.draft || !args["approved-by"]) {
    throw new Error("promote 需要 --draft 与 --approved-by。");
  }

  const draft = await readJsonFile(args.draft);
  const service = buildService(args);
  const promoted = await service.promoteDraft({
    draftWorkflow: draft,
    approvedBy: args["approved-by"],
    approvalNote: args.note ?? ""
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(promoted, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command] = args._;

  if (!command || args.help || args.h) {
    printUsage();
    process.exit(0);
  }

  if (command === "execute") {
    await runExecute(args);
    return;
  }

  if (command === "create-draft") {
    await runCreateDraft(args);
    return;
  }

  if (command === "promote") {
    await runPromote(args);
    return;
  }

  throw new Error(`未知命令: ${command}`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`执行失败: ${error.message}`);
  process.exit(1);
});

