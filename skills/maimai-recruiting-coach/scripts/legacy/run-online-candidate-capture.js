#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEFAULT_ALLOWED_HOST_SUFFIXES = ["maimai.cn"];
const DEFAULT_MAX_CANDIDATES = 500;
const DEFAULT_WAIT_AFTER_OPEN_MS = 1200;
const DEFAULT_WAIT_AFTER_CLICK_MS = 900;
const DEFAULT_CAPTURE_TIMEOUT_MS = 15000;
const DEFAULT_MAX_ACTIONS_PER_MIN = 24;
const DEFAULT_MAX_PAGES = 50;
const DEFAULT_NEXT_PAGE_WAIT_MS = 1400;

const DEFAULT_SELECTOR_MAP = {
  allowed_host_suffixes: DEFAULT_ALLOWED_HOST_SUFFIXES,
  entry_operations: [
    { selector: "a:has-text('招人')", mode: "click", wait_ms: 600 },
    { selector: "a:has-text('搜索')", mode: "click", wait_ms: 1000 }
  ],
  selectors: {
    candidate_card: [
      "[data-testid='candidate-card']",
      ".candidate-card",
      ".resume-card",
      "[class*='candidate-card']",
      "[class*='resume-card']"
    ],
    card_name: [".candidate-name", ".name", "h3", "h4"],
    card_status: [".candidate-status", ".status", ".tag"],
    card_age: [".candidate-age", ".age"],
    detail_container: [
      "[data-testid='candidate-detail']",
      ".candidate-detail",
      ".resume-detail",
      ".drawer-content",
      ".detail-panel"
    ],
    detail_name: [".candidate-name", ".header .name", "h1", "h2"],
    detail_status: [".candidate-status", ".status", ".basic-info .status"],
    detail_desired_position: [".desired-position", ".expect-position", ".intention"],
    detail_education: [".education", ".edu", ".section-education"],
    detail_employment: [".employment", ".experience", ".work-experience"],
    detail_close: [
      "[data-testid='detail-close']",
      ".detail-close",
      ".drawer-close",
      "button[aria-label*='关闭']"
    ],
    detail_resume_link: [
      "a[href*='resume/view']",
      "a[href*='.pdf']",
      "a[href*='download']",
      "a[href*='attachment']"
    ],
    next_page: [
      "button[aria-label*='下一页']",
      "button:has-text('下一页')",
      ".pagination-next",
      ".pager-next",
      "li.next:not(.disabled) button"
    ],
    next_page_disabled: [
      "button[aria-label*='下一页'][disabled]",
      "button:has-text('下一页')[disabled]",
      ".pagination-next.disabled",
      ".pager-next.disabled",
      "li.next.disabled"
    ]
  }
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

function splitList(value) {
  return toText(value)
    .split(/[;,，；\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueLines(text) {
  const seen = new Set();
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((line) => {
      if (seen.has(line)) return false;
      seen.add(line);
      return true;
    });
}

function mergeSelectorMap(baseMap, overrideMap) {
  const baseSelectors = baseMap?.selectors ?? {};
  const overrideSelectors = overrideMap?.selectors ?? {};
  const selectors = {};
  const keys = new Set([...Object.keys(baseSelectors), ...Object.keys(overrideSelectors)]);
  for (const key of keys) {
    const baseList = Array.isArray(baseSelectors[key]) ? baseSelectors[key] : [];
    const overrideList = Array.isArray(overrideSelectors[key]) ? overrideSelectors[key] : [];
    const merged = [...overrideList, ...baseList].map((item) => toText(item)).filter(Boolean);
    selectors[key] = merged.length > 0 ? merged : [];
  }
  const allowedHostsRaw = [
    ...(Array.isArray(overrideMap?.allowed_host_suffixes) ? overrideMap.allowed_host_suffixes : []),
    ...(Array.isArray(baseMap?.allowed_host_suffixes) ? baseMap.allowed_host_suffixes : [])
  ];
  const allowedHostSuffixes = [...new Set(allowedHostsRaw.map((item) => toText(item).toLowerCase()).filter(Boolean))];
  return {
    allowed_host_suffixes: allowedHostSuffixes.length > 0 ? allowedHostSuffixes : DEFAULT_ALLOWED_HOST_SUFFIXES,
    selectors
  };
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
      wait_ms: Number(item?.wait_ms ?? 180)
    });
  }
  return outputs;
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
  if (!(await isLoginRequired(page))) {
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`检测到当前未登录，请先在浏览器中完成登录；最多等待 ${waitMs}ms。`);
  const deadline = Date.now() + Math.max(10_000, Number(waitMs) || 180000);
  while (Date.now() < deadline) {
    await page.waitForTimeout(2500);
    if (!(await isLoginRequired(page))) {
      // eslint-disable-next-line no-console
      console.log("检测到已登录，继续执行“招人-搜索”与候选人采集。");
      return;
    }
  }
  throw new Error("等待登录超时：请先登录脉脉招聘端后重试。");
}

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 60;
  return Math.max(40, Math.min(95, Math.round(n)));
}

