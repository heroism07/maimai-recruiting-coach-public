#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseTemplateVersionName } from "./lib/template-version.js";
import { buildApplyOperationsFromScenario } from "./lib/filter-bridge.js";
import { resolveApplyOperations } from "./lib/filter-path-memory.js";

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

function parseJsonWithBom(rawText) {
  const text = String(rawText ?? "").replace(/^\uFEFF/, "");
  return JSON.parse(text);
}

function toText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value).trim();
  return String(value).trim();
}

function toList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => toText(item)).filter(Boolean);
  }
  return toText(value)
    .split(/[;；,，、|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function toNumber(value) {
  const text = toText(value);
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = toText(value);
    if (text) return text;
  }
  return "";
}

function buildFilterStrategyText({ must, nice, reject, companies, industries, locations, role }) {
  const lines = [];
  lines.push(`目标岗位: ${role}`);
  if (must.length > 0) {
    lines.push(`必须项: ${must.join("；")}`);
  }
  if (nice.length > 0) {
    lines.push(`加分项: ${nice.join("；")}`);
  }
  if (reject.length > 0) {
    lines.push(`排除项: ${reject.join("；")}`);
  }
  if (companies.length > 0) {
    lines.push(`重点公司: ${companies.join("；")}`);
  }
  if (industries.length > 0) {
    lines.push(`行业方向: ${industries.join("；")}`);
  }
  if (locations.length > 0) {
    lines.push(`城市范围: ${locations.join("；")}`);
  }
  return lines.join("\n");
}

function buildRuleBasedScenario(profile, args) {
  const role = firstNonEmpty(
    profile["职位名"],
    profile["岗位名称"],
    profile["job_title"],
    profile["role"],
    "关键岗位"
  );
  const baseNameRaw = firstNonEmpty(
    args["template-name"],
    profile["模版名称"],
    profile["模板名称"],
    profile["template_name"],
    `${role}_${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`
  );
  const baseName = parseTemplateVersionName(baseNameRaw).base_name || baseNameRaw;

  const must = toList(profile.must ?? profile["必须项"]);
  const nice = toList(profile.nice ?? profile["加分项"]);
  const reject = toList(profile.reject ?? profile["排除项"]);
  const companies = toList(profile.target_companies ?? profile["目标公司"]);
  const industries = toList(profile.industries ?? profile["行业方向"]);
  const locations = toList(profile.locations ?? profile["地点"] ?? profile["城市"]);
  const positions = toList(profile.positions ?? profile["职位名称"] ?? role);
  const keywordSeeds = [
    ...toList(profile.keywords ?? profile["关键词"]),
    role,
    ...must.slice(0, 3)
  ].filter(Boolean);

  const expMin = toNumber(firstNonEmpty(profile.exp_min, profile["工作年限最小值"]));
  const expMax = toNumber(firstNonEmpty(profile.exp_max, profile["工作年限最大值"]));
  const ageMin = toNumber(firstNonEmpty(profile.age_min, profile["年龄最小值"]));
  const ageMax = toNumber(firstNonEmpty(profile.age_max, profile["年龄最大值"]));
  const salaryMin = toNumber(firstNonEmpty(profile.salary_k_min, profile["薪资最小K"]));
  const salaryMax = toNumber(firstNonEmpty(profile.salary_k_max, profile["薪资最大K"]));
  const confidentiality = firstNonEmpty(
    profile.confidentiality,
    profile["保密要求"],
    profile["招呼语要求"]
  );
  const greetingRequirement =
    confidentiality ||
    "保密招聘，招呼语中禁止出现岗位名称和职级词，仅描述业务挑战与职责范围。";
  const positionRequirement = firstNonEmpty(
    profile["职位需求"],
    profile["场景名称"],
    profile["scene_name"],
    [...must, ...nice].join(" + ") || role
  );
  const strategy = buildFilterStrategyText({
    must,
    nice,
    reject,
    companies,
    industries,
    locations,
    role
  });

  return {
    模版名称: baseName,
    模版基础名: baseName,
    职位需求: positionRequirement,
    场景名称: positionRequirement,
    筛选策略: strategy,
    是否启用: "是",
    筛选模式: "结构化模式(新字段优先)",
    关键词: [...new Set(keywordSeeds)].join(" "),
    关键词逻辑: firstNonEmpty(profile["关键词逻辑"], profile.keyword_logic, "任一"),
    城市地区: locations.join(";"),
    城市口径: "期望；现居",
    学历_最低: firstNonEmpty(profile["学历最低"], profile.education_min, "本科"),
    学历_最高: firstNonEmpty(profile["学历最高"], profile.education_max, "不限"),
    工作年限_最低_年: expMin ?? "",
    工作年限_最高_年: expMax ?? "",
    就职公司_范围: firstNonEmpty(profile["就职公司范围"], "正任职；曾任职"),
    就职公司_列表: companies.join(";"),
    职位名称: positions.join("；"),
    行业方向: industries.join("；"),
    年龄_最低: ageMin ?? "",
    年龄_最高: ageMax ?? "",
    期望月薪_最低K: salaryMin ?? "",
    期望月薪_最高K: salaryMax ?? "",
    智能筛选_公开求职意向_开关: firstNonEmpty(profile["公开求职意向开关"], "默认(不筛选)"),
    智能筛选_近期有动向_开关: firstNonEmpty(profile["近期有动向开关"], "启用"),
    智能筛选_近期有动向_范围: firstNonEmpty(profile["近期有动向范围"], "近3个月"),
    智能筛选_有附件简历_开关: firstNonEmpty(profile["有附件简历开关"], "默认(不筛选)"),
    智能筛选_有过意向_开关: firstNonEmpty(profile["有过意向开关"], "默认(不筛选)"),
    智能筛选_企业号互动_开关: firstNonEmpty(profile["企业号互动开关"], "默认(不筛选)"),
    招呼语要求: greetingRequirement,
    备注: reject.length > 0 ? `排除项: ${reject.join("；")}` : "",
    筛选条件JSON: JSON.stringify(
      {
        source: "profile-rule-engine",
        profile,
        must,
        nice,
        reject
      },
      null,
      0
    )
  };
}

async function enhanceScenarioByLlm(profile, scenario, args) {
  const apiKey = process.env.OPENAI_API_KEY ?? args["openai-api-key"];
  if (!apiKey) {
    return {
      used_llm: false,
      reason: "missing_openai_api_key",
      patch: {}
    };
  }

  const model = args["llm-model"] ?? "gpt-4.1-mini";
  const systemPrompt =
    "你是招聘筛选策略助手。只输出 JSON 对象，字段仅允许 keywords, keyword_logic, greeting_requirement。";
  const userPrompt = {
    profile,
    scenario,
    requirement:
      "请在不改变岗位方向的前提下，优化关键词和招呼语要求。关键词逻辑只允许“所有”或“任一”。"
  };

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(userPrompt) }
        ],
        temperature: 0.2
      })
    });
    if (!response.ok) {
      return {
        used_llm: false,
        reason: `http_${response.status}`,
        patch: {}
      };
    }
    const payload = await response.json();
    const outputText = toText(payload.output_text);
    const jsonText = outputText.match(/\{[\s\S]*\}/)?.[0] ?? "";
    if (!jsonText) {
      return {
        used_llm: false,
        reason: "empty_json_output",
        patch: {}
      };
    }
    const parsed = JSON.parse(jsonText);
    const patch = {};
    if (toText(parsed.keywords)) {
      patch["关键词"] = toText(parsed.keywords);
    }
    if (["所有", "任一"].includes(toText(parsed.keyword_logic))) {
      patch["关键词逻辑"] = toText(parsed.keyword_logic);
    }
    if (toText(parsed.greeting_requirement)) {
      patch["招呼语要求"] = toText(parsed.greeting_requirement);
    }
    return {
      used_llm: Object.keys(patch).length > 0,
      reason: Object.keys(patch).length > 0 ? "ok" : "no_patch",
      patch
    };
  } catch (error) {
    return {
      used_llm: false,
      reason: String(error.message ?? error),
      patch: {}
    };
  }
}

