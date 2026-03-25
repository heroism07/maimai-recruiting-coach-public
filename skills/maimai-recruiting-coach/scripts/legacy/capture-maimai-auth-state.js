#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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
  return String(value).trim();
}

function toBoolean(value, fallback = false) {
  const text = toText(value).toLowerCase();
  if (!text) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(text)) return true;
  if (["0", "false", "no", "n", "off"].includes(text)) return false;
  return fallback;
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    // eslint-disable-next-line no-console
    console.log(
      [
        "用法:",
        "  node skills/maimai-recruiting-coach/scripts/capture-maimai-auth-state.js --list-url <url> [options]",
        "",
        "选项:",
        "  --output <json-file>    登录态输出文件，默认 data/maimai-storage-state.json",
        "  --wait-ms <n>           打开页面后等待手动登录时长（毫秒），默认 90000",
        "  --headless <true|false> 是否无头，默认 false（登录建议 false）",
        "  --profile-dir <dir>     浏览器独立用户空间目录（可选）"
      ].join("\n")
    );
    process.exit(0);
  }

  const listUrl = toText(args["list-url"]);
  if (!listUrl) {
    throw new Error("缺少 --list-url");
  }
  const outputPath = resolve(toText(args.output) || "data/maimai-storage-state.json");
  const waitMs = toPositiveInt(args["wait-ms"], 90000);
  const headless = toBoolean(args.headless, false);
  const profileDir = toText(args["profile-dir"]);

  let playwright;
  try {
    playwright = await import("playwright");
  } catch (error) {
    throw new Error(`缺少 playwright 依赖，请先安装（npm i playwright）。原始错误: ${String(error?.message ?? error)}`);
  }

  let browser = null;
  let context = null;
  let page = null;
  if (profileDir) {
    const profilePath = resolve(profileDir);
    await mkdir(profilePath, { recursive: true });
    context = await playwright.chromium.launchPersistentContext(profilePath, { headless });
    page = context.pages()[0] ?? (await context.newPage());
  } else {
    browser = await playwright.chromium.launch({ headless });
    context = await browser.newContext();
    page = await context.newPage();
  }
  try {
    await page.goto(listUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(waitMs);
    await mkdir(dirname(outputPath), { recursive: true });
    await context.storageState({ path: outputPath });
  } finally {
    if (context) {
      await context.close();
    }
    if (browser) {
      await browser.close();
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "capture-maimai-auth-state",
        output: outputPath,
        profile_dir: profileDir ? resolve(profileDir) : "",
        waited_ms: waitMs
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

