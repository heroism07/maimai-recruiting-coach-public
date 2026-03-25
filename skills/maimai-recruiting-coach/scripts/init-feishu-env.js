#!/usr/bin/env node
import { execFile } from "node:child_process";
import readline from "node:readline/promises";
import { promisify } from "node:util";
import { stdin as input, stdout as output, platform } from "node:process";
import { parseBitableUrl } from "./lib/feishu-bitable.js";
import { mergeRuntimeConfig, readRuntimeConfig, sanitizeConfigPatch } from "./lib/runtime-config.js";

const execFileAsync = promisify(execFile);

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

function toBool(value, defaultValue = false) {
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

function normalizeText(value) {
  return String(value ?? "").trim();
}

function validateBitableUrl(label, rawUrl) {
  const value = normalizeText(rawUrl);
  if (!value) {
    throw new Error(`${label} 不能为空`);
  }

  let parsed = null;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} 不是合法 URL`);
  }

  if (!parsed.hostname.includes("feishu.cn")) {
    throw new Error(`${label} 不是飞书 URL（需要包含 feishu.cn）`);
  }

  const { appToken, tableId, viewId } = parseBitableUrl(value);
  if (!appToken || !tableId) {
    throw new Error(`${label} 缺少 base appToken 或 table 参数`);
  }

  return {
    url: value,
    app_token: appToken,
    table_id: tableId,
    view_id: viewId || ""
  };
}

async function promptUrl(rl, title, currentValue, example) {
  const tip = currentValue ? `（回车保留当前值）` : "";
  // eslint-disable-next-line no-console
  console.log(`\n${title}${tip}`);
  // eslint-disable-next-line no-console
  console.log(`示例: ${example}`);
  const answer = normalizeText(await rl.question("> "));
  return answer || currentValue;
}

async function setUserEnv(name, value, dryRun = false) {
  if (dryRun) {
    return {
      name,
      written: false,
      mode: "dry_run"
    };
  }

  if (platform !== "win32") {
    throw new Error(`当前仅实现 Windows 写入用户环境变量，当前平台: ${platform}`);
  }

  await execFileAsync("setx", [name, value], {
    windowsHide: true
  });

  return {
    name,
    written: true,
    mode: "setx"
  };
}

function printUsage() {
  // eslint-disable-next-line no-console
  console.log(
    [
      "用法:",
      "  node skills/maimai-recruiting-coach/scripts/init-feishu-env.js [options]",
      "",
      "选项:",
      "  --filter-base-url <url>       职位筛选表 URL（飞书多维表）",
      "  --candidate-base-url <url>    候选人表 URL（飞书多维表）",
      "  --config <json-file>          本地配置文件（默认 data/maimai-runtime-config.json）",
      "  --non-interactive             非交互模式（参数缺失则报错）",
      "  --dry-run                     仅校验并预览，不写入环境变量",
      "",
      "写入环境变量:",
      "  FEISHU_FILTER_BASE_URL",
      "  FEISHU_CANDIDATE_BASE_URL",
      "",
      "推荐：首次初始化先直接运行该命令，按提示粘贴两个 URL。"
    ].join("\n")
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printUsage();
    process.exit(0);
  }

  const dryRun = toBool(args["dry-run"], false);
  const nonInteractive = toBool(args["non-interactive"], false);
  const isInteractive = input.isTTY && !nonInteractive;

  const runtimeConfigState = await readRuntimeConfig(args.config);
  const runtimeConfig = runtimeConfigState.config ?? {};
  let filterBaseUrl = normalizeText(
    args["filter-base-url"] ?? process.env.FEISHU_FILTER_BASE_URL ?? runtimeConfig.filter_base_url
  );
  let candidateBaseUrl = normalizeText(
    args["candidate-base-url"] ?? process.env.FEISHU_CANDIDATE_BASE_URL ?? runtimeConfig.candidate_base_url
  );

  if (isInteractive) {
    const rl = readline.createInterface({ input, output });
    try {
      filterBaseUrl = await promptUrl(
        rl,
        "请输入飞书筛选表 URL",
        filterBaseUrl,
        "https://xxx.feishu.cn/base/xxxx?table=tblxxxx&view=vewxxxx"
      );
      candidateBaseUrl = await promptUrl(
        rl,
        "请输入飞书候选人表 URL",
        candidateBaseUrl,
        "https://xxx.feishu.cn/base/xxxx?table=tblyyyy&view=vewyyyy"
      );
    } finally {
      rl.close();
    }
  }

  if (!filterBaseUrl || !candidateBaseUrl) {
    throw new Error("缺少 URL。请提供 --filter-base-url 与 --candidate-base-url，或在交互模式输入。");
  }

  const filterValidated = validateBitableUrl("筛选表 URL", filterBaseUrl);
  const candidateValidated = validateBitableUrl("候选人表 URL", candidateBaseUrl);

  const writes = [];
  writes.push(await setUserEnv("FEISHU_FILTER_BASE_URL", filterValidated.url, dryRun));
  writes.push(await setUserEnv("FEISHU_CANDIDATE_BASE_URL", candidateValidated.url, dryRun));

  process.env.FEISHU_FILTER_BASE_URL = filterValidated.url;
  process.env.FEISHU_CANDIDATE_BASE_URL = candidateValidated.url;
  const runtimePatch = sanitizeConfigPatch({
    filter_base_url: filterValidated.url,
    candidate_base_url: candidateValidated.url
  });
  const runtimeConfigWrite = dryRun
    ? {
        config_path: runtimeConfigState.configPath,
        written: false,
        mode: "dry_run"
      }
    : {
        config_path: (await mergeRuntimeConfig(runtimePatch, args.config)).configPath,
        written: true,
        mode: "runtime_config"
      };

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        mode: "init-feishu-env",
        dry_run: dryRun,
        filter: {
          app_token: filterValidated.app_token,
          table_id: filterValidated.table_id,
          view_id: filterValidated.view_id
        },
        candidate: {
          app_token: candidateValidated.app_token,
          table_id: candidateValidated.table_id,
          view_id: candidateValidated.view_id
        },
        writes,
        runtime_config: runtimeConfigWrite,
        note: dryRun
          ? "dry-run 未落盘。"
          : "已写入用户环境变量（新开终端会话后生效）。"
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`初始化失败: ${error.message}`);
  process.exit(1);
});
