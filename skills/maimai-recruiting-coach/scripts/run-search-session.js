#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readJsonFile } from "./lib/candidate-storage.js";
import { resolveGreetingWritePolicy } from "./lib/greeting-policy.js";
import {
  buildDefaultPageSignature,
  parsePageManifest,
  parseTemplateNames,
  resolveTemplatePageConfig,
  validateCandidateReviewRules
} from "./lib/search-session.js";
import {
  mergeRuntimeConfig,
  pickFirstNonEmpty,
  readRuntimeConfig,
  sanitizeConfigPatch
} from "./lib/runtime-config.js";

const SCRIPT_ROOT = resolve("skills/maimai-recruiting-coach/scripts");

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

function toPositiveInteger(value, fallbackValue) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return fallbackValue;
  }
  return Math.trunc(n);
}

function sanitizeSlug(value) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_");
  return normalized || "template";
}

function parseJsonFromOutput(rawText) {
  const text = String(rawText ?? "").trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    // Keep scanning below.
  }

  for (let idx = text.lastIndexOf("{"); idx >= 0; idx = text.lastIndexOf("{", idx - 1)) {
    const maybe = text.slice(idx).trim();
    try {
      return JSON.parse(maybe);
    } catch {
      // try previous "{"
    }
  }
  return null;
}

class CommandExecutionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CommandExecutionError";
    this.details = details;
  }
}

async function runNodeScript(scriptName, args, options = {}) {
  const scriptPath = resolve(SCRIPT_ROOT, scriptName);
  const cmdArgs = [scriptPath, ...args];

  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, cmdArgs, {
      cwd: options.cwd ?? process.cwd(),
      env: process.env
    });

    let stdoutText = "";
    let stderrText = "";
    child.stdout.on("data", (chunk) => {
      stdoutText += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrText += String(chunk);
    });
    child.on("error", (error) => {
      rejectResult(
        new CommandExecutionError(`命令启动失败: ${scriptName}`, {
          script: scriptName,
          args,
          error: String(error?.message ?? error)
        })
      );
    });
    child.on("close", (code) => {
      const payload = {
        code: Number(code ?? 1),
        script: scriptName,
        args,
        stdout: stdoutText,
        stderr: stderrText,
        json: parseJsonFromOutput(stdoutText)
      };
      if (payload.code !== 0) {
        rejectResult(
          new CommandExecutionError(`命令执行失败(${payload.code}): ${scriptName}`, {
            ...payload
          })
        );
        return;
      }
      resolveResult(payload);
    });
  });
}

function buildAuthArgs(args) {
  const out = [];
  if (args["app-id"]) {
    out.push("--app-id", String(args["app-id"]));
  }
  if (args["app-secret"]) {
    out.push("--app-secret", String(args["app-secret"]));
  }
  return out;
}

async function confirmTemplateList(templateNames, args) {
  const confirmTemplates = toBoolean(args["confirm-templates"], true);
  if (!confirmTemplates) {
    return;
  }
  if (toBoolean(args.confirmed, false)) {
    return;
  }

  const summary = templateNames.map((name, idx) => `${idx + 1}. ${name}`).join("\n");
  // eslint-disable-next-line no-console
  console.log(`本轮将执行以下职位模板：\n${summary}`);

  if (!input.isTTY) {
    throw new Error("当前为非交互环境，无法确认模板清单；可加 --confirmed 跳过确认");
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question("请输入 YES 确认继续执行: ")).trim();
    if (answer !== "YES") {
      throw new Error("未通过模板清单确认，已停止执行");
    }
  } finally {
    rl.close();
  }
}

async function loadManifestMap(args) {
  if (!args["page-manifest"]) {
    return new Map();
  }
  const raw = await readJsonFile(resolve(String(args["page-manifest"])));
  return parsePageManifest(raw);
}

function parseDefaultPageFiles(args) {
  if (!args["page-files"]) {
    return [];
  }
  return parseTemplateNames(args["page-files"]);
}

function resolveBaseUrl(args, argKey, envKey, runtimeConfig = {}) {
  const direct = String(args[argKey] ?? "").trim();
  if (direct) {
    return direct;
  }
  const fromEnv = String(process.env[envKey] ?? "").trim();
  if (fromEnv) {
    args[argKey] = fromEnv;
    return fromEnv;
  }
  const fromConfig = String(runtimeConfig[argKey.replaceAll("-", "_")] ?? "").trim();
  if (fromConfig) {
    args[argKey] = fromConfig;
    return fromConfig;
  }
  return "";
}

function buildTemplateStatus({
  paused,
  failedPages,
  pagesTotal,
  setupFailed
}) {
  if (setupFailed) {
    return "failed";
  }
  if (paused) {
    return "paused";
  }
  if (failedPages > 0) {
    return "partial";
  }
  if (pagesTotal === 0) {
    return "failed";
  }
  return "success";
}