function inferMatchLevels(detailText, employmentText) {
  const merged = `${detailText}\n${employmentText}`;
  const ibStrong = /行业A|投资银行|券商|并购|关键项目|IPO|行业B市场|关键项目|FA|PE|VC/i.test(merged);
  const partyStrong = /目标岗位负责人|核心岗位负责人|目标岗位总监|目标岗位负责人|目标岗位VP|核心岗位一号位/i.test(merged);
  const techHigh = /互联网|IT|科技|软件|游戏|AI|SaaS|字节|腾讯|阿里|美团|京东/i.test(merged);

  const ibMedium = /投资|业务分析|合规检查|FDD|基金|并表/i.test(merged);
  const partyMedium = /业务BP|业务经理|业务高级经理|RoleScope/i.test(merged);
  const techMedium = /数字化|平台|线上|产品|研发/i.test(merged);

  return {
    industry_core_background: ibStrong ? "strong" : ibMedium ? "medium" : "weak",
    party_a_core_background: partyStrong ? "strong" : partyMedium ? "medium" : "weak",
    domain_relevance: techHigh ? "high" : techMedium ? "medium" : "low"
  };
}

function scoreCandidate({ levels, hasAttachment, age, statusText }) {
  let score = 55;
  if (levels.industry_core_background === "strong") score += 15;
  if (levels.industry_core_background === "medium") score += 8;
  if (levels.party_a_core_background === "strong") score += 18;
  if (levels.party_a_core_background === "medium") score += 9;
  if (levels.domain_relevance === "high") score += 10;
  if (levels.domain_relevance === "medium") score += 5;
  if (hasAttachment) score += 5;
  if (Number.isFinite(age) && age > 0 && age <= 45) score += 4;
  if (Number.isFinite(age) && age > 50) score -= 6;
  if (/活跃|看机会|急求职|近期有动向/i.test(statusText)) score += 4;
  return clampScore(score);
}

function deriveConclusion(score) {
  if (score >= 85) return "可沟通";
  if (score >= 70) return "储备观察";
  return "不合适";
}

function buildConclusionReason(conclusion, levels) {
  if (conclusion === "可沟通") {
    return `匹配度较高（行业背景=${levels.industry_core_background}，甲方核心岗位=${levels.party_a_core_background}，科技相关=${levels.domain_relevance}）。`;
  }
  if (conclusion === "储备观察") {
    return `匹配度中等，建议电话初筛后决定（行业背景=${levels.industry_core_background}，甲方核心岗位=${levels.party_a_core_background}）。`;
  }
  return `当前匹配度偏低（行业背景=${levels.industry_core_background}，甲方核心岗位=${levels.party_a_core_background}，科技相关=${levels.domain_relevance}）。`;
}

function extractAge(text) {
  const match = String(text ?? "").match(/(\d{2})\s*岁/);
  if (!match?.[1]) return null;
  const age = Number(match[1]);
  if (!Number.isFinite(age)) return null;
  return age;
}

