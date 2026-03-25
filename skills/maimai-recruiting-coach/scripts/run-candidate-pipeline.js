#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import {
  normalizeCandidateRecordList
} from "./lib/candidate-record.js";
import {
  appendNdjson,
  readJsonFile,
  writeJsonFile
} from "./lib/candidate-storage.js";
import {
  batchCreateRecords,
  getTenantAccessToken,
  listTableRecords,
  listTableFields,
  parseBitableUrl,
  uploadFileToBitable
} from "./lib/feishu-bitable.js";
import { buildGreetingDraft, shouldGenerateGreetingByConclusion } from "./lib/greeting-draft.js";
import { resolveGreetingWritePolicy } from "./lib/greeting-policy.js";
import { pickTemplateRecordByQuery } from "./lib/template-version.js";
import { assessCandidateDataQuality } from "./lib/candidate-quality.js";
import {
  buildRecommendationReason,
  buildShortlist,
  inferContactWindowSuggestion
} from "./lib/candidate-shortlist.js";

const defaultOutputPath = resolve("data/candidate-evaluations.normalized.json");
const defaultNdjsonPath = resolve("data/candidate-evaluations.ndjson");

const FIELD_ALIAS_MAP = {
  evaluated_at: ["评估时间", "更新时间"],
  candidate_name: ["候选人"],
  age: ["年龄"],
  candidate_status: ["状态情况", "求职状态"],
  desired_position: ["求职职位", "期望职位"],
  education_summary: ["学历情况", "教育经历"],
  employment_history: ["工作履历任职情况", "任职情况", "工作履历"],
  employment_highlights: ["履历中的工作内容和亮点", "履历亮点", "工作亮点"],
  has_attachment_resume: ["有无附件简历", "附件简历"],
  attachment_resume_info: ["附件简历信息", "附件简历说明"],
  detail_reviewed: ["详情页已复核", "详情已复核"],
  attachment_reviewed: ["附件简历已查看", "附件已预览"],
  position_match_note: ["职位匹配度", "匹配度说明"],
  position_match_summary: ["匹配度结构化", "匹配度分层"],
  score: ["评分", "综合评分"],
  conclusion: ["结论", "建议结论"],
  conclusion_reason: ["结论原因", "不合适原因", "结论说明"],
  greeting_draft: ["打招呼话术草稿", "话术草稿"],
  tags: ["职业标签", "标签"],
  data_status: ["数据状态"],
  pending_reason: ["待补全原因"],
  field_source: ["字段来源"],
  collected_at: ["采集时间", "同步采集时间"],
  high_priority: ["高优先级", "候选人优先级", "优先级"],
  recommendation_reason: ["推荐理由", "高分推荐理由", "推荐说明"],
  contact_window_suggestion: ["建议联系窗口", "建议联系时间窗", "联系窗口建议"],
  shortlist_rank: ["shortlist排序", "推荐排序", "Shortlist排序"]
};

const ATTACHMENT_FIELD_ALIASES = ["附件简历附件", "附件简历文件", "附件"];
const DEFAULT_ATTACHMENT_TEMP_DIR = resolve("data/tmp-resume-attachments");
const ATTACHMENT_FILENAME_MAX_LENGTH = 80;

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