function truncateText(value, maxLength = 300) {
  const text = String(value ?? "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function buildResultSummaryText(templateResult) {
  const coverage =
    templateResult.core_field_total_count > 0
      ? `${((templateResult.core_field_real_count / templateResult.core_field_total_count) * 100).toFixed(1)}%`
      : "0.0%";
  const parts = [
    `pages=${templateResult.pages_total}`,
    `ok=${templateResult.pages_succeeded}`,
    `failed=${templateResult.pages_failed}`,
    `source_candidates=${templateResult.source_candidates}`,
    `synced=${templateResult.synced_candidates}`,
    `verified=${templateResult.verified_candidates}`,
    `pending=${templateResult.pending_candidates}`,
    `real_coverage=${coverage}`,
    `placeholder_intercepts=${templateResult.placeholder_intercepted_count}`,
    `greeting_generated=${templateResult.greeting_generated}`,
    `retries=${templateResult.page_retry_total}`,
    `apply_source=${templateResult.apply_ops_source || "unknown"}`
  ];
  if (templateResult.realtime_capture_enabled) {
    parts.push(`realtime_captured=${Number(templateResult.realtime_captured_count ?? 0)}`);
    parts.push(`realtime_pages=${Number(templateResult.realtime_pages_processed ?? 0)}/${Number(templateResult.realtime_pages_total ?? 0)}`);
    parts.push(`realtime_scanned=${Number(templateResult.realtime_cards_scanned ?? 0)}`);
    parts.push(`realtime_skipped=${Number(templateResult.realtime_skipped_count ?? 0)}`);
    parts.push(`realtime_detail_reviewed=${Number(templateResult.realtime_detail_reviewed_count ?? 0)}`);
  }
  if (templateResult.online_filter_enabled) {
    parts.push(`critical_blocked=${Number(templateResult.online_critical_blocked_count ?? 0)}`);
    parts.push(`critical_unconfirmed=${Number(templateResult.online_critical_unconfirmed_count ?? 0)}`);
  }
  if (templateResult.paused_reason) {
    parts.push(`paused_reason=${truncateText(templateResult.paused_reason, 80)}`);
  }
  if (templateResult.sync_skipped) {
    parts.push(`sync_skipped=${templateResult.sync_skip_reason || "true"}`);
  } else {
    parts.push(`sync_mode=${templateResult.sync_mode || "template_batch"}`);
  }
  if (Number(templateResult.evaluation_rule_warning_count ?? 0) > 0) {
    parts.push(`rule_warnings=${Number(templateResult.evaluation_rule_warning_count ?? 0)}`);
  }
  return truncateText(parts.join("; "), 500);
}

function buildTemplateSuggestion(templateResult) {
  const triggers = [];
  const actions = [];
  const diffHints = [];
  const totalReviewed = Math.max(0, Number(templateResult.source_candidates ?? 0));
  const pending = Math.max(0, Number(templateResult.pending_candidates ?? 0));
  const synced = Math.max(0, Number(templateResult.synced_candidates ?? 0));
  const failedPages = Math.max(0, Number(templateResult.pages_failed ?? 0));
  const coverage =
    Number(templateResult.core_field_total_count ?? 0) > 0
      ? Number(templateResult.core_field_real_count ?? 0) / Number(templateResult.core_field_total_count ?? 0)
      : 1;

  if (failedPages > 0) {
    triggers.push(`存在失败页(${failedPages})`);
    actions.push("优先检查本模板页面结构变化与选择器稳定性");
    diffHints.push("补充页面签名与备用选择器，降低失败率");
  }
  if (pending > 0 && totalReviewed > 0 && pending / totalReviewed >= 0.3) {
    triggers.push(`待补全候选人占比较高(${Math.round((pending / totalReviewed) * 100)}%)`);
    actions.push("提高详情页与附件复核比例，避免仅卡片信息入库");
    diffHints.push("增加“有附件简历/近期有动向”等智能筛选门槛");
  }
  if (coverage < 0.75) {
    triggers.push(`核心字段覆盖率偏低(${Math.round(coverage * 100)}%)`);
    actions.push("补齐教育/履历核心字段采集规则");
    diffHints.push("提高候选人详情采集深度并开启占位拦截复核");
  }
  if (synced === 0 && totalReviewed > 0) {
    triggers.push("本轮无候选人入库");
    actions.push("放宽关键词逻辑或扩大城市/行业范围后再试");
    diffHints.push("建议关键词逻辑从“所有”调整为“任一”或降低硬性边界");
  }
  if (templateResult.online_filter_enabled && !templateResult.online_filter_applied) {
    triggers.push("在线筛选闭环未完成");
    actions.push("检查在线 selector-map 配置并重跑在线筛选");
    diffHints.push("完善字段映射与摘要抓取选择器");
  }
  if (Number(templateResult.online_critical_blocked_count ?? 0) > 0) {
    triggers.push(`模板关键字段脚本覆盖不足(${templateResult.online_critical_blocked_count})`);
    actions.push("按覆盖清单补齐关键字段 selector-map，未覆盖字段改为 AI 接管");
    diffHints.push("增加字段映射并开启关键字段缺失门禁");
  }
  if (Number(templateResult.online_critical_unconfirmed_count ?? 0) > 0) {
    triggers.push(`筛选后关键字段未确认(${templateResult.online_critical_unconfirmed_count})`);
    actions.push("补充筛选摘要 capture_selectors，确保页面回读可验证");
    diffHints.push("对关键字段增加页面摘要反校验");
  }
  const realtimeErrors = Array.isArray(templateResult.realtime_capture_errors)
    ? templateResult.realtime_capture_errors
    : [];
  if (templateResult.realtime_capture_enabled && realtimeErrors.length > 0) {
    triggers.push(`realtime 采集存在异常(${realtimeErrors.length})`);
    actions.push("检查候选人详情采集 selector-map 与登录态有效性");
    diffHints.push("补充详情抽屉根节点与附件链接选择器，降低抓取异常");
  }
  if (
    templateResult.realtime_capture_enabled &&
    Number(templateResult.realtime_captured_count ?? 0) === 0 &&
    totalReviewed === 0
  ) {
    triggers.push("realtime 采集结果为空");
    actions.push("确认筛选条件已生效，并核对当前页面是否有候选人可见");
    diffHints.push("必要时放宽筛选条件或增加滚动加载策略");
  }

  const level = triggers.length >= 3 ? "high" : triggers.length >= 1 ? "medium" : "low";
  const summary =
    triggers.length === 0
      ? "本轮执行稳定，无需立即调整模板，可继续复用当前版本。"
      : `建议优化：${actions.slice(0, 2).join("；")}`;
  return {
    level,
    triggers,
    actions,
    diff_hints: diffHints,
    summary
  };
}

function buildPageSignature(templateName, filterBaseUrl, globalPageSignature) {
  const configured = String(globalPageSignature ?? "").trim();
  if (configured) {
    return configured.replaceAll("{template}", templateName);
  }
  return buildDefaultPageSignature(templateName, filterBaseUrl);
}

function parseJsonObject(value) {
  if (!value) {
    return null;
  }
  if (typeof value === "object") {
    return value;
  }
  const text = String(value).trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toFiniteNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return null;
}

function parseDetailEvaluationRuleFromScenario(scenario = {}) {
  const payload = parseJsonObject(scenario["筛选条件JSON"]);
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const rule = payload.detail_evaluation_rule;
  if (!rule || typeof rule !== "object") {
    return null;
  }
  return rule;
}

function resolveEvaluationThresholds(rule = null) {
  if (!rule || typeof rule !== "object") {
    return null;
  }
  const thresholds = rule.thresholds ?? {};
  const contactMin = toFiniteNumber(
    thresholds.contact_min,
    thresholds.contact_min_score,
    thresholds.contact?.min,
    thresholds["可沟通最低分"],
    85
  );
  const holdMin = toFiniteNumber(
    thresholds.hold_min,
    thresholds.hold_min_score,
    thresholds.hold?.min,
    thresholds["储备观察最低分"],
    70
  );
  const holdMax = toFiniteNumber(
    thresholds.hold_max,
    thresholds.hold_max_score,
    thresholds.hold?.max,
    thresholds["储备观察最高分"],
    contactMin !== null ? contactMin - 1 : 84
  );
  if (contactMin === null || holdMin === null || holdMax === null) {
    return null;
  }
  return {
    contact_min: contactMin,
    hold_min: holdMin,
    hold_max: holdMax
  };
}

function expectedConclusionByScore(score, thresholds) {
  if (!thresholds || !Number.isFinite(score)) {
    return "";
  }
  if (score >= thresholds.contact_min) {
    return "可沟通";
  }
  if (score >= thresholds.hold_min && score <= thresholds.hold_max) {
    return "储备观察";
  }
  return "不合适";
}

function validateConclusionByScore(records = [], thresholds = null) {
  if (!Array.isArray(records) || !thresholds) {
    return [];
  }
  const warnings = [];
  for (const record of records) {
    const score = Number(record?.score);
    if (!Number.isFinite(score)) {
      continue;
    }
    const actual = String(record?.conclusion ?? "").trim();
    if (!["可沟通", "储备观察", "不合适"].includes(actual)) {
      continue;
    }
    const expected = expectedConclusionByScore(score, thresholds);
    if (!expected || expected === actual) {
      continue;
    }
    warnings.push({
      candidate_name: String(record?.candidate_name ?? "").trim(),
      score,
      conclusion: actual,
      expected
    });
  }
  return warnings;
}

function buildSyncArgsForInput({
  inputPath,
  templateName,
  args,
  greetingWritePolicy,
  authArgs
}) {
  const syncArgs = [
    "sync-feishu",
    "--input",
    resolve(inputPath),
    "--base-url",
    String(args["candidate-base-url"]),
    "--greeting-only-for",
    String(args["greeting-only-for"] ?? "可沟通"),
    "--greeting-write-policy",
    greetingWritePolicy
  ];

  if (toBoolean(args["greeting-from-template"], true)) {
    syncArgs.push(
      "--greeting-from-template",
      "--filter-base-url",
      String(args["filter-base-url"]),
      "--template-name",
      templateName
    );
  }
  if (toBoolean(args["dry-run"], false)) {
    syncArgs.push("--dry-run");
  }
  if (toBoolean(args["skip-attachment-upload"], false)) {
    syncArgs.push("--skip-attachment-upload");
  }
  if (args["attachment-cookie"]) {
    syncArgs.push("--attachment-cookie", String(args["attachment-cookie"]));
  }
  if (args["attachment-auth"]) {
    syncArgs.push("--attachment-auth", String(args["attachment-auth"]));
  }
  if (args["attachment-field-name"]) {
    syncArgs.push("--attachment-field-name", String(args["attachment-field-name"]));
  }
  if (args["attachment-temp-dir"]) {
    syncArgs.push("--attachment-temp-dir", String(args["attachment-temp-dir"]));
  }
  if (toBoolean(args["keep-attachment-files"], false)) {
    syncArgs.push("--keep-attachment-files");
  }
  if (args["high-score-threshold"]) {
    syncArgs.push("--high-score-threshold", String(args["high-score-threshold"]));
  }
  if (args["shortlist-top-n"]) {
    syncArgs.push("--shortlist-top-n", String(args["shortlist-top-n"]));
  }
  if (args["shortlist-output"]) {
    syncArgs.push("--shortlist-output", String(args["shortlist-output"]));
  }
  if (toBoolean(args["disable-shortlist-output"], false)) {
    syncArgs.push("--disable-shortlist-output");
  }
  syncArgs.push(...authArgs);
  return syncArgs;
}

async function syncTemplateBatch({
  inputPath,
  templateName,
  args,
  greetingWritePolicy,
  authArgs
}) {
  const syncArgs = buildSyncArgsForInput({
    inputPath,
    templateName,
    args,
    greetingWritePolicy,
    authArgs
  });
  const syncRes = await runNodeScript("run-candidate-pipeline.js", syncArgs);
  return syncRes.json ?? {};
}

function printUsage() {
  // eslint-disable-next-line no-console
  console.log(
    [
      "用法:",
      "  node skills/maimai-recruiting-coach/scripts/run-search-session.js --template-names <A,B,...> --filter-base-url <url> --candidate-base-url <url> [options]",
      "",
      "关键参数:",
      "  --template-names <list>                 本轮职位模板名称，逗号或分号分隔",
      "  --use-existing-templates <true|false>   未传 template-names 时自动拉取启用模板，默认 false",
      "  --template-limit <n>                    自动拉取模板数量上限，默认 5",
      "  --confirm-templates <true|false>        执行前确认模板清单，默认 true",
      "  --confirmed                              非交互执行时显式确认模板清单",
      "  --config <json-file>                    本地配置文件（默认 data/maimai-runtime-config.json）",
      "  --filter-base-url <url>                 职位模板飞书多维表 URL（可省略，回退 FEISHU_FILTER_BASE_URL）",
      "  --candidate-base-url <url>              候选人飞书多维表 URL（可省略，回退 FEISHU_CANDIDATE_BASE_URL）",
      "  --page-manifest <json-file>             模板与分页原始评估文件映射",
      "  --page-files <list>                     全模板共用分页原始评估文件列表",
      "  --page-signature <sig>                  成功路径匹配签名（支持 {template}）",
      "  --max-retry-per-page <n>                单页失败最大重试次数，默认 2",
      "  --pause-on-consecutive-page-failures <n> 连续失败页数阈值，默认 2",
      "  --greeting-only-for <结论>              默认 可沟通",
      "  --greeting-write-policy <empty_only|overwrite> 默认 empty_only",
      "  --enforce-evaluation-rule <true|false>  严格执行模板评分阈值（默认 false，告警不中断）",
      "  --sync-filter-runtime <true|false>      每轮开始将运行态筛选条件回写职位模板表，默认 true",
      "  --dry-run                               仅预览，不写入飞书",
      "  --work-dir <dir>                        会话中间产物目录，默认 data/search-session-runs",
      "  --session-output <json-file>            会话汇总输出，默认 data/search-session.last.json",
      "  --path-memory <json-file>               成功路径记忆库覆盖路径（可选）",
      "  --execution-mode <offline|online|realtime> 执行模式；online/realtime 会默认启用在线筛选",
      "  --online-filter <true|false>            是否执行在线筛选闭环，默认 false",
      "  --online-filter-required <true|false>   在线筛选失败时是否中断，默认 false",
      "  --reuse-success-path <auto|exact|on|off> 构建 apply-ops 复用策略；在线模式默认 exact",
      "  --online-reuse-success-path <auto|exact|on|off> 在线筛选阶段复用策略，默认 exact",
      "  --allow-online-fallback-reuse <true|false> 在线筛选是否允许 fallback 复用，默认 false",
      "  --allow-online-missing-critical <true|false> 在线筛选关键字段缺失是否放行，默认 false",
      "  --online-selector-map <json-file>       在线筛选字段映射配置（启用在线筛选时必填）",
      "  --maimai-list-url <url>                 脉脉候选人页面 URL（启用在线筛选时必填）",
      "  --online-capture-selectors <list>       在线筛选摘要抓取选择器，逗号分隔（可选）",
      "  --wait-after-apply-ms <n>               在线应用筛选后等待毫秒数，默认 1200",
      "  --login-wait-ms <n>                     未登录时等待手动登录毫秒数，默认 180000",
      "  --online-candidate-selector-map <json-file> realtime 候选人详情采集选择器映射（可选）",
      "  --online-candidate-max <n>              realtime 模式最多保留候选人数，默认 500",
      "  --online-candidate-max-pages <n>        realtime 模式最多翻页数，默认 50",
      "  --online-candidate-output <file>        realtime 原始候选人输出文件名（写入模板目录）",
      "  --online-candidate-wait-after-open-ms <n> realtime 打开列表后等待毫秒数，默认 1200",
      "  --online-candidate-wait-after-click-ms <n> realtime 打开详情后等待毫秒数，默认 900",
      "  --online-candidate-next-page-wait-ms <n> realtime 翻页后等待毫秒数，默认 1400",
      "  --online-capture-timeout-ms <n>         realtime 详情抓取超时毫秒数，默认 15000",
      "  --headless <true|false>                 在线筛选浏览器无头模式，默认 false",
      "  --browser-profile-dir <dir>             脉脉自动化独立浏览器空间目录（建议配置）",
      "  --storage-state <json-file>             Playwright 登录态文件（可选）",
      "  --save-storage-state <json-file>        执行后落盘最新登录态（可选）",
      "  --humanize <true|false>                 在线执行拟人化节奏，默认 true",
      "  --skip-attachment-upload <true|false>   是否跳过附件上传（默认 false）",
      "  --attachment-cookie <cookie>            附件下载 Cookie（未提供时回退环境变量）",
      "  --attachment-auth <token>               附件下载 Authorization（可选）",
      "  --attachment-temp-dir <dir>             附件临时下载目录（可选）",
      "  --keep-attachment-files <true|false>    是否保留附件临时文件（默认 false）"
    ].join("\n")
  );
}

async function processOnePage({
  pageIndex,
  pageFile,
  templateDir,
  evaluationThresholds,
  enforceEvaluationRule
}) {
  const pageLabel = `p${String(pageIndex + 1).padStart(2, "0")}`;
  const normalizedPath = resolve(templateDir, `${pageLabel}.normalized.json`);
  const normalizedArgs = ["normalize", "--input", resolve(pageFile), "--output", normalizedPath];
  await runNodeScript("run-candidate-pipeline.js", normalizedArgs);

  const normalizedRecords = await readJsonFile(normalizedPath);
  const violations = validateCandidateReviewRules(normalizedRecords);
  if (violations.length > 0) {
    const first = violations[0];
    throw new Error(`候选人评估校验未通过: ${first.message} (index=${first.index})`);
  }
  const ruleWarnings = validateConclusionByScore(normalizedRecords, evaluationThresholds);
  if (enforceEvaluationRule && ruleWarnings.length > 0) {
    const first = ruleWarnings[0];
    throw new Error(
      `候选人评分阈值校验失败: ${first.candidate_name || "unknown"} score=${first.score}, conclusion=${first.conclusion}, expected=${first.expected}`
    );
  }
  return {
    source_count: Number(normalizedRecords.length ?? 0),
    normalized_path: normalizedPath,
    evaluation_rule_checked: Boolean(evaluationThresholds),
    evaluation_rule_warning_count: ruleWarnings.length,
    evaluation_rule_warnings: ruleWarnings.slice(0, 20)
  };
}

async function runOnlineFilterCycle({
  templateName,
  pageSignature,
  runtimePath,
  applyOpsPath,
  templateDir,
  args
}) {
  const selectorMapPath = String(args["online-selector-map"] ?? "").trim();
  if (!selectorMapPath) {
    throw new Error("启用 --online-filter 时必须提供 --online-selector-map");
  }
  const listUrl = String(args["maimai-list-url"] ?? "").trim();
  if (!listUrl) {
    throw new Error("启用 --online-filter 时必须提供 --maimai-list-url");
  }

  const onlineArgs = [
    "--runtime",
    runtimePath,
    "--apply-ops",
    applyOpsPath,
    "--selector-map",
    resolve(selectorMapPath),
    "--template-name",
    templateName,
    "--page-signature",
    pageSignature,
    "--list-url",
    listUrl,
    "--headless",
    String(toBoolean(args.headless, false)),
    "--summary-output",
    resolve(templateDir, "filter-summary.online.raw.json"),
    "--coverage-output",
    resolve(templateDir, "filter-coverage.online.json"),
    "--reuse-success-path",
    String(args["online-reuse-success-path"] ?? "exact"),
    "--allow-fallback-reuse",
    String(toBoolean(args["allow-online-fallback-reuse"], false)),
    "--allow-missing-critical",
    String(toBoolean(args["allow-online-missing-critical"], false))
  ];
  if (args["wait-after-apply-ms"]) {
    onlineArgs.push("--wait-after-apply-ms", String(args["wait-after-apply-ms"]));
  }
  if (args["path-memory"]) {
    onlineArgs.push("--path-memory", String(args["path-memory"]));
  }
  if (args["login-wait-ms"]) {
    onlineArgs.push("--login-wait-ms", String(args["login-wait-ms"]));
  }
  if (args["online-capture-selectors"]) {
    onlineArgs.push("--capture-selectors", String(args["online-capture-selectors"]));
  }
  if (args["storage-state"]) {
    onlineArgs.push("--storage-state", String(args["storage-state"]));
  }
  if (args["browser-profile-dir"]) {
    onlineArgs.push("--profile-dir", String(args["browser-profile-dir"]));
  }
  if (args["save-storage-state"]) {
    onlineArgs.push("--save-storage-state", String(args["save-storage-state"]));
  } else if (args["storage-state"]) {
    onlineArgs.push("--save-storage-state", String(args["storage-state"]));
  }
  if (args.humanize !== undefined) {
    onlineArgs.push("--humanize", String(toBoolean(args.humanize, true)));
  }
  const onlineRes = await runNodeScript("run-online-filter-cycle.js", onlineArgs);
  const onlineJson = onlineRes.json ?? {};
  let coverage = null;
  const coveragePath = String(onlineJson.coverage_output ?? resolve(templateDir, "filter-coverage.online.json")).trim();
  if (coveragePath) {
    try {
      coverage = await readJsonFile(resolve(coveragePath));
    } catch {
      coverage = null;
    }
  }
  return {
    ...onlineJson,
    coverage
  };
}

async function runRealtimeCandidateCapture({
  templateName,
  runtimePath,
  applyOpsPath,
  templateDir,
  args
}) {
  const allowOnlineCaptureScript = toBoolean(args["allow-online-capture-script"], false);
  const onlineCandidateInput = String(args["online-candidate-input"] ?? "").trim();
  if (!allowOnlineCaptureScript) {
    if (!onlineCandidateInput) {
      throw new Error(
        "realtime 模式默认禁用 run-online-candidate-capture.js；请先用 AI 接管页面采集候选人，再通过 --online-candidate-input 传入原始 JSON"
      );
    }
    const inputPath = resolve(onlineCandidateInput);
    const inputJson = await readJsonFile(inputPath);
    const candidates = Array.isArray(inputJson)
      ? inputJson
      : Array.isArray(inputJson?.candidates)
        ? inputJson.candidates
        : [];
    const summary = inputJson?.summary ?? {};
    return {
      raw_output: inputPath,
      captured_count: Number(summary.captured_count ?? candidates.length ?? 0),
      errors: Array.isArray(summary.errors) ? summary.errors : [],
      pages_total: Number(summary.total_pages ?? summary.pages_total ?? 0),
      pages_processed: Number(summary.pages_processed ?? summary.total_pages ?? summary.pages_total ?? 0),
      cards_scanned: Number(summary.cards_scanned ?? 0),
      skipped_by_card: Number(summary.skipped_by_card ?? 0),
      detail_reviewed_count: Number(summary.detail_reviewed_count ?? 0),
      uncertain_count: Number(summary.included_uncertain_count ?? 0),
      matched_count: Number(summary.included_match_count ?? 0)
    };
  }

  const listUrl = String(args["maimai-list-url"] ?? "").trim();
  if (!listUrl) {
    throw new Error("realtime 模式缺少脉脉列表 URL：请传 --maimai-list-url 或在配置中提供 maimai_list_url");
  }
  const rawOutput = resolve(
    templateDir,
    String(args["online-candidate-output"] ?? "candidates.realtime.raw.json")
  );
  const captureArgs = [
    "--list-url",
    listUrl,
    "--runtime",
    runtimePath,
    "--apply-ops",
    applyOpsPath,
    "--template-name",
    templateName,
    "--output",
    rawOutput,
    "--max-candidates",
    String(toPositiveInteger(args["online-candidate-max"], 500)),
    "--headless",
    String(toBoolean(args.headless, false)),
    "--humanize",
    String(toBoolean(args.humanize, true))
  ];
  if (args["online-candidate-max-pages"]) {
    captureArgs.push("--max-pages", String(toPositiveInteger(args["online-candidate-max-pages"], 50)));
  }
  if (args["online-candidate-selector-map"]) {
    captureArgs.push("--selector-map", resolve(String(args["online-candidate-selector-map"])));
  }
  if (args["storage-state"]) {
    captureArgs.push("--storage-state", String(args["storage-state"]));
  }
  if (args["browser-profile-dir"]) {
    captureArgs.push("--profile-dir", String(args["browser-profile-dir"]));
  }
  if (args["save-storage-state"]) {
    captureArgs.push("--save-storage-state", String(args["save-storage-state"]));
  } else if (args["storage-state"]) {
    captureArgs.push("--save-storage-state", String(args["storage-state"]));
  }
  if (args["online-capture-timeout-ms"]) {
    captureArgs.push("--capture-timeout-ms", String(args["online-capture-timeout-ms"]));
  }
  if (args["online-candidate-wait-after-open-ms"]) {
    captureArgs.push("--wait-after-open-ms", String(args["online-candidate-wait-after-open-ms"]));
  }
  if (args["login-wait-ms"]) {
    captureArgs.push("--login-wait-ms", String(args["login-wait-ms"]));
  }
  if (args["online-candidate-wait-after-click-ms"]) {
    captureArgs.push("--wait-after-click-ms", String(args["online-candidate-wait-after-click-ms"]));
  }
  if (args["online-candidate-next-page-wait-ms"]) {
    captureArgs.push("--next-page-wait-ms", String(args["online-candidate-next-page-wait-ms"]));
  }
  const captureRes = await runNodeScript("run-online-candidate-capture.js", captureArgs);
  const captureJson = captureRes.json ?? {};
  const capturedCount = Number(captureJson.captured_count ?? 0);
  return {
    raw_output: rawOutput,
    captured_count: capturedCount,
    errors: Array.isArray(captureJson.errors) ? captureJson.errors : [],
    pages_total: Number(captureJson.total_pages ?? captureJson.pages_processed ?? 0),
    pages_processed: Number(captureJson.pages_processed ?? captureJson.total_pages ?? 0),
    cards_scanned: Number(captureJson.cards_scanned ?? 0),
    skipped_by_card: Number(captureJson.skipped_by_card ?? 0),
    detail_reviewed_count: Number(captureJson.detail_reviewed_count ?? 0),
    uncertain_count: Number(captureJson.included_uncertain_count ?? 0),
    matched_count: Number(captureJson.included_match_count ?? 0)
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printUsage();
    process.exit(0);
  }
  const runtimeConfigState = await readRuntimeConfig(args.config);
  const runtimeConfig = runtimeConfigState.config ?? {};
  const filterBaseUrl = resolveBaseUrl(args, "filter-base-url", "FEISHU_FILTER_BASE_URL", runtimeConfig);
  let candidateBaseUrl = resolveBaseUrl(
    args,
    "candidate-base-url",
    "FEISHU_CANDIDATE_BASE_URL",
    runtimeConfig
  );
  if (!filterBaseUrl) {
    throw new Error("缺少筛选表 URL：请传 --filter-base-url 或设置 FEISHU_FILTER_BASE_URL");
  }
  args["filter-base-url"] = filterBaseUrl;
  const initialStorageStatePath = pickFirstNonEmpty(
    args["storage-state"],
    runtimeConfig.storage_state_path
  );
  if (initialStorageStatePath) {
    args["storage-state"] = initialStorageStatePath;
  }
  const initialMaimaiListUrl = pickFirstNonEmpty(args["maimai-list-url"], runtimeConfig.maimai_list_url);
  if (initialMaimaiListUrl) {
    args["maimai-list-url"] = initialMaimaiListUrl;
  }
  const initialBrowserProfileDir = pickFirstNonEmpty(
    args["browser-profile-dir"],
    runtimeConfig.browser_profile_dir
  );
  if (initialBrowserProfileDir) {
    args["browser-profile-dir"] = initialBrowserProfileDir;
  }
  const initialOnlineSelectorMap = pickFirstNonEmpty(args["online-selector-map"], runtimeConfig.online_selector_map);
  if (initialOnlineSelectorMap) {
    args["online-selector-map"] = initialOnlineSelectorMap;
  }
  const initialOnlineCandidateSelectorMap = pickFirstNonEmpty(
    args["online-candidate-selector-map"],
    runtimeConfig.online_candidate_selector_map
  );
  if (initialOnlineCandidateSelectorMap) {
    args["online-candidate-selector-map"] = initialOnlineCandidateSelectorMap;
  }
  const initialOnlineCandidateInput = pickFirstNonEmpty(
    args["online-candidate-input"],
    runtimeConfig.online_candidate_input
  );
  if (initialOnlineCandidateInput) {
    args["online-candidate-input"] = initialOnlineCandidateInput;
  }
  const initialOnlineCaptureSelectors = pickFirstNonEmpty(
    args["online-capture-selectors"],
    runtimeConfig.online_capture_selectors
  );
  if (initialOnlineCaptureSelectors) {
    args["online-capture-selectors"] = initialOnlineCaptureSelectors;
  }
  const bootstrapPatch = sanitizeConfigPatch({
    filter_base_url: filterBaseUrl,
    candidate_base_url: candidateBaseUrl,
    maimai_list_url: args["maimai-list-url"],
    storage_state_path: args["storage-state"],
    browser_profile_dir: args["browser-profile-dir"],
    online_selector_map: args["online-selector-map"],
    online_candidate_selector_map: args["online-candidate-selector-map"],
    online_candidate_input: args["online-candidate-input"],
    online_capture_selectors: args["online-capture-selectors"],
    allow_online_capture_script: toBoolean(args["allow-online-capture-script"], false),
    execution_mode: args["execution-mode"]
  });
  if (Object.keys(bootstrapPatch).length > 0) {
    await mergeRuntimeConfig(bootstrapPatch, args.config);
  }

  const greetingWritePolicy = resolveGreetingWritePolicy(
    args["greeting-write-policy"],
    toBoolean(args["overwrite-greeting"], false)
  );
  const maxRetryPerPage = toPositiveInteger(args["max-retry-per-page"], 2);
  const pauseThreshold = Math.max(1, toPositiveInteger(args["pause-on-consecutive-page-failures"], 2));
  const enforceEvaluationRule = toBoolean(args["enforce-evaluation-rule"], false);
  const workDir = resolve(String(args["work-dir"] ?? "data/search-session-runs"));
  const sessionOutput = resolve(String(args["session-output"] ?? "data/search-session.last.json"));
  const manifestMap = await loadManifestMap(args);
  const defaultPageFiles = parseDefaultPageFiles(args);
  const authArgs = buildAuthArgs(args);
  let templateNames = parseTemplateNames(args["template-names"]);
  const useExistingTemplates = toBoolean(args["use-existing-templates"], false);
  if (templateNames.length === 0 && useExistingTemplates) {
    const limit = toPositiveInteger(args["template-limit"], 5);
    const listRes = await runNodeScript("run-filter-table-workflow.js", [
      "list-templates",
      "--base-url",
      String(args["filter-base-url"]),
      "--latest-only",
      "true",
      "--only-enabled",
      "true",
      "--limit",
      String(limit),
      ...authArgs
    ]);
    templateNames = Array.isArray(listRes?.json?.templates)
      ? listRes.json.templates
          .map((item) => String(item.template_name ?? "").trim())
          .filter(Boolean)
      : [];
  }
  if (templateNames.length === 0) {
    throw new Error("缺少 --template-names（或启用 --use-existing-templates 自动拉取）");
  }
  const executionMode = String(args["execution-mode"] ?? runtimeConfig.execution_mode ?? "")
    .trim()
    .toLowerCase();
  if (executionMode && !args["execution-mode"]) {
    args["execution-mode"] = executionMode;
  }
  const impliedOnline = executionMode === "online" || executionMode === "realtime";
  const isRealtimeMode = executionMode === "realtime";
  const onlineFilterEnabled = toBoolean(args["online-filter"], impliedOnline);
  const onlineFilterRequired = toBoolean(args["online-filter-required"], isRealtimeMode);

  await confirmTemplateList(templateNames, args);
  await mkdir(workDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const runId = startedAt.replace(/[:.]/g, "-");
  const templateResults = [];

  let sessionPaused = false;
  let pausedTemplateName = "";
  let pausedReason = "";

  for (let index = 0; index < templateNames.length; index += 1) {
    if (sessionPaused) {
      break;
    }
    const templateName = templateNames[index];
    const templateDir = resolve(workDir, `${String(index + 1).padStart(2, "0")}-${sanitizeSlug(templateName)}`);
    await mkdir(templateDir, { recursive: true });

    const pageConfig = resolveTemplatePageConfig({
      manifestMap,
      templateName,
      defaultPageFiles,
      globalPageSignature: args["page-signature"] ?? ""
    });
    const pageSignature = buildPageSignature(
      templateName,
      String(args["filter-base-url"]),
      pageConfig.page_signature
    );
    const runtimePath = resolve(templateDir, "active-filter.runtime.json");
    const applyOpsPath = resolve(templateDir, "active-filter.apply-ops.json");

    const templateResult = {
      template_name: templateName,
      template_record_id: "",
      page_signature: pageSignature,
      apply_ops_source: "",
      selected_path_id: "",
      online_filter_enabled: onlineFilterEnabled,
      online_filter_applied: false,
      online_filter_error: "",
      online_summary_item_count: 0,
      online_critical_blocked_count: 0,
      online_critical_unconfirmed_count: 0,
      online_script_coverage_rate: 0,
      pages_total: isRealtimeMode ? 1 : pageConfig.page_files.length,
      pages_succeeded: 0,
      pages_failed: 0,
      page_retry_total: 0,
      source_candidates: 0,
      synced_candidates: 0,
      sync_mode: "template_batch",
      sync_skipped: false,
      sync_skip_reason: "",
      merged_input_path: "",
      merged_input_count: 0,
      verified_candidates: 0,
      pending_candidates: 0,
      placeholder_intercepted_count: 0,
      core_field_total_count: 0,
      core_field_real_count: 0,
      greeting_generated: 0,
      evaluation_rule_checked: false,
      evaluation_rule_warning_count: 0,
      evaluation_rule_warnings: [],
      realtime_capture_enabled: isRealtimeMode,
      realtime_captured_count: 0,
      realtime_pages_total: 0,
      realtime_pages_processed: 0,
      realtime_cards_scanned: 0,
      realtime_skipped_count: 0,
      realtime_detail_reviewed_count: 0,
      realtime_capture_errors: [],
      status: "running",
      paused_reason: "",
      error: ""
    };

    let setupFailed = false;
    let consecutivePageFailures = 0;
    let evaluationThresholds = null;
    const normalizedPagePaths = [];

    try {
      const pullArgs = [
        "pull-active",
        "--base-url",
        String(args["filter-base-url"]),
        "--template-name",
        templateName,
        "--output",
        runtimePath,
        ...authArgs
      ];
      await runNodeScript("run-filter-table-workflow.js", pullArgs);
      const runtimePayload = await readJsonFile(runtimePath);
      evaluationThresholds = resolveEvaluationThresholds(
        parseDetailEvaluationRuleFromScenario(runtimePayload?.scenario ?? {})
      );
      if (evaluationThresholds) {
        templateResult.evaluation_rule_checked = true;
      }
      const recordId = String(runtimePayload?.scenario?.record_id ?? "").trim();
      const scenarioCandidateBaseUrl = String(runtimePayload?.scenario?.candidate_base_url ?? "").trim();
      const scenarioMaimaiListUrl = String(runtimePayload?.scenario?.maimai_list_url ?? "").trim();
      const scenarioStorageStatePath = String(runtimePayload?.scenario?.storage_state_path ?? "").trim();
      const scenarioBrowserProfileDir = String(runtimePayload?.scenario?.browser_profile_dir ?? "").trim();
      if (!candidateBaseUrl && scenarioCandidateBaseUrl) {
        candidateBaseUrl = scenarioCandidateBaseUrl;
      }
      if (candidateBaseUrl) {
        args["candidate-base-url"] = candidateBaseUrl;
      }
      if (!args["maimai-list-url"] && scenarioMaimaiListUrl) {
        args["maimai-list-url"] = scenarioMaimaiListUrl;
      }
      if (!args["storage-state"] && scenarioStorageStatePath) {
        args["storage-state"] = scenarioStorageStatePath;
      }
      if (!args["browser-profile-dir"] && scenarioBrowserProfileDir) {
        args["browser-profile-dir"] = scenarioBrowserProfileDir;
      }
      const runtimePatch = sanitizeConfigPatch({
        filter_base_url: filterBaseUrl,
        candidate_base_url: args["candidate-base-url"],
        maimai_list_url: args["maimai-list-url"],
        storage_state_path: args["storage-state"],
        browser_profile_dir: args["browser-profile-dir"],
        online_selector_map: args["online-selector-map"],
        online_candidate_selector_map: args["online-candidate-selector-map"],
        online_capture_selectors: args["online-capture-selectors"],
        execution_mode: args["execution-mode"]
      });
      if (Object.keys(runtimePatch).length > 0) {
        await mergeRuntimeConfig(runtimePatch, args.config);
      }
      templateResult.template_record_id = recordId;

      if (toBoolean(args["sync-filter-runtime"], true)) {
        const syncFilterArgs = [
          "--runtime",
          runtimePath,
          "--base-url",
          String(args["filter-base-url"]),
          "--template-name",
          templateName,
          "--update-existing",
          "true",
          "--change-note",
          `session-start ${new Date().toISOString()}`,
          ...authArgs
        ];
        if (recordId) {
          syncFilterArgs.push("--record-id", recordId);
        }
        await runNodeScript("sync-runtime-filter-to-feishu.js", syncFilterArgs);
      }

      if (recordId) {
        await runNodeScript("run-filter-table-workflow.js", [
          "mark-running",
          "--base-url",
          String(args["filter-base-url"]),
          "--record-id",
          recordId,
          ...authArgs
        ]);
      }

      const buildApplyArgs = [
        "build-apply-ops",
        "--runtime",
        runtimePath,
        "--output",
        applyOpsPath,
        "--template-name",
        templateName,
        "--reuse-success-path",
        String(args["reuse-success-path"] ?? (onlineFilterEnabled ? "exact" : "on")),
        "--page-signature",
        pageSignature
      ];
      if (args["path-memory"]) {
        buildApplyArgs.push("--memory", String(args["path-memory"]));
      }
      const applyRes = await runNodeScript("run-maimai-filter-bridge.js", buildApplyArgs);
      const applyPayload = applyRes.json ?? (await readJsonFile(applyOpsPath));
      templateResult.apply_ops_source = String(applyPayload?.apply_ops_source ?? "");
      templateResult.selected_path_id = String(applyPayload?.selected_path_id ?? "");

      if (onlineFilterEnabled) {
        try {
          const onlineResult = await runOnlineFilterCycle({
            templateName,
            pageSignature,
            runtimePath,
            applyOpsPath,
            templateDir,
            args
          });
          templateResult.online_filter_applied = true;
          templateResult.online_summary_item_count = Number(onlineResult?.summary_item_count ?? 0);
          if (typeof onlineResult?.apply_ops_source === "string" && onlineResult.apply_ops_source) {
            templateResult.apply_ops_source = onlineResult.apply_ops_source;
          }
          if (typeof onlineResult?.selected_path_id === "string" && onlineResult.selected_path_id) {
            templateResult.selected_path_id = onlineResult.selected_path_id;
          }
          if (onlineResult?.coverage?.checklist) {
            templateResult.online_critical_blocked_count = Number(
              onlineResult.coverage.checklist.critical_blocked_count ?? 0
            );
            templateResult.online_script_coverage_rate = Number(
              onlineResult.coverage.checklist.script_coverage_rate ?? 0
            );
          }
          if (onlineResult?.coverage?.summary_coverage) {
            templateResult.online_critical_unconfirmed_count = Number(
              onlineResult.coverage.summary_coverage.critical_unconfirmed_count ?? 0
            );
          }

          if (toBoolean(args["sync-filter-runtime"], true) && recordId) {
            await runNodeScript("sync-runtime-filter-to-feishu.js", [
              "--runtime",
              runtimePath,
              "--base-url",
              String(args["filter-base-url"]),
              "--template-name",
              templateName,
              "--update-existing",
              "true",
              "--record-id",
              recordId,
              "--change-note",
              `online-filter-capture ${new Date().toISOString()}`,
              ...authArgs
            ]);
          }
        } catch (error) {
          templateResult.online_filter_error = truncateText(String(error?.message ?? error), 240);
          if (onlineFilterRequired) {
            throw error;
          }
        }
      }

      if (!String(args["candidate-base-url"] ?? "").trim()) {
        throw new Error(
          "缺少候选人表 URL：请传 --candidate-base-url，或在模板表当前模板行补充字段 candidate_base_url/候选人表URL"
        );
      }

      const pageSources = [];
      if (isRealtimeMode) {
        pageSources.push({
          mode: "realtime",
          pageIndex: 0
        });
      } else {
        if (pageConfig.page_files.length === 0) {
          throw new Error("当前模板未配置分页候选人评估文件（page_files）");
        }
        for (let pageIndex = 0; pageIndex < pageConfig.page_files.length; pageIndex += 1) {
          pageSources.push({
            mode: "offline",
            pageIndex,
            pageFile: pageConfig.page_files[pageIndex]
          });
        }
      }

      for (const pageSource of pageSources) {
        const pageIndex = Number(pageSource.pageIndex ?? 0);
        let pageSucceeded = false;
        let pageRetries = 0;
        let lastError = null;

        while (pageRetries <= maxRetryPerPage) {
          try {
            let pageFile = String(pageSource.pageFile ?? "").trim();
            if (pageSource.mode === "realtime") {
              const captureResult = await runRealtimeCandidateCapture({
                templateName,
                runtimePath,
                applyOpsPath,
                templateDir,
                args
              });
              templateResult.realtime_captured_count = Number(captureResult.captured_count ?? 0);
              templateResult.realtime_pages_total = Number(captureResult.pages_total ?? 0);
              templateResult.realtime_pages_processed = Number(captureResult.pages_processed ?? 0);
              templateResult.realtime_cards_scanned = Number(captureResult.cards_scanned ?? 0);
              templateResult.realtime_skipped_count = Number(captureResult.skipped_by_card ?? 0);
              templateResult.realtime_detail_reviewed_count = Number(
                captureResult.detail_reviewed_count ?? 0
              );
              templateResult.realtime_capture_errors = Array.isArray(captureResult.errors)
                ? captureResult.errors.slice(0, 20)
                : [];
              pageFile = captureResult.raw_output;
            }
            const pageMetrics = await processOnePage({
              pageIndex,
              pageFile,
              templateDir,
              evaluationThresholds,
              enforceEvaluationRule
            });
            templateResult.pages_succeeded += 1;
            templateResult.source_candidates += pageMetrics.source_count;
            templateResult.evaluation_rule_checked =
              templateResult.evaluation_rule_checked || Boolean(pageMetrics.evaluation_rule_checked);
            templateResult.evaluation_rule_warning_count += Number(pageMetrics.evaluation_rule_warning_count ?? 0);
            if (Array.isArray(pageMetrics.evaluation_rule_warnings) && pageMetrics.evaluation_rule_warnings.length > 0) {
              const taggedWarnings = pageMetrics.evaluation_rule_warnings.map((item) => ({
                page: pageIndex + 1,
                ...item
              }));
              templateResult.evaluation_rule_warnings = [
                ...templateResult.evaluation_rule_warnings,
                ...taggedWarnings
              ].slice(0, 20);
            }
            if (pageMetrics.normalized_path) {
              normalizedPagePaths.push(String(pageMetrics.normalized_path));
            }
            templateResult.page_retry_total += pageRetries;
            pageSucceeded = true;
            consecutivePageFailures = 0;
            break;
          } catch (error) {
            lastError = error;
            pageRetries += 1;
            if (pageRetries > maxRetryPerPage) {
              break;
            }
          }
        }

        if (!pageSucceeded) {
          templateResult.pages_failed += 1;
          templateResult.page_retry_total += Math.max(0, pageRetries - 1);
          consecutivePageFailures += 1;

          const reason = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown page error");
          templateResult.error = truncateText(`page=${pageIndex + 1}; reason=${reason}`, 280);

          if (consecutivePageFailures >= pauseThreshold) {
            sessionPaused = true;
            pausedTemplateName = templateName;
            pausedReason = `模板 ${templateName} 连续失败页数达到 ${pauseThreshold}，已暂停等待人工接管`;
            templateResult.paused_reason = pausedReason;
            break;
          }
        }
      }

      const templateFullyReviewed =
        !setupFailed &&
        !templateResult.paused_reason &&
        templateResult.pages_failed === 0 &&
        templateResult.pages_succeeded === templateResult.pages_total;
      if (templateFullyReviewed) {
        const mergedInputPath = resolve(templateDir, "all-pages.normalized.json");
        const mergedRecords = [];
        for (const normalizedPath of normalizedPagePaths) {
          const pageRecords = await readJsonFile(resolve(normalizedPath));
          if (Array.isArray(pageRecords)) {
            mergedRecords.push(...pageRecords);
          }
        }
        await writeFile(mergedInputPath, `${JSON.stringify(mergedRecords, null, 2)}\n`, "utf8");
        templateResult.merged_input_path = mergedInputPath;
        templateResult.merged_input_count = mergedRecords.length;
        try {
          const syncJson = await syncTemplateBatch({
            inputPath: mergedInputPath,
            templateName,
            args,
            greetingWritePolicy,
            authArgs
          });
          templateResult.synced_candidates = Number(syncJson.created_count ?? 0);
          templateResult.greeting_generated = Number(syncJson.greeting_generated_count ?? 0);
          templateResult.verified_candidates = Number(syncJson.verified_count ?? 0);
          templateResult.pending_candidates = Number(syncJson.pending_count ?? 0);
          templateResult.placeholder_intercepted_count = Number(syncJson.placeholder_intercepted_count ?? 0);
          templateResult.core_field_total_count = Number(syncJson.core_field_total_count ?? 0);
          templateResult.core_field_real_count = Number(syncJson.core_field_real_count ?? 0);
          const syncSourceCount = Number(syncJson.source_count);
          if (Number.isFinite(syncSourceCount) && syncSourceCount >= 0) {
            templateResult.source_candidates = syncSourceCount;
          }
        } catch (error) {
          templateResult.sync_skipped = true;
          templateResult.sync_skip_reason = "sync_failed";
          throw error;
        }
      } else {
        templateResult.sync_skipped = true;
        if (setupFailed) {
          templateResult.sync_skip_reason = "setup_failed";
        } else if (templateResult.paused_reason) {
          templateResult.sync_skip_reason = "template_paused";
        } else if (templateResult.pages_failed > 0) {
          templateResult.sync_skip_reason = "page_failed";
        } else {
          templateResult.sync_skip_reason = "template_not_completed";
        }
      }

      if (templateResult.apply_ops_source) {
        const hasTemplateFailure =
          Boolean(templateResult.paused_reason) || templateResult.pages_failed > 0 || setupFailed;
        const reportArgs = [
          "report-apply-result",
          "--template-name",
          templateName,
          "--input",
          applyOpsPath,
          "--status",
          hasTemplateFailure ? "failed" : "success",
          "--retry-count",
          String(templateResult.page_retry_total),
          "--page-signature",
          pageSignature
        ];
        if (templateResult.selected_path_id) {
          reportArgs.push("--selected-path-id", templateResult.selected_path_id);
        }
        if (args["path-memory"]) {
          reportArgs.push("--memory", String(args["path-memory"]));
        }
        await runNodeScript("run-maimai-filter-bridge.js", reportArgs);
      }
    } catch (error) {
      setupFailed = true;
      templateResult.error = truncateText(String(error?.message ?? error), 280);
    }

    templateResult.status = buildTemplateStatus({
      paused: Boolean(templateResult.paused_reason),
      failedPages: templateResult.pages_failed,
      pagesTotal: templateResult.pages_total,
      setupFailed
    });
    const suggestion = buildTemplateSuggestion(templateResult);
    templateResult.suggestion = suggestion;

    if (templateResult.template_record_id) {
      const writeResultArgs = [
        "write-result",
        "--base-url",
        String(args["filter-base-url"]),
        "--record-id",
        templateResult.template_record_id,
        "--result-count",
        String(templateResult.synced_candidates),
        "--result-summary",
        buildResultSummaryText(templateResult),
        "--suggestion-summary",
        suggestion.summary,
        "--suggestion-json",
        JSON.stringify(suggestion),
        "--suggestion-trigger",
        suggestion.triggers.join("；"),
        "--suggestion-diff",
        suggestion.diff_hints.join("；"),
        "--status",
        templateResult.status,
        ...authArgs
      ];
      if (templateResult.error) {
        writeResultArgs.push("--error", templateResult.error);
      }
      try {
        await runNodeScript("run-filter-table-workflow.js", writeResultArgs);
      } catch (error) {
        templateResult.error = truncateText(
          `${templateResult.error ? `${templateResult.error} | ` : ""}write-result失败: ${error.message}`,
          280
        );
      }
    }

    templateResults.push(templateResult);
  }

  const endedAt = new Date().toISOString();
  const payload = {
    mode: "run-search-session",
    run_id: runId,
    started_at: startedAt,
    ended_at: endedAt,
    template_count: templateNames.length,
    processed_template_count: templateResults.length,
    session_paused: sessionPaused,
    paused_template_name: pausedTemplateName,
    paused_reason: pausedReason,
    greeting_write_policy: greetingWritePolicy,
    max_retry_per_page: maxRetryPerPage,
    pause_on_consecutive_page_failures: pauseThreshold,
    templates: templateResults
  };

  await writeFile(sessionOutput, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`执行失败: ${error.message}`);
  process.exit(1);
});