function extractEducationLines(lines) {
  const picked = lines.filter((line) =>
    /大学|学院|本科|硕士|博士|MBA|EMBA|学历|学校/i.test(line)
  );
  return picked.slice(0, 3);
}

function extractEmploymentLines(lines) {
  const picked = lines.filter((line) =>
    /\d{4}|至今|任职|公司|目标岗位负责人|总监|经理|VP|目标岗位|投资|关键项目|并购/i.test(line)
  );
  return picked.slice(0, 6);
}

function extractHighlights(lines) {
  const picked = lines.filter((line) => /负责|主导|搭建|关键项目|并购|预算|内控|目标岗位|行业B|IPO/i.test(line));
  return (picked.length > 0 ? picked : lines).slice(0, 3);
}

function inferDesiredPosition(lines) {
  for (const line of lines) {
    const match = line.match(/(求职意向|期望职位|意向职位|目标职位)\s*[:：]?\s*(.+)$/i);
    if (match?.[2]) {
      return match[2].trim();
    }
  }
  return lines.find((line) => /目标岗位负责人|目标岗位总监|目标岗位负责人|目标岗位VP|RoleScope|目标岗位/i.test(line)) ?? "";
}

function ensureWithinAllowedHost(url, allowedSuffixes) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`list-url 不是合法 URL: ${url}`);
  }
  const host = (parsed.hostname ?? "").toLowerCase();
  const allowed = allowedSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  if (!allowed) {
    throw new Error(`当前仅允许访问脉脉域名，已阻止目标 URL: ${url}`);
  }
}

class HumanPacer {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.minDelay = toPositiveInt(options.minDelay, 360);
    this.maxDelay = toPositiveInt(options.maxDelay, 1300);
    this.maxActionsPerMin = toPositiveInt(options.maxActionsPerMin, DEFAULT_MAX_ACTIONS_PER_MIN);
    this.timestamps = [];
  }

  randomBetween(min, max) {
    const lower = Math.max(0, Number(min ?? 0));
    const upper = Math.max(lower, Number(max ?? lower));
    return Math.round(lower + Math.random() * (upper - lower));
  }

  async beforeAction(page, extraDelay = 0) {
    const additional = Number.isFinite(Number(extraDelay)) ? Math.max(0, Number(extraDelay)) : 0;
    if (!this.enabled) {
      if (additional > 0) {
        await page.waitForTimeout(additional);
      }
      return;
    }
    const now = Date.now();
    this.timestamps = this.timestamps.filter((ts) => now - ts < 60_000);
    if (this.timestamps.length >= this.maxActionsPerMin) {
      const oldest = this.timestamps[0];
      const waitMs = Math.max(700, 60_000 - (now - oldest) + this.randomBetween(100, 500));
      await page.waitForTimeout(waitMs);
    }
    const jitter = this.randomBetween(this.minDelay, this.maxDelay);
    await page.waitForTimeout(jitter + additional);
    this.timestamps.push(Date.now());
  }
}

async function readJsonIfExists(filePath) {
  if (!filePath) return null;
  const target = resolve(filePath);
  const fs = await import("node:fs/promises");
  try {
    const raw = await fs.readFile(target, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`selector-map 文件不存在: ${target}`);
    }
    throw error;
  }
}

async function firstValidSelector(root, selectors) {
  for (const selector of selectors) {
    try {
      const count = await root.locator(selector).count();
      if (count > 0) return selector;
    } catch {
      // ignore invalid selector
    }
  }
  return "";
}

async function textFromSelectors(root, selectors) {
  for (const selector of selectors) {
    try {
      const locator = root.locator(selector).first();
      const count = await root.locator(selector).count();
      if (count <= 0) continue;
      const text = (await locator.innerText()).trim();
      if (text) return text;
    } catch {
      // ignore and continue
    }
  }
  return "";
}