function printUsage() {
  const usage = `
用法:
  node skills/maimai-recruiting-coach/scripts/run-candidate-pipeline.js normalize --input <json-file> [--output <json-file>] [--append-ndjson]
  node skills/maimai-recruiting-coach/scripts/run-candidate-pipeline.js sync-feishu --input <normalized-json-file> [--base-url <feishu-bitable-url>] [--app-id <id>] [--app-secret <secret>] [--dry-run] [--skip-attachment-upload] [--attachment-cookie <cookie>] [--attachment-field-name <name>] [--attachment-temp-dir <dir>] [--keep-attachment-files] [--greeting-from-template [<filter-base-url>]] [--filter-base-url <url>] [--template-name <name>] [--greeting-only-for <结论>] [--greeting-write-policy <empty_only|overwrite>] [--overwrite-greeting] [--high-score-threshold <n>] [--shortlist-top-n <n>] [--shortlist-output <json-file>]

环境变量:
  FEISHU_APP_ID
  FEISHU_APP_SECRET
  FEISHU_CANDIDATE_BASE_URL
  FEISHU_FILTER_BASE_URL

说明:
  1) normalize 会将候选人评估统一成标准字段，包含不合适人选。
  2) sync-feishu 会尝试按字段别名写入飞书多维表格；表中不存在的字段将自动跳过。
  3) sync-feishu 默认会尝试把简历附件链接下载并上传到飞书附件字段（失败自动降级，不中断主流程）。
  4) sync-feishu 可选根据筛选模板“招呼语要求”自动生成打招呼话术草稿，默认仅对“可沟通”候选人生效。
  5) sync-feishu 会拦截占位文案（如“以候选人卡片展示为准”），核心字段空置并标记“待补全”。
  6) sync-feishu 会生成高分候选人 shortlist（默认 score>=85 且可沟通），并输出建议联系窗口。
`;
  // eslint-disable-next-line no-console
  console.log(usage.trim());
}

function buildCandidateFallbackText(record) {
  const parts = [
    `候选人:${record.candidate_name}`,
    `年龄:${record.age ?? "未知"}`,
    `状态:${record.candidate_status}`,
    `求职职位:${record.desired_position}`,
    `学历:${record.education_summary}`,
    `匹配度:${record.position_match_note}`,
    `评分:${record.score}`,
    `结论:${record.conclusion}`,
    `附件简历:${record.attachment_resume_info || (record.has_attachment_resume ? "有" : "无")}`,
    `话术:${record.greeting_draft || "未生成"}`
  ];
  return parts.join(" | ");
}

