#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";

function readOptionValue(rawArgs, optionName) {
  const key = `--${optionName}`;
  const index = rawArgs.indexOf(key);
  if (index === -1) {
    return "";
  }
  const next = rawArgs[index + 1];
  if (!next || next.startsWith("--")) {
    return "true";
  }
  return String(next).trim();
}

function hasOption(rawArgs, optionName) {
  return rawArgs.includes(`--${optionName}`);
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim().toLowerCase();
  if (!text) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(text)) return true;
  if (["0", "false", "no", "n", "off"].includes(text)) return false;
  return fallback;
}

function ensureOption(rawArgs, optionName, optionValue) {
  if (hasOption(rawArgs, optionName)) {
    return;
  }
  rawArgs.push(`--${optionName}`, String(optionValue));
}

function printUsage() {
  // eslint-disable-next-line no-console
  console.log(
    [
      "用法:",
      "  node skills/maimai-recruiting-coach/scripts/run-hrbp-session.js --template-names <A,B,...> [options]",
      "  node skills/maimai-recruiting-coach/scripts/run-hrbp-session.js --use-existing-templates true [options]",
      "",
      "说明:",
      "  该命令是 run-search-session 的 HR 友好封装，会自动补齐生产安全默认参数：",
      "  execution-mode=realtime, online-filter=true, humanize=true, greeting-write-policy=empty_only。",
      "",
      "常用参数:",
      "  --template-names <list>       指定模板列表（逗号分隔）",
      "  --use-existing-templates true 自动拉取启用模板（不传 template-names 时可用）",
      "  --template-limit <n>          自动拉取模板数量上限，默认 5",
      "  --config <file>               运行配置文件，默认 data/maimai-runtime-config.json",
      "",
      "示例:",
      "  npm run skill:hrbp:run -- --template-names \"目标岗位主模板A,目标岗位主模板B\"",
      "  npm run skill:hrbp:run -- --use-existing-templates true --template-limit 3"
    ].join("\n")
  );
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (hasOption(rawArgs, "help") || hasOption(rawArgs, "h")) {
    printUsage();
    process.exit(0);
  }

  const templateNames = readOptionValue(rawArgs, "template-names");
  const useExistingTemplates = toBoolean(readOptionValue(rawArgs, "use-existing-templates"), false);

  if (!templateNames && !useExistingTemplates) {
    throw new Error("请提供 --template-names，或使用 --use-existing-templates true");
  }

  ensureOption(rawArgs, "config", "data/maimai-runtime-config.json");
  ensureOption(rawArgs, "execution-mode", "realtime");
  ensureOption(rawArgs, "online-filter", "true");
  ensureOption(rawArgs, "online-filter-required", "false");
  ensureOption(rawArgs, "confirm-templates", "true");
  ensureOption(rawArgs, "humanize", "true");
  ensureOption(rawArgs, "greeting-only-for", "可沟通");
  ensureOption(rawArgs, "greeting-write-policy", "empty_only");
  ensureOption(rawArgs, "max-retry-per-page", "2");
  ensureOption(rawArgs, "pause-on-consecutive-page-failures", "2");
  ensureOption(rawArgs, "sync-filter-runtime", "true");

  const entryScript = resolve("skills/maimai-recruiting-coach/scripts/run-search-session.js");
  const child = spawn(process.execPath, [entryScript, ...rawArgs], {
    stdio: "inherit",
    env: process.env,
    cwd: process.cwd()
  });

  await new Promise((resolveDone, rejectDone) => {
    child.on("error", rejectDone);
    child.on("close", (code) => {
      if (Number(code ?? 1) !== 0) {
        rejectDone(new Error(`run-search-session 执行失败，退出码 ${code}`));
        return;
      }
      resolveDone();
    });
  });
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`执行失败: ${error.message}`);
  process.exit(1);
});