async function syncScenarioToFeishu(runtimePath, args) {
  if (!args["base-url"]) {
    return {
      synced: false,
      reason: "missing_base_url"
    };
  }
  const scriptPath = resolve("skills/maimai-recruiting-coach/scripts/sync-runtime-filter-to-feishu.js");
  const cmdArgs = [
    scriptPath,
    "--runtime",
    runtimePath,
    "--base-url",
    args["base-url"]
  ];
  const appId = process.env.FEISHU_APP_ID ?? args["app-id"];
  const appSecret = process.env.FEISHU_APP_SECRET ?? args["app-secret"];
  if (appId) {
    cmdArgs.push("--app-id", appId);
  }
  if (appSecret) {
    cmdArgs.push("--app-secret", appSecret);
  }
  if (args["change-note"]) {
    cmdArgs.push("--change-note", args["change-note"]);
  }

  const { stdout } = await execFileAsync("node", cmdArgs, {
    cwd: resolve(".")
  });
  const jsonText = toText(stdout).match(/\{[\s\S]*\}\s*$/)?.[0] ?? "";
  if (!jsonText) {
    return {
      synced: true,
      raw_output: toText(stdout)
    };
  }
  return {
    synced: true,
    result: JSON.parse(jsonText)
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const profilePath = args.profile;
  if (!profilePath) {
    throw new Error("缺少 --profile");
  }

  const profile = parseJsonWithBom(await readFile(resolve(profilePath), "utf8"));
  const outputPath = resolve(args.output ?? "data/generated-filter-template.runtime.json");

  const ruleScenario = buildRuleBasedScenario(profile, args);
  const llmResult = await enhanceScenarioByLlm(profile, ruleScenario, args);
  const scenario = {
    ...ruleScenario,
    ...llmResult.patch
  };

  const runtime = {
    generated_at: new Date().toISOString(),
    generator: "profile-rule-llm-mixed",
    llm: {
      used: llmResult.used_llm,
      reason: llmResult.reason
    },
    profile,
    scenario
  };
  await writeFile(outputPath, `${JSON.stringify(runtime, null, 2)}\n`, "utf8");

  let feishuSync = null;
  if (args["base-url"]) {
    feishuSync = await syncScenarioToFeishu(outputPath, args);
  }

  let applyOpsPath = "";
  let applyOpsMeta = null;
  if (args["apply-maimai"]) {
    applyOpsPath = resolve(args["apply-output"] ?? "data/generated-filter-template.apply-ops.json");
    const generatedOperations = buildApplyOperationsFromScenario(scenario);
    const resolvedApply = await resolveApplyOperations(
      {
        templateName:
          toText(args["template-name"]) ||
          toText(scenario["模版名称"]) ||
          toText(scenario["模版基础名"]) ||
          toText(scenario["职位需求"]),
        pageSignature: toText(args["page-signature"]),
        generatedOperations,
        reuseMode: toText(args["reuse-success-path"]) || "auto"
      },
      args.memory
    );
    const applyOps = {
      generated_at: new Date().toISOString(),
      template_name: scenario["模版名称"],
      apply_ops_source: resolvedApply.apply_ops_source,
      path_reuse_miss_reason: resolvedApply.path_reuse_miss_reason,
      selected_path_id: resolvedApply.selected_path_id,
      reuse_mode: resolvedApply.reuse_mode,
      observability: resolvedApply.observability,
      operations: resolvedApply.operations
    };
    await writeFile(applyOpsPath, `${JSON.stringify(applyOps, null, 2)}\n`, "utf8");
    applyOpsMeta = {
      apply_ops_source: applyOps.apply_ops_source,
      path_reuse_miss_reason: applyOps.path_reuse_miss_reason,
      selected_path_id: applyOps.selected_path_id,
      observability: applyOps.observability
    };
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        ok: true,
        profile: resolve(profilePath),
        runtime_output: outputPath,
        llm_used: llmResult.used_llm,
        llm_reason: llmResult.reason,
        apply_ops_output: applyOpsPath || null,
        apply_ops_meta: applyOpsMeta,
        feishu_sync: feishuSync
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