async function hrefFromSelectors(root, selectors, patterns = [], baseUrl = "") {
  for (const selector of selectors) {
    try {
      const links = root.locator(selector);
      const count = await links.count();
      for (let i = 0; i < count; i += 1) {
        const href = toText(await links.nth(i).getAttribute("href"));
        if (!href) continue;
        let absolute = "";
        if (/^https?:\/\//i.test(href)) {
          absolute = href;
        } else if (baseUrl) {
          try {
            absolute = new URL(href, baseUrl).toString();
          } catch {
            absolute = "";
          }
        }
        if (!absolute) continue;
        if (patterns.length === 0 || patterns.some((p) => p.test(absolute))) {
          return absolute;
        }
      }
    } catch {
      // continue
    }
  }
  return "";
}

async function closeDetail(page, selectors, pacer) {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      const count = await page.locator(selector).count();
      if (count <= 0) continue;
      await pacer.beforeAction(page, 120);
      await locator.click({ timeout: 2000 });
      await page.waitForTimeout(400);
      return true;
    } catch {
      // continue
    }
  }
  try {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    return true;
  } catch {
    return false;
  }
}

async function runEntryOperations(page, operations, pacer) {
  for (let i = 0; i < operations.length; i += 1) {
    const item = operations[i];
    const selector = toText(item.selector);
    const mode = toText(item.mode || "click").toLowerCase();
    const waitMs = Number(item.wait_ms ?? 180);
    if (!selector) continue;
    const locator = page.locator(selector).first();
    await locator.waitFor({ state: "visible", timeout: 12000 });
    await pacer.beforeAction(page, 120);
    if (["fill", "type"].includes(mode)) {
      const text = toText(item.input_text);
      try {
        await locator.click({ timeout: 5000 });
      } catch {
        // ignore
      }
      try {
        await locator.fill("");
      } catch {
        // ignore
      }
      if (mode === "type") {
        const delay = toBoolean(pacer.enabled, true) ? pacer.randomBetween(45, 120) : 0;
        await locator.type(text, { delay });
      } else {
        await locator.fill(text);
      }
    } else {
      await locator.click({ timeout: 6000 });
    }
    if (Number.isFinite(waitMs) && waitMs > 0) {
      await page.waitForTimeout(waitMs);
    }
  }
}

function tokenizeForScreening(value) {
  return toText(value)
    .split(/[;,\s/|，；、]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && item.length <= 20)
    .filter((item) => !/^\d+$/.test(item))
    .slice(0, 50);
}

