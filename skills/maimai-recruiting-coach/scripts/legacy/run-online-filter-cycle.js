#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PlaywrightRecruitingAdapter } from "../adapters/playwright-adapter.js";
import { buildApplyOperationsFromScenario, parseFilterSummaryToScenario } from "../lib/filter-bridge.js";
import { resolveApplyOperations } from "../lib/filter-path-memory.js";
import { buildFilterCoverageChecklist, shouldFailOnCoverage } from "../lib/filter-coverage.js";
import {
  compileApplyOpsForPlaywright,
  getCaptureSelectors,
  normalizeSelectorMap
} from "../lib/online-filter-ops.js";

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

function toBoolean(value, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === "boolean") return value;
  const text = toText(value).toLowerCase();
  if (!text) return defaultValue;
  if (["1", "true", "yes", "y", "on"].includes(text)) return true;
  if (["0", "false", "no", "n", "off"].includes(text)) return false;
  return defaultValue;
}

function splitList(value) {
  return toText(value)
    .split(/[;,，；\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isLikelyLoginUrl(url) {
  const text = toText(url).toLowerCase();
  if (!text) return false;
  return /(passport|login|auth|signin|signup)/i.test(text);
}

async function isLoginRequired(page) {
  const currentUrl = toText(page.url());
  if (isLikelyLoginUrl(currentUrl)) {
    return true;
  }
  try {
    const bodyText = await page.locator("body").innerText();
    return /(扫码登录|登录后|请登录|手机登录|验证码登录|账号登录)/i.test(bodyText);
  } catch {
    return false;
  }
}

async function ensureLoggedIn(page, waitMs = 180000) {
  const needLogin = await isLoginRequired(page);
  if (!needLogin) {
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`检测到当前未登录，请先在浏览器中完成登录；最多等待 ${waitMs}ms。`);
  const deadline = Date.now() + Math.max(10_000, Number(waitMs) || 180000);
  while (Date.now() < deadline) {
    await page.waitForTimeout(2500);
    if (!(await isLoginRequired(page))) {
      // eslint-disable-next-line no-console
      console.log("检测到已登录，继续执行“招人-搜索”与筛选。");
      return;
    }
  }
  throw new Error("等待登录超时：请先登录脉脉招聘端后重试。");
}

function normalizeUiOperations(rawList = []) {
  if (!Array.isArray(rawList)) {
    return [];
  }
  const outputs = [];
  for (const item of rawList) {
    const selector = toText(item?.selector);
    if (!selector) continue;
    outputs.push({
      selector,
      mode: toText(item?.mode || "click") || "click",
      input_text: toText(item?.input_text),
      wait_ms: Number(item?.wait_ms ?? 160)
    });
  }
  return outputs;
}

async function readJson(filePath) {
  const raw = await readFile(resolve(filePath), "utf8");
  return JSON.parse(raw);
}

async function writeJson(filePath, payload) {
  const target = resolve(filePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function normalizeSummaryText(summaryItems = []) {
  if (!Array.isArray(summaryItems)) {
    return "";
  }
  return summaryItems
    .flatMap((item) => (Array.isArray(item?.texts) ? item.texts : []))
    .map((item) => toText(item))
    .filter(Boolean)
    .join(" | ");
}

function tokenizeValue(value) {
  return toText(value)
    .split(/[;；,，、\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .slice(0, 12);
}

function buildSummaryCoverage(checklist, summaryItems) {
  const summaryText = normalizeSummaryText(summaryItems);
  const items = (checklist?.items ?? []).map((item) => {
    const tokens = tokenizeValue(item.value);
    const matched = tokens.some((token) => summaryText.includes(token));
    return {
      id: item.id,
      critical: item.critical,
      expected_value: item.value,
      matched
    };
  });
  const criticalItems = items.filter((item) => item.critical);
  const criticalUnconfirmed = criticalItems.filter((item) => !item.matched);
  return {
    summary_text: summaryText,
    total_items: items.length,
    matched_items: items.filter((item) => item.matched).length,
    critical_total: criticalItems.length,
    critical_unconfirmed_count: criticalUnconfirmed.length,
    critical_unconfirmed_fields: criticalUnconfirmed.map((item) => item.id),
    items
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    // eslint-disable-next-line no-console
    console.log(
      [
        "用法:",
        "  node skills/maimai-recruiting-coach/scripts/run-online-filter-cycle.js --runtime <runtime.json> --apply-ops <apply-ops.json> --selector-map <selector-map.json> --list-url <maimai-url> [options]",
        "",
        "可选参数:",
        "  --template-name <name>",
        "  --page-signature <sig>",
        "  --reuse-success-path <auto|exact|on|off>",
        "  --path-memory <memory.json>",
        "  --runtime-output <runtime.json>",
        "  --apply-output <apply-ops.json>",
        "  --summary-output <summary.json>",
        "  --coverage-output <coverage.json>",
        "  --allow-fallback-reuse <true|false>",
        "  --allow-missing-critical <true|false>",
        "  --capture-selectors <css1,css2>",
        "  --wait-after-apply-ms <n>",
        "  --login-wait-ms <n>",
        "  --headless <true|false>",
        "  --profile-dir <dir>",
        "  --storage-state <json-file>",
        "  --save-storage-state <json-file>",
        "  --humanize <true|false>"
      ].join("\n")
    );
    process.exit(0);
  }
  if (!args.runtime || !args["apply-ops"] || !args["selector-map"]) {
    throw new Error("缺少参数：--runtime --apply-ops --selector-map");
  }

  let playwright;
  try {
    playwright = await import("playwright");
  } catch (error) {
    throw new Error(
      `当前环境缺少 playwright 依赖，请先安装后重试（npm i playwright）。原始错误: ${String(error?.message ?? error)}`
    );
  }

  const runtimePath = resolve(args.runtime);
  const applyOpsPath = resolve(args["apply-ops"]);
  const selectorMapPath = resolve(args["selector-map"]);
  const runtimePayload = await readJson(runtimePath);
  const applyPayload = await readJson(applyOpsPath);
  const selectorMap = normalizeSelectorMap(await readJson(selectorMapPath));
  const captureSelectors = splitList(args["capture-selectors"]);
  const scenario = runtimePayload?.scenario ?? {};
  const generatedSemanticOps = buildApplyOperationsFromScenario(scenario);
  const applyOpsSourceInput = toText(applyPayload?.apply_ops_source);
  const allowFallbackReuse = toBoolean(args["allow-fallback-reuse"], false);
  let semanticOps = Array.isArray(applyPayload.operations) ? applyPayload.operations : [];
  let semanticOpsSource = applyOpsSourceInput || "unknown";
  if (applyOpsSourceInput === "success_path_fallback" && !allowFallbackReuse) {
    semanticOps = generatedSemanticOps;
    semanticOpsSource = "generated_no_fallback";
  }

  const coverageChecklist = buildFilterCoverageChecklist({
    scenario,
    operations: semanticOps,
    selectorMap
  });
  const allowMissingCritical = toBoolean(args["allow-missing-critical"], false);
  const coverageOutputPath = resolve(
    args["coverage-output"] || `${dirname(runtimePath)}/filter-coverage.online.json`
  );
  await writeJson(coverageOutputPath, {
    mode: "online-filter-coverage-preflight",
    apply_ops_source_input: applyOpsSourceInput || "",
    apply_ops_source_effective: semanticOpsSource,
    checklist: coverageChecklist
  });
  if (shouldFailOnCoverage(coverageChecklist, { failOnCriticalBlocked: !allowMissingCritical })) {
    throw new Error(
      `筛选关键字段未脚本覆盖: ${coverageChecklist.critical_blocked_fields.join(", ")}；请先由 AI 接管补齐或完善 selector-map`
    );
  }

  const uiOps = compileApplyOpsForPlaywright(semanticOps, selectorMap);
  if (uiOps.length === 0) {
    throw new Error("未生成可执行的在线筛选 UI 操作，请检查 selector-map");
  }

  const listUrl = toText(args["list-url"]) || toText(selectorMap.list_url);
  if (!listUrl) {
    throw new Error("缺少 --list-url（或 selector-map.list_url）");
  }

  const headless = toBoolean(args.headless, false);
  const profileDir = toText(args["profile-dir"]);
  let browser = null;
  let context = null;
  let page = null;
  if (profileDir) {
    const profilePath = resolve(profileDir);
    await mkdir(profilePath, { recursive: true });
    context = await playwright.chromium.launchPersistentContext(profilePath, {
      headless
    });
    page = context.pages()[0] ?? (await context.newPage());
  } else {
    browser = await playwright.chromium.launch({ headless });
    const contextOptions = {};
    if (toText(args["storage-state"])) {
      contextOptions.storageState = resolve(toText(args["storage-state"]));
    }
    context = await browser.newContext(contextOptions);
    page = await context.newPage();
  }
  const adapter = new PlaywrightRecruitingAdapter(page, {
    listUrl,
    contextMarkers: splitList(args["context-markers"]).length > 0
      ? splitList(args["context-markers"])
      : Array.isArray(selectorMap.context_markers)
        ? selectorMap.context_markers
        : [],
    allowedHostSuffixes: splitList(args["allowed-hosts"]).length > 0
      ? splitList(args["allowed-hosts"])
      : Array.isArray(selectorMap.allowed_host_suffixes)
        ? selectorMap.allowed_host_suffixes
        : ["maimai.cn"],
    learningMode: false,
    humanize: toBoolean(args.humanize, true)
  });

  let capturedSummary = [];
  const preOperations = normalizeUiOperations(
    Array.isArray(selectorMap.pre_operations) ? selectorMap.pre_operations : selectorMap.entry_operations
  );
  try {
    const openRes = await adapter.executeStep({
      id: "online-open",
      action: "open_page",
      url: listUrl
    });
    if (!openRes.ok) {
      throw new Error(`打开脉脉页面失败: ${openRes.detail}`);
    }
    await adapter.executeStep({ id: "online-stable", action: "wait_for_stable" });
    await ensureLoggedIn(page, Number(args["login-wait-ms"] ?? 180000));
    if (preOperations.length > 0) {
      const preRes = await adapter.executeStep({
        id: "online-pre-nav",
        action: "apply_filter_bundle",
        operations: preOperations
      });
      if (!preRes.ok) {
        throw new Error(`在线前置导航失败: ${preRes.detail}`);
      }
      await adapter.executeStep({ id: "online-post-pre-nav-stable", action: "wait_for_stable" });
    }

    const applyRes = await adapter.executeStep({
      id: "online-apply",
      action: "apply_filter_bundle",
      operations: uiOps
    });
    if (!applyRes.ok) {
      throw new Error(`在线应用筛选失败: ${applyRes.detail}`);
    }

    const waitMs = Number(args["wait-after-apply-ms"] ?? selectorMap.wait_after_apply_ms ?? 1200);
    if (Number.isFinite(waitMs) && waitMs > 0) {
      await page.waitForTimeout(waitMs);
    }

    const captureRes = await adapter.executeStep({
      id: "online-capture",
      action: "capture_filter_summary",
      capture_selectors: captureSelectors.length > 0 ? captureSelectors : getCaptureSelectors(selectorMap)
    });
    if (captureRes.ok) {
      try {
        capturedSummary = JSON.parse(String(captureRes.detail ?? "[]"));
      } catch {
        capturedSummary = [];
      }
    }
  } finally {
    if (context && toText(args["save-storage-state"])) {
      const savePath = resolve(toText(args["save-storage-state"]));
      await mkdir(dirname(savePath), { recursive: true });
      await context.storageState({ path: savePath });
    }
    if (context) {
      await context.close();
    }
    if (browser) {
      await browser.close();
    }
  }

  const summaryCoverage = buildSummaryCoverage(coverageChecklist, capturedSummary);
  if (!allowMissingCritical && summaryCoverage.critical_unconfirmed_count > 0) {
    throw new Error(
      `筛选后校验未确认关键字段: ${summaryCoverage.critical_unconfirmed_fields.join(", ")}；请改用 AI 接管或补齐 capture_selectors`
    );
  }
  await writeJson(coverageOutputPath, {
    mode: "online-filter-coverage",
    apply_ops_source_input: applyOpsSourceInput || "",
    apply_ops_source_effective: semanticOpsSource,
    checklist: coverageChecklist,
    summary_coverage: summaryCoverage
  });

  const scenarioPatch = parseFilterSummaryToScenario(Array.isArray(capturedSummary) ? capturedSummary : []);
  const mergedScenario = {
    ...(runtimePayload?.scenario ?? {}),
    ...scenarioPatch
  };
  const generatedOps = buildApplyOperationsFromScenario(mergedScenario);
  const templateName =
    toText(args["template-name"]) ||
    toText(runtimePayload?.selected_template_name) ||
    toText(mergedScenario["模版名称"]) ||
    toText(mergedScenario["模板名称"]) ||
    toText(mergedScenario["模版基础名"]) ||
    "unknown-template";
  const resolvedApply = await resolveApplyOperations(
    {
      templateName,
      pageSignature: toText(args["page-signature"]),
      generatedOperations: generatedOps,
      reuseMode: toText(args["reuse-success-path"]) || "exact"
    },
    args["path-memory"]
  );

  const runtimeOutPath = resolve(args["runtime-output"] || runtimePath);
  const applyOutPath = resolve(args["apply-output"] || applyOpsPath);
  const summaryOutPath = resolve(args["summary-output"] || `${dirname(runtimeOutPath)}/filter-summary.online.raw.json`);

  const runtimeOut = {
    ...runtimePayload,
    online_captured_at: new Date().toISOString(),
    selected_template_name: runtimePayload?.selected_template_name ?? templateName,
    scenario: mergedScenario
  };
  const applyOut = {
    generated_at: new Date().toISOString(),
    mode: "online-filter-cycle",
    template_name: templateName,
    apply_ops_source: resolvedApply.apply_ops_source,
    input_apply_ops_source: applyOpsSourceInput || "",
    effective_apply_ops_source: semanticOpsSource,
    path_reuse_miss_reason: resolvedApply.path_reuse_miss_reason,
    selected_path_id: resolvedApply.selected_path_id,
    reuse_mode: resolvedApply.reuse_mode,
    observability: resolvedApply.observability,
    operations: resolvedApply.operations
  };

  await writeJson(runtimeOutPath, runtimeOut);
  await writeJson(applyOutPath, applyOut);
  await writeJson(summaryOutPath, capturedSummary);

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "run-online-filter-cycle",
        template_name: templateName,
        runtime_output: runtimeOutPath,
        apply_output: applyOutPath,
        summary_output: summaryOutPath,
        coverage_output: coverageOutputPath,
        apply_ops_source: applyOut.apply_ops_source,
        path_reuse_miss_reason: applyOut.path_reuse_miss_reason,
        selected_path_id: applyOut.selected_path_id,
        summary_item_count: Array.isArray(capturedSummary) ? capturedSummary.length : 0,
        generated_operation_count: generatedOps.length,
        resolved_operation_count: Array.isArray(applyOut.operations) ? applyOut.operations.length : 0
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