function normalizeValueForFeishu(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValueForFeishu(item)).filter(Boolean).join("；");
  }
  if (typeof value === "boolean") {
    return value ? "是" : "否";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function findFieldNameByAliases(tableFields, aliases, expectedType = null) {
  if (!Array.isArray(tableFields) || tableFields.length === 0) {
    return "";
  }

  for (const alias of aliases) {
    const byName = tableFields.find((item) => item.field_name === alias);
    if (!byName) {
      continue;
    }
    if (expectedType !== null && Number(byName.type) !== Number(expectedType)) {
      continue;
    }
    return byName.field_name;
  }

  if (expectedType !== null) {
    const byType = tableFields.find((item) => Number(item.type) === Number(expectedType));
    if (byType?.field_name) {
      return byType.field_name;
    }
  }

  return "";
}

function decodeUrlValue(value, maxDepth = 3) {
  let result = String(value ?? "");
  for (let i = 0; i < maxDepth; i += 1) {
    try {
      const decoded = decodeURIComponent(result);
      if (decoded === result) {
        break;
      }
      result = decoded;
    } catch {
      break;
    }
  }
  return result;
}

function pickAttachmentUrl(record) {
  const raw = (record.attachment_resume_preview_url ?? "").trim();
  if (!raw) {
    return "";
  }
  if (!/^https?:\/\//i.test(raw)) {
    return "";
  }

  try {
    const parsed = new URL(raw);
    const targetUrl = parsed.searchParams.get("targetUrl");
    if (targetUrl) {
      const decodedTarget = decodeUrlValue(targetUrl);
      if (/^https?:\/\//i.test(decodedTarget)) {
        return decodedTarget;
      }
    }
    return raw;
  } catch {
    return raw;
  }
}

function resolveCandidateAttachmentLocalPath(record) {
  const raw = (record.attachment_resume_local_path ?? "").trim();
  if (!raw) {
    return "";
  }
  return resolve(raw);
}

function hasAttachmentSource(record) {
  const localPath = resolveCandidateAttachmentLocalPath(record);
  if (localPath) {
    return true;
  }
  const url = pickAttachmentUrl(record);
  if (url) {
    return true;
  }
  return false;
}

function normalizeFileName(fileName, fallbackExt = ".pdf") {
  const sanitized = (fileName ?? "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_");

  const base = sanitized || `resume${fallbackExt}`;
  const rawExt = extname(base).toLowerCase();
  const ext = !rawExt || rawExt === ".bin" ? fallbackExt : rawExt;
  const stem = base.slice(0, base.length - ext.length) || "resume";
  const clippedStem = stem.slice(0, ATTACHMENT_FILENAME_MAX_LENGTH);
  return `${clippedStem}${ext}`;
}

function buildCandidatePdfFileName(record, fallbackName = "resume.pdf") {
  const rawCandidateName = String(record?.candidate_name ?? "").trim();
  if (!rawCandidateName) {
    return normalizeFileName(fallbackName, ".pdf");
  }
  return normalizeFileName(`${rawCandidateName}.pdf`, ".pdf");
}

function inferExtByContentType(contentType) {
  const raw = String(contentType ?? "").toLowerCase();
  if (!raw) {
    return ".pdf";
  }
  if (raw.includes("pdf")) {
    return ".pdf";
  }
  if (raw.includes("msword")) {
    return ".doc";
  }
  if (raw.includes("officedocument.wordprocessingml.document")) {
    return ".docx";
  }
  if (raw.includes("application/zip")) {
    return ".zip";
  }
  if (raw.includes("text/plain")) {
    return ".txt";
  }
  return ".pdf";
}

function looksLikePdf(buffer) {
  if (!buffer || buffer.length < 5) {
    return false;
  }
  return buffer.slice(0, 5).toString("utf8") === "%PDF-";
}

function parseFilenameFromHeaders(headers) {
  const disposition = headers.get("content-disposition") ?? "";
  if (!disposition) {
    return "";
  }

  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }

  const normalMatch = disposition.match(/filename="?([^";]+)"?/i);
  return normalMatch?.[1] ?? "";
}

function parseFilenameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const segment = parsed.pathname.split("/").filter(Boolean).at(-1) ?? "";
    return segment;
  } catch {
    return "";
  }
}