function buildScreeningProfile({ runtime = null, applyOps = null } = {}) {
  const mustTokens = new Set();
  const hintTokens = new Set();
  const blockedTokens = new Set(["不限", "全部", "默认", "未知"]);

  const operations = Array.isArray(applyOps?.operations)
    ? applyOps.operations
    : Array.isArray(applyOps)
      ? applyOps
      : [];

  for (const operation of operations) {
    const mode = toText(operation?.mode).toLowerCase();
    const values = [
      toText(operation?.value),
      toText(operation?.min),
      toText(operation?.max),
      ...(Array.isArray(operation?.values) ? operation.values.map((item) => toText(item)) : []),
      ...(Array.isArray(operation?.companies) ? operation.companies.map((item) => toText(item)) : []),
      ...(Array.isArray(operation?.scope) ? operation.scope.map((item) => toText(item)) : [])
    ]
      .map((item) => item.trim())
      .filter(Boolean);
    for (const value of values) {
      const tokens = tokenizeForScreening(value);
      for (const token of tokens) {
        if (["fill", "type"].includes(mode)) {
          mustTokens.add(token);
        } else {
          hintTokens.add(token);
        }
      }
    }
  }

  if (runtime?.scenario && typeof runtime.scenario === "object") {
    const rawValues = Object.values(runtime.scenario)
      .map((value) => toText(value))
      .filter((value) => value.length >= 2 && value.length <= 80)
      .filter((value) => !/^https?:\/\//i.test(value))
      .slice(0, 60);
    for (const value of rawValues) {
      const tokens = tokenizeForScreening(value);
      for (const token of tokens) {
        if (!mustTokens.has(token)) {
          hintTokens.add(token);
        }
      }
    }
  }

  const filteredMust = [...mustTokens].filter((item) => !blockedTokens.has(item));
  const filteredHint = [...hintTokens]
    .filter((item) => !blockedTokens.has(item))
    .filter((item) => !filteredMust.includes(item));

  return {
    must_tokens: filteredMust.slice(0, 16),
    hint_tokens: filteredHint.slice(0, 40)
  };
}

function decideCardAction({ cardText = "", statusText = "", profile }) {
  const body = `${toText(cardText)}\n${toText(statusText)}`.toLowerCase();
  const mustHits = (profile?.must_tokens ?? []).filter((token) => body.includes(token.toLowerCase()));
  const hintHits = (profile?.hint_tokens ?? []).filter((token) => body.includes(token.toLowerCase()));

  if ((profile?.must_tokens ?? []).length === 0 && (profile?.hint_tokens ?? []).length === 0) {
    return {
      action: "review_uncertain",
      reason: "no_profile_tokens"
    };
  }
  if (mustHits.length === 0 && hintHits.length === 0) {
    return {
      action: "skip",
      reason: "no_profile_hit"
    };
  }
  if (mustHits.length > 0 || hintHits.length >= 2) {
    return {
      action: "review_match",
      reason: "card_high_confidence"
    };
  }
  return {
    action: "review_uncertain",
    reason: "card_partial_hit"
  };
}

function decideFinalSync(score) {
  if (score >= 75) {
    return "match";
  }
  if (score >= 62) {
    return "uncertain";
  }
  return "skip";
}

async function readRuntimeScenario(runtimePath) {
  if (!runtimePath) {
    return null;
  }
  const raw = await readFile(resolve(runtimePath), "utf8");
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

async function readApplyOpsPayload(applyOpsPath) {
  if (!applyOpsPath) {
    return null;
  }
  const raw = await readFile(resolve(applyOpsPath), "utf8");
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

async function buildPageFingerprint(page, cardSelector) {
  try {
    const cards = page.locator(cardSelector);
    const count = await cards.count();
    const picked = [];
    for (let i = 0; i < Math.min(3, count); i += 1) {
      const text = toText(await cards.nth(i).innerText());
      if (text) {
        picked.push(text.slice(0, 64));
      }
    }
    return picked.join("|");
  } catch {
    return "";
  }
}

async function goNextPage(page, selectorMap, pacer, waitMs = DEFAULT_NEXT_PAGE_WAIT_MS) {
  const disabledSelectors = selectorMap.selectors.next_page_disabled ?? [];
  for (const selector of disabledSelectors) {
    try {
      if ((await page.locator(selector).count()) > 0) {
        return false;
      }
    } catch {
      // ignore
    }
  }

  const nextSelectors = selectorMap.selectors.next_page ?? [];
  for (const selector of nextSelectors) {
    try {
      const locator = page.locator(selector).first();
      if ((await page.locator(selector).count()) <= 0) {
        continue;
      }
      const disabledAttr = toText(await locator.getAttribute("disabled"));
      const ariaDisabled = toText(await locator.getAttribute("aria-disabled")).toLowerCase();
      const className = toText(await locator.getAttribute("class")).toLowerCase();
      if (disabledAttr !== "" || ariaDisabled === "true" || className.includes("disabled")) {
        continue;
      }
      await pacer.beforeAction(page, 160);
      await locator.click({ timeout: 5000 });
      await page.waitForTimeout(waitMs);
      return true;
    } catch {
      // try next selector
    }
  }
  return false;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    // eslint-disable-next-line no-console
    console.log(
      [
        "用法:",
        "  node skills/maimai-recruiting-coach/scripts/run-online-candidate-capture.js --list-url <url> --output <raw.json> [options]",
        "",
        "选项:",
        "  --selector-map <json-file>             候选人采集选择器映射（可选）",
        "  --runtime <json-file>                  运行时模板（用于卡片初筛）",
        "  --apply-ops <json-file>                apply-ops（用于卡片初筛）",
        "  --template-name <name>                 模板名称（可选）",
        "  --max-candidates <n>                   最多保留候选人数，默认 500",
        "  --max-pages <n>                        最多翻页数，默认 50",
        "  --headless <true|false>                是否无头，默认 false",
        "  --profile-dir <dir>                    浏览器独立用户空间目录（可选）",
        "  --storage-state <json-file>            登录态文件（可选）",
        "  --save-storage-state <json-file>       执行后保存登录态（可选）",
        "  --humanize <true|false>                拟人化节奏，默认 true",
        "  --login-wait-ms <n>                    未登录时等待手动登录毫秒数，默认 180000",
        "  --wait-after-open-ms <n>               打开页面后等待时长，默认 1200",
        "  --wait-after-click-ms <n>              打开详情后等待时长，默认 900",
        "  --next-page-wait-ms <n>                翻页后等待毫秒数，默认 1400",
        "  --capture-timeout-ms <n>               详情抓取超时，默认 15000"
      ].join("\n")
    );
    process.exit(0);
  }

  const listUrl = toText(args["list-url"]);
  if (!listUrl) {
    throw new Error("缺少 --list-url");
  }
  const outputPath = resolve(toText(args.output) || "data/online-candidates.raw.json");
  const maxCandidates = toPositiveInt(args["max-candidates"], DEFAULT_MAX_CANDIDATES);
  const maxPages = toPositiveInt(args["max-pages"], DEFAULT_MAX_PAGES);
  const waitAfterOpenMs = toPositiveInt(args["wait-after-open-ms"], DEFAULT_WAIT_AFTER_OPEN_MS);
  const waitAfterClickMs = toPositiveInt(args["wait-after-click-ms"], DEFAULT_WAIT_AFTER_CLICK_MS);
  const nextPageWaitMs = toPositiveInt(args["next-page-wait-ms"], DEFAULT_NEXT_PAGE_WAIT_MS);
  const captureTimeoutMs = toPositiveInt(args["capture-timeout-ms"], DEFAULT_CAPTURE_TIMEOUT_MS);
  const selectorMap = mergeSelectorMap(
    DEFAULT_SELECTOR_MAP,
    (await readJsonIfExists(args["selector-map"])) ?? {}
  );
  const runtimePayload = await readRuntimeScenario(toText(args.runtime));
  const applyOpsPayload = await readApplyOpsPayload(toText(args["apply-ops"]));
  const screeningProfile = buildScreeningProfile({
    runtime: runtimePayload,
    applyOps: applyOpsPayload
  });
  ensureWithinAllowedHost(listUrl, selectorMap.allowed_host_suffixes);

  let playwright;
  try {
    playwright = await import("playwright");
  } catch (error) {
    throw new Error(`缺少 playwright 依赖，请先安装（npm i playwright）。原始错误: ${String(error?.message ?? error)}`);
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
  const pacer = new HumanPacer({
    enabled: toBoolean(args.humanize, true)
  });

  const outputRecords = [];
  let cardSelector = "";
  let sourcePage = "";
  let totalCardsDetected = 0;
  const errors = [];
  const stats = {
    pages_processed: 0,
    cards_scanned: 0,
    skipped_by_card: 0,
    detail_reviewed_count: 0,
    included_match_count: 0,
    included_uncertain_count: 0
  };
  const pageFingerprints = new Set();

  try {
    await page.goto(listUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(waitAfterOpenMs);
    await ensureLoggedIn(page, Number(args["login-wait-ms"] ?? 180000));
    const entryOperations = normalizeUiOperations(
      Array.isArray(selectorMap.entry_operations) ? selectorMap.entry_operations : selectorMap.pre_operations
    );
    if (entryOperations.length > 0) {
      await runEntryOperations(page, entryOperations, pacer);
      await page.waitForTimeout(600);
    }
    const landedUrl = toText(page.url());
    if (/(passport|login|auth)/i.test(landedUrl)) {
      throw new Error(
        "未检测到有效登录态，当前跳转到了登录页。请先通过 --storage-state 复用登录态，或先运行 capture-maimai-auth-state.js 采集登录态。"
      );
    }
    sourcePage = `脉脉实时采集(${await page.title()})`;

    let hasNextPage = true;
    while (hasNextPage && stats.pages_processed < maxPages && outputRecords.length < maxCandidates) {
      cardSelector = await firstValidSelector(page, selectorMap.selectors.candidate_card ?? []);
      if (!cardSelector) {
        throw new Error(
          "未定位到候选人卡片列表，可能是未登录/页面结构变化。请检查登录态，并补充 selector-map.selectors.candidate_card。"
        );
      }

      const pageFingerprint = await buildPageFingerprint(page, cardSelector);
      if (pageFingerprint && pageFingerprints.has(pageFingerprint)) {
        break;
      }
      if (pageFingerprint) {
        pageFingerprints.add(pageFingerprint);
      }

      stats.pages_processed += 1;
      const currentPageNo = stats.pages_processed;
      const cardsOnPage = await page.locator(cardSelector).count();
      totalCardsDetected += cardsOnPage;

      for (
        let i = 0;
        i < cardsOnPage && outputRecords.length < maxCandidates;
        i += 1
      ) {
        const card = page.locator(cardSelector).nth(i);
        let detailOpened = false;
        try {
          await card.scrollIntoViewIfNeeded();
          const cardText = (await card.innerText()).trim();
          const cardNameText = await textFromSelectors(card, selectorMap.selectors.card_name ?? []);
          const cardStatusText = await textFromSelectors(card, selectorMap.selectors.card_status ?? []);
          const cardAgeText = await textFromSelectors(card, selectorMap.selectors.card_age ?? []);
          const fallbackName = uniqueLines(cardText)[0] ?? "";
          const cardDecision = decideCardAction({
            cardText,
            statusText: cardStatusText,
            profile: screeningProfile
          });
          stats.cards_scanned += 1;
          if (cardDecision.action === "skip") {
            stats.skipped_by_card += 1;
            continue;
          }

          await pacer.beforeAction(page, 120);
          await card.click({ timeout: 6000 });
          detailOpened = true;
          await page.waitForTimeout(waitAfterClickMs);
          stats.detail_reviewed_count += 1;

          const detailSelector = await firstValidSelector(page, selectorMap.selectors.detail_container ?? []);
          const detailRoot = detailSelector ? page.locator(detailSelector).first() : page.locator("body");
          try {
            await detailRoot.waitFor({ state: "visible", timeout: captureTimeoutMs });
          } catch {
            // allow continuing with body fallback
          }

          const detailTextRaw = (await detailRoot.innerText()).trim();
          const detailLines = uniqueLines(detailTextRaw);
          const detailName = await textFromSelectors(detailRoot, selectorMap.selectors.detail_name ?? []);
          const detailStatus = await textFromSelectors(detailRoot, selectorMap.selectors.detail_status ?? []);
          const detailDesired = await textFromSelectors(
            detailRoot,
            selectorMap.selectors.detail_desired_position ?? []
          );
          const detailEducation = await textFromSelectors(detailRoot, selectorMap.selectors.detail_education ?? []);
          const detailEmployment = await textFromSelectors(detailRoot, selectorMap.selectors.detail_employment ?? []);
          const resumePatterns = [/resume\/view/i, /\.pdf/i, /download/i];
          const resumeLink = await hrefFromSelectors(
            detailRoot,
            selectorMap.selectors.detail_resume_link ?? [],
            resumePatterns,
            page.url()
          );

          const candidateName = toText(detailName || cardNameText || fallbackName || `候选人-${i + 1}`);
          const statusText = toText(detailStatus || cardStatusText || "状态待补充");
          const age = extractAge(`${detailTextRaw}\n${cardAgeText}\n${cardText}`);
          const desiredPosition = toText(
            detailDesired || inferDesiredPosition(detailLines) || "待补充（需人工复核）"
          );
          const educationLines = uniqueLines(`${detailEducation}\n${detailTextRaw}`);
          const employmentLines = uniqueLines(`${detailEmployment}\n${detailTextRaw}`);
          const educationSummary = toText(
            extractEducationLines(educationLines).join("；") || "待补充（实时抓取未完全命中，需人工复核）"
          );
          const employmentHistory = toText(
            extractEmploymentLines(employmentLines).join("；") || "待补充（实时抓取未完全命中，需人工复核）"
          );
          const highlights = extractHighlights(employmentLines);
          const hasAttachment = Boolean(resumeLink) || /附件简历|下载简历|在线简历|简历附件/i.test(detailTextRaw);
          const levels = inferMatchLevels(detailTextRaw, employmentHistory);
          const score = scoreCandidate({
            levels,
            hasAttachment,
            age: age ?? NaN,
            statusText
          });
          const syncDecision = decideFinalSync(score);
          if (syncDecision === "skip") {
            continue;
          }
          const today = new Date().toISOString().slice(0, 10);
          const conclusion = syncDecision === "match" ? "可沟通" : "储备观察";
          if (syncDecision === "match") {
            stats.included_match_count += 1;
          } else {
            stats.included_uncertain_count += 1;
          }

          outputRecords.push({
            source_page: `${sourcePage}-p${currentPageNo}`,
            candidate_name: candidateName,
            age: age ?? null,
            candidate_status: statusText,
            status_change_date: today,
            desired_position: desiredPosition,
            education_summary: educationSummary,
            education_timeline: "",
            employment_history: employmentHistory,
            employment_highlights: highlights.length > 0 ? highlights : ["需人工复核详情摘要"],
            has_attachment_resume: hasAttachment,
            attachment_resume_info: hasAttachment ? "有附件简历，已采集链接" : "无附件简历",
            attachment_resume_preview_url: resumeLink,
            detail_reviewed: true,
            attachment_reviewed: hasAttachment,
            position_match_note: `实时采集：行业背景=${levels.industry_core_background}；甲方核心岗位=${levels.party_a_core_background}；科技相关=${levels.domain_relevance}`,
            position_match_levels: levels,
            score,
            conclusion_override: conclusion,
            conclusion_reason: buildConclusionReason(conclusion, levels),
            greeting_draft: "",
            screening_stage: cardDecision.action,
            screening_reason: cardDecision.reason,
            tags: [syncDecision]
          });
        } catch (error) {
          errors.push({
            page: currentPageNo,
            index: i,
            message: String(error?.message ?? error)
          });
        } finally {
          if (detailOpened) {
            await closeDetail(page, selectorMap.selectors.detail_close ?? [], pacer);
          }
        }
      }

      if (outputRecords.length >= maxCandidates || stats.pages_processed >= maxPages) {
        break;
      }
      hasNextPage = await goNextPage(page, selectorMap, pacer, nextPageWaitMs);
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

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(outputRecords, null, 2)}\n`, "utf8");

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "run-online-candidate-capture",
        template_name: toText(args["template-name"]),
        list_url: listUrl,
        output: outputPath,
        selector_map: toText(args["selector-map"]) ? resolve(toText(args["selector-map"])) : "",
        card_selector: cardSelector,
        total_cards_detected: totalCardsDetected,
        captured_count: outputRecords.length,
        max_candidates: maxCandidates,
        max_pages: maxPages,
        total_pages: stats.pages_processed,
        pages_processed: stats.pages_processed,
        cards_scanned: stats.cards_scanned,
        skipped_by_card: stats.skipped_by_card,
        detail_reviewed_count: stats.detail_reviewed_count,
        included_match_count: stats.included_match_count,
        included_uncertain_count: stats.included_uncertain_count,
        screening_profile: screeningProfile,
        humanize: toBoolean(args.humanize, true),
        errors
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