async function downloadAttachmentFile(url, outputDir, options = {}) {
  if (typeof fetch !== "function") {
    throw new Error("当前 Node 版本不支持 fetch，请升级到 Node.js 18+");
  }

  const headers = {};
  if (options.cookie) {
    headers.Cookie = options.cookie;
  }
  if (options.authorization) {
    headers.Authorization = options.authorization;
  }

  const response = await fetch(url, {
    method: "GET",
    headers,
    redirect: "follow"
  });
  if (!response.ok) {
    throw new Error(`下载失败，HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const ext = inferExtByContentType(contentType);
  const urlName = parseFilenameFromUrl(url);
  const headerName = parseFilenameFromHeaders(response.headers);
  const rawFileName = headerName || urlName || `resume${ext}`;

  const arrayBuffer = await response.arrayBuffer();
  const content = Buffer.from(arrayBuffer);
  if (!content.length) {
    throw new Error("下载结果为空文件");
  }

  if (!looksLikePdf(content)) {
    throw new Error("附件不是 PDF，已跳过上传");
  }

  const fileName = normalizeFileName(rawFileName, ".pdf");

  await mkdir(outputDir, { recursive: true });
  const digest = createHash("sha1").update(url).digest("hex").slice(0, 10);
  const filePath = resolve(outputDir, `${Date.now()}-${digest}-${fileName}`);
  await writeFile(filePath, content);

  return {
    filePath,
    fileName,
    size: content.length,
    contentType
  };
}

async function buildAttachmentFieldValue(record, context) {
  if (!record.has_attachment_resume) {
    return null;
  }

  const localPath = resolveCandidateAttachmentLocalPath(record);
  if (localPath) {
    const localContent = await readFile(localPath);
    if (!looksLikePdf(localContent)) {
      throw new Error("本地附件不是 PDF，已跳过上传");
    }
    const localName = buildCandidatePdfFileName(record, basename(localPath));
    const uploaded = await uploadFileToBitable(context.token, context.appToken, localPath, {
      fileName: localName
    });
    return {
      value: [{ file_token: uploaded.file_token }],
      fileName: uploaded.file_name,
      source: "local-path"
    };
  }

  const url = pickAttachmentUrl(record);
  if (!url) {
    return null;
  }

  const fromCache = context.downloadCache.get(url);
  if (fromCache?.ok) {
    return fromCache.payload;
  }
  if (fromCache?.ok === false) {
    throw new Error(fromCache.error);
  }
  try {
    const downloaded = await downloadAttachmentFile(url, context.tempDir, {
      cookie: context.attachmentCookie,
      authorization: context.attachmentAuthorization
    });

    const uploaded = await uploadFileToBitable(
      context.token,
      context.appToken,
      downloaded.filePath,
      {
        fileName: buildCandidatePdfFileName(record, downloaded.fileName)
      }
    );

    const payload = {
      value: [{ file_token: uploaded.file_token }],
      fileName: uploaded.file_name,
      source: "download-url"
    };
    context.downloadCache.set(url, { ok: true, payload });
    context.tempFiles.push(downloaded.filePath);
    return payload;
  } catch (error) {
    context.downloadCache.set(url, { ok: false, error: String(error.message ?? error) });
    throw error;
  }
}

function buildFeishuFields(record, tableFieldMap) {
  const fields = {};

  for (const [canonicalKey, aliases] of Object.entries(FIELD_ALIAS_MAP)) {
    const targetField = aliases.find((name) => tableFieldMap.has(name));
    if (!targetField) {
      continue;
    }
    const value = record[canonicalKey];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    fields[targetField] = normalizeValueForFeishu(value);
  }

  const levelMap = record.position_match_levels ?? {};
  const mergedMatch = [
    `行业背景=${levelMap.industry_core_background ?? "unknown"}`,
    `甲方核心岗位=${levelMap.party_a_core_background ?? "unknown"}`,
    `科技互联网相关=${levelMap.domain_relevance ?? "unknown"}`
  ].join("；");

  const matchFieldName = ["匹配度结构化", "匹配度分层"].find((name) => tableFieldMap.has(name));
  if (matchFieldName) {
    fields[matchFieldName] = mergedMatch;
  }

  // 兜底：若目标表仅有默认“文本”列，仍可先完成写入验证。
  if (Object.keys(fields).length === 0 && tableFieldMap.has("文本")) {
    fields["文本"] = buildCandidateFallbackText(record);
  }

  return fields;
}

function resolveFilterBaseUrl(args) {
  const direct = (args["filter-base-url"] ?? "").trim();
  if (direct) {
    return direct;
  }
  const fromEnv = (process.env.FEISHU_FILTER_BASE_URL ?? "").trim();
  if (fromEnv) {
    return fromEnv;
  }
  if (typeof args["greeting-from-template"] === "string" && args["greeting-from-template"].trim() !== "") {
    return args["greeting-from-template"].trim();
  }
  return "";
}

async function loadGreetingTemplateConfig(args, tenantToken, appId, appSecret) {
  const enabled = Boolean(args["greeting-from-template"]);
  if (!enabled) {
    return {
      enabled: false,
      greetingOnlyFor: args["greeting-only-for"] ?? "可沟通"
    };
  }

  const filterBaseUrl = resolveFilterBaseUrl(args);
  const templateName = (args["template-name"] ?? args["filter-template-name"] ?? "").trim();
  if (!filterBaseUrl || !templateName) {
    throw new Error("启用 --greeting-from-template 时，需要提供 --template-name 和筛选模板表 URL");
  }

  const { appToken, tableId, viewId } = parseBitableUrl(filterBaseUrl);
  if (!appToken || !tableId) {
    throw new Error("筛选模板 base-url 解析失败，缺少 app_token 或 table_id");
  }

  const token = tenantToken ?? (await getTenantAccessToken(appId, appSecret));
  const records = await listTableRecords(token, appToken, tableId, {
    viewId: args["respect-filter-view"] ? viewId ?? "" : ""
  });
  const matched = pickTemplateRecordByQuery(records, templateName, ["模版名称", "模板名称", "场景名称"]);
  if (!matched) {
    throw new Error(`未找到筛选模板: ${templateName}`);
  }
  const fields = matched.fields ?? {};
  return {
    enabled: true,
    templateName: fields["模版名称"] ?? templateName,
    templateRecordId: matched.record_id,
    greetingRequirement: String(fields["招呼语要求"] ?? "").trim(),
    greetingOnlyFor: args["greeting-only-for"] ?? "可沟通",
    companyName: args["greeting-company"] ?? ""
  };
}

async function runNormalize(args) {
  if (!args.input) {
    throw new Error("normalize 缺少 --input");
  }
  const inputPath = resolve(args.input);
  const outputPath = resolve(args.output ?? defaultOutputPath);
  const raw = await readJsonFile(inputPath);
  const normalized = normalizeCandidateRecordList(raw);
  await writeJsonFile(outputPath, normalized);

  if (args["append-ndjson"]) {
    await appendNdjson(resolve(args["ndjson-path"] ?? defaultNdjsonPath), normalized);
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        mode: "normalize",
        input: inputPath,
        output: outputPath,
        count: normalized.length,
        appended_ndjson: Boolean(args["append-ndjson"])
      },
      null,
      2
    )
  );
}

async function runSyncFeishu(args) {
  if (!args.input) {
    throw new Error("sync-feishu 缺少 --input");
  }
  const baseUrl = String(args["base-url"] ?? process.env.FEISHU_CANDIDATE_BASE_URL ?? "").trim();
  if (!baseUrl) {
    throw new Error("sync-feishu 缺少 --base-url（也可设置 FEISHU_CANDIDATE_BASE_URL）");
  }

  const appId = args["app-id"] ?? process.env.FEISHU_APP_ID;
  const appSecret = args["app-secret"] ?? process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("未提供飞书 App ID / App Secret，请通过参数或环境变量传入");
  }

  const inputPath = resolve(args.input);
  const normalizedRecords = await readJsonFile(inputPath);
  const { appToken, tableId } = parseBitableUrl(baseUrl);
  if (!appToken || !tableId) {
    throw new Error("无法从 base-url 解析 app_token 或 table_id");
  }

  const token = await getTenantAccessToken(appId, appSecret);
  const tableFields = await listTableFields(token, appToken, tableId);
  const tableFieldMap = new Map(tableFields.map((item) => [item.field_name, item]));
  const primaryFieldName = tableFields.find((item) => item.is_primary)?.field_name ?? "";
  const candidatePrimaryFieldName = tableFieldMap.has("候选人") ? "候选人" : primaryFieldName;
  const greetingConfig = await loadGreetingTemplateConfig(args, token, appId, appSecret);
  const greetingWritePolicy = resolveGreetingWritePolicy(
    args["greeting-write-policy"],
    Boolean(args["overwrite-greeting"])
  );
  const shouldOverwriteGreeting = greetingWritePolicy === "overwrite";
  const isDryRun = Boolean(args["dry-run"]);
  const shouldUploadAttachment = !args["skip-attachment-upload"];
  const strictAttachmentSource = !toBoolean(args["allow-missing-attachment-source"], false);
  const attachmentFieldName =
    args["attachment-field-name"] ?? findFieldNameByAliases(tableFields, ATTACHMENT_FIELD_ALIASES, 17);
  const attachmentUploadEnabled = shouldUploadAttachment && Boolean(attachmentFieldName) && !isDryRun;
  const highScoreThreshold = Number.isFinite(Number(args["high-score-threshold"]))
    ? Number(args["high-score-threshold"])
    : 85;
  const shortlistTopN = Number.isFinite(Number(args["shortlist-top-n"]))
    ? Math.max(1, Math.trunc(Number(args["shortlist-top-n"])))
    : 10;
  const shortlistOutputEnabled =
    !toBoolean(args["disable-shortlist-output"], false) &&
    String(args["shortlist-output"] ?? "").trim().toLowerCase() !== "off";
  const shortlistOutputPath = resolve(args["shortlist-output"] ?? "data/candidate-shortlist.latest.json");

  const attachmentContext = {
    token,
    appToken,
    tempDir: resolve(args["attachment-temp-dir"] ?? DEFAULT_ATTACHMENT_TEMP_DIR),
    attachmentCookie: args["attachment-cookie"] ?? process.env.MAIMAI_ATTACHMENT_COOKIE ?? "",
    attachmentAuthorization: args["attachment-auth"] ?? process.env.MAIMAI_ATTACHMENT_AUTHORIZATION ?? "",
    downloadCache: new Map(),
    tempFiles: []
  };

  const payloadRecords = [];
  let attachmentUploadedCount = 0;
  let attachmentSkippedCount = 0;
  let attachmentFailedCount = 0;
  let attachmentSourceMissingCount = 0;
  let greetingGeneratedCount = 0;
  let greetingSkippedCount = 0;
  let greetingFailedCount = 0;
  let verifiedCount = 0;
  let pendingCount = 0;
  let placeholderInterceptedCount = 0;
  let realCoreFieldCount = 0;
  let coreFieldTotalCount = 0;
  const syncUnits = [];

  try {
    for (const record of normalizedRecords) {
      let enrichedRecord = record;
      if (greetingConfig.enabled) {
        const shouldGenerate = shouldGenerateGreetingByConclusion(
          enrichedRecord.conclusion,
          greetingConfig.greetingOnlyFor
        );
        const hasDraft = Boolean(String(enrichedRecord.greeting_draft ?? "").trim());
        if (shouldGenerate && (!hasDraft || shouldOverwriteGreeting)) {
          try {
            const greetingDraft = buildGreetingDraft(enrichedRecord, {
              greetingRequirement: greetingConfig.greetingRequirement,
              companyName: greetingConfig.companyName
            });
            enrichedRecord = {
              ...enrichedRecord,
              greeting_draft: greetingDraft
            };
            greetingGeneratedCount += 1;
          } catch (error) {
            greetingFailedCount += 1;
            const reason = String(error.message ?? error).slice(0, 120);
            enrichedRecord = {
              ...enrichedRecord,
              conclusion_reason: [enrichedRecord.conclusion_reason, `话术生成失败: ${reason}`]
                .filter(Boolean)
                .join(" | ")
            };
          }
        } else {
          greetingSkippedCount += 1;
        }
      }

      const quality = assessCandidateDataQuality(enrichedRecord);
      enrichedRecord = quality.record;
      placeholderInterceptedCount += quality.placeholder_intercepted_count;
      realCoreFieldCount += quality.real_core_field_count;
      coreFieldTotalCount += quality.core_field_total_count;
      if (quality.data_status === "待补全") {
        pendingCount += 1;
      } else {
        verifiedCount += 1;
      }
      const isHighPriorityCandidate =
        Number(enrichedRecord.score) >= highScoreThreshold &&
        String(enrichedRecord.conclusion ?? "").trim() === "可沟通" &&
        String(enrichedRecord.data_status ?? "") !== "待补全";
      enrichedRecord = {
        ...enrichedRecord,
        high_priority: isHighPriorityCandidate ? "是" : "否",
        recommendation_reason: buildRecommendationReason(enrichedRecord),
        contact_window_suggestion: inferContactWindowSuggestion(enrichedRecord.candidate_status),
        shortlist_rank: ""
      };

      const fields = buildFeishuFields(enrichedRecord, tableFieldMap);
      if (candidatePrimaryFieldName) {
        fields[candidatePrimaryFieldName] = enrichedRecord.candidate_name;
      }
      if (tableFieldMap.has("候选人姓名")) {
        delete fields["候选人姓名"];
      }
      if (attachmentUploadEnabled) {
        const hasSource = hasAttachmentSource(enrichedRecord);
        if (enrichedRecord.has_attachment_resume && !hasSource) {
          attachmentSourceMissingCount += 1;
          if (strictAttachmentSource) {
            attachmentFailedCount += 1;
            const infoFieldName = findFieldNameByAliases(
              tableFields,
              FIELD_ALIAS_MAP.attachment_resume_info
            );
            if (infoFieldName) {
              const existingInfo = String(fields[infoFieldName] ?? enrichedRecord.attachment_resume_info ?? "");
              fields[infoFieldName] = [
                existingInfo,
                "附件上传跳过: 缺少 attachment_resume_preview_url/local_path"
              ]
                .filter(Boolean)
                .join(" | ");
            }
          } else {
            attachmentSkippedCount += 1;
          }
        } else {
          try {
            const attachmentValue = await buildAttachmentFieldValue(enrichedRecord, attachmentContext);
            if (attachmentValue?.value) {
              fields[attachmentFieldName] = attachmentValue.value;
              attachmentUploadedCount += 1;
            } else if (enrichedRecord.has_attachment_resume) {
              attachmentSkippedCount += 1;
            }
          } catch (error) {
            attachmentFailedCount += 1;
            const message = String(error.message ?? error).slice(0, 100);
            const infoFieldName = findFieldNameByAliases(
              tableFields,
              FIELD_ALIAS_MAP.attachment_resume_info
            );
            if (infoFieldName) {
              const existingInfo = String(fields[infoFieldName] ?? enrichedRecord.attachment_resume_info ?? "");
              fields[infoFieldName] = [existingInfo, `附件上传失败: ${message}`].filter(Boolean).join(" | ");
            }
          }
        }
      } else if (enrichedRecord.has_attachment_resume) {
        attachmentSkippedCount += 1;
      }

      if (Object.keys(fields).length > 0) {
        payloadRecords.push(fields);
        syncUnits.push({
          record: enrichedRecord,
          fields
        });
      }
    }
  } finally {
    if (!args["keep-attachment-files"]) {
      await Promise.all(
        attachmentContext.tempFiles.map(async (filePath) => {
          try {
            await rm(filePath, { force: true });
          } catch {
            // 清理临时文件失败不影响主流程
          }
        })
      );
    }
  }

  const shortlistItems = buildShortlist(
    syncUnits.map((item) => item.record),
    {
      highScoreThreshold,
      topN: shortlistTopN
    }
  );
  const shortlistedKeys = new Set(shortlistItems.map((item) => `${item.candidate_name}#${item.score}`));
  const rankFieldName = findFieldNameByAliases(tableFields, FIELD_ALIAS_MAP.shortlist_rank);
  const reasonFieldName = findFieldNameByAliases(tableFields, FIELD_ALIAS_MAP.recommendation_reason);
  const contactWindowFieldName = findFieldNameByAliases(tableFields, FIELD_ALIAS_MAP.contact_window_suggestion);
  const highPriorityFieldName = findFieldNameByAliases(tableFields, FIELD_ALIAS_MAP.high_priority);
  const rankedKeys = new Set();
  for (const shortlistItem of shortlistItems) {
    const key = `${shortlistItem.candidate_name}#${shortlistItem.score}`;
    if (rankedKeys.has(key)) {
      continue;
    }
    const target = syncUnits.find((item) => {
      const itemKey = `${item.record.candidate_name}#${item.record.score}`;
      return itemKey === key && !rankedKeys.has(itemKey);
    });
    if (!target) {
      continue;
    }
    target.record.shortlist_rank = String(shortlistItem.rank);
    target.record.high_priority = "是";
    target.record.recommendation_reason = shortlistItem.recommendation_reason;
    target.record.contact_window_suggestion = shortlistItem.contact_window_suggestion;
    if (rankFieldName) {
      target.fields[rankFieldName] = String(shortlistItem.rank);
    }
    if (reasonFieldName) {
      target.fields[reasonFieldName] = shortlistItem.recommendation_reason;
    }
    if (contactWindowFieldName) {
      target.fields[contactWindowFieldName] = shortlistItem.contact_window_suggestion;
    }
    if (highPriorityFieldName) {
      target.fields[highPriorityFieldName] = "是";
    }
    rankedKeys.add(key);
  }
  for (const item of syncUnits) {
    const key = `${item.record.candidate_name}#${item.record.score}`;
    if (!shortlistedKeys.has(key) && highPriorityFieldName) {
      item.fields[highPriorityFieldName] = "否";
    }
  }

  const shortlistPayload = {
    generated_at: new Date().toISOString(),
    input: inputPath,
    high_score_threshold: highScoreThreshold,
    shortlist_top_n: shortlistTopN,
    source_count: normalizedRecords.length,
    shortlist_count: shortlistItems.length,
    items: shortlistItems
  };
  if (shortlistOutputEnabled) {
    await writeJsonFile(shortlistOutputPath, shortlistPayload);
  }

  let createdCount = 0;
  if (!isDryRun) {
    createdCount = await batchCreateRecords(token, appToken, tableId, payloadRecords);
  }
  const realFieldCoverageRate = coreFieldTotalCount > 0 ? round(realCoreFieldCount / coreFieldTotalCount, 4) : 0;

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        mode: "sync-feishu",
        input: inputPath,
        app_token: appToken,
        table_id: tableId,
        source_count: normalizedRecords.length,
        valid_payload_count: payloadRecords.length,
        dry_run: isDryRun,
        created_count: createdCount,
        attachment_upload_enabled: attachmentUploadEnabled,
        strict_attachment_source: strictAttachmentSource,
        attachment_field_name: attachmentFieldName || null,
        attachment_uploaded_count: attachmentUploadedCount,
        attachment_skipped_count: attachmentSkippedCount,
        attachment_failed_count: attachmentFailedCount,
        attachment_source_missing_count: attachmentSourceMissingCount,
        greeting_template_enabled: greetingConfig.enabled,
        greeting_template_name: greetingConfig.templateName ?? null,
        greeting_generated_count: greetingGeneratedCount,
        greeting_skipped_count: greetingSkippedCount,
        greeting_failed_count: greetingFailedCount,
        greeting_only_for: greetingConfig.greetingOnlyFor ?? null,
        greeting_write_policy: greetingWritePolicy,
        greeting_overwrite_enabled: shouldOverwriteGreeting,
        verified_count: verifiedCount,
        pending_count: pendingCount,
        placeholder_intercepted_count: placeholderInterceptedCount,
        core_field_total_count: coreFieldTotalCount,
        core_field_real_count: realCoreFieldCount,
        real_field_coverage_rate: realFieldCoverageRate,
        high_score_threshold: highScoreThreshold,
        shortlist_top_n: shortlistTopN,
        shortlist_count: shortlistItems.length,
        shortlist_output: shortlistOutputEnabled ? shortlistOutputPath : null
      },
      null,
      2
    )
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command] = args._;
  if (!command || args.help || args.h) {
    printUsage();
    process.exit(0);
  }

  if (command === "normalize") {
    await runNormalize(args);
    return;
  }

  if (command === "sync-feishu") {
    await runSyncFeishu(args);
    return;
  }

  throw new Error(`未知命令: ${command}`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`执行失败: ${error.message}`);
  process.exit(1);
});

