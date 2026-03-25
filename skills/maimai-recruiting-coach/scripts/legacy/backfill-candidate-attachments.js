#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import {
  getTenantAccessToken,
  listTableFields,
  listTableRecords,
  parseBitableUrl,
  updateRecordFields,
  uploadFileToBitable
} from "../lib/feishu-bitable.js";
import { readJsonFile } from "../lib/candidate-storage.js";

const DEFAULT_TEMP_DIR = resolve("data/tmp-resume-attachments-backfill");

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
  const raw = String(record?.attachment_resume_preview_url ?? "").trim();
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

function inferExtByContentType(contentType) {
  const raw = String(contentType ?? "").toLowerCase();
  if (raw.includes("pdf")) {
    return ".pdf";
  }
  return ".pdf";
}

function looksLikePdf(buffer) {
  if (!buffer || buffer.length < 5) {
    return false;
  }
  return buffer.slice(0, 5).toString("utf8") === "%PDF-";
}

function normalizeFileName(fileName, fallbackExt = ".pdf") {
  const sanitized = String(fileName ?? "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_");
  const base = sanitized || `resume${fallbackExt}`;
  const rawExt = extname(base).toLowerCase();
  const ext = !rawExt || rawExt === ".bin" ? fallbackExt : rawExt;
  const stem = base.slice(0, base.length - ext.length) || "resume";
  return `${stem.slice(0, 80)}${ext}`;
}

function buildCandidatePdfFileName(candidateName, fallbackName = "resume.pdf") {
  const rawCandidateName = String(candidateName ?? "").trim();
  if (!rawCandidateName) {
    return normalizeFileName(fallbackName, ".pdf");
  }
  return normalizeFileName(`${rawCandidateName}.pdf`, ".pdf");
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
    throw new Error(`下载失败: HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const ext = inferExtByContentType(contentType);
  const arrayBuffer = await response.arrayBuffer();
  const content = Buffer.from(arrayBuffer);
  if (!content.length) {
    throw new Error("下载结果为空文件");
  }
  if (!looksLikePdf(content)) {
    throw new Error("附件不是 PDF");
  }

  await mkdir(outputDir, { recursive: true });
  const digest = createHash("sha1").update(url).digest("hex").slice(0, 10);
  const filePath = resolve(outputDir, `${Date.now()}-${digest}-resume${ext}`);
  await writeFile(filePath, content);

  return {
    filePath,
    size: content.length
  };
}

function findAttachmentField(fields) {
  return (
    fields.find((item) => Number(item.type) === 17) ??
    fields.find((item) => String(item.field_name ?? "").includes("附件")) ??
    null
  );
}

function findCandidateNameField(fields) {
  return (
    fields.find((item) => String(item.field_name ?? "").includes("候选人")) ??
    fields.find((item) => item.is_primary) ??
    fields[0] ??
    null
  );
}

function parseNameList(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return [];
  }
  return text
    .split(/[;,，；\n]/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function printUsage() {
  // eslint-disable-next-line no-console
  console.log(
    [
      "用法:",
      "  node skills/maimai-recruiting-coach/scripts/backfill-candidate-attachments.js --input <normalized-json> --base-url <candidate-bitable-url> [options]",
      "",
      "可选参数:",
      "  --names <name1,name2,...>            只回填指定候选人",
      "  --attachment-cookie <cookie>         附件下载 Cookie（默认读取 MAIMAI_ATTACHMENT_COOKIE）",
      "  --attachment-auth <token>            附件下载 Authorization（默认读取 MAIMAI_ATTACHMENT_AUTHORIZATION）",
      "  --temp-dir <dir>                     临时下载目录",
      "  --dry-run                            仅预览，不写入飞书"
    ].join("\n")
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printUsage();
    process.exit(0);
  }

  const inputPath = String(args.input ?? "").trim();
  const baseUrl = String(args["base-url"] ?? process.env.FEISHU_CANDIDATE_BASE_URL ?? "").trim();
  if (!inputPath) {
    throw new Error("缺少 --input");
  }
  if (!baseUrl) {
    throw new Error("缺少 --base-url（也可设置 FEISHU_CANDIDATE_BASE_URL）");
  }

  const appId = args["app-id"] ?? process.env.FEISHU_APP_ID;
  const appSecret = args["app-secret"] ?? process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("缺少 FEISHU_APP_ID / FEISHU_APP_SECRET");
  }

  const { appToken, tableId, viewId } = parseBitableUrl(baseUrl);
  if (!appToken || !tableId) {
    throw new Error("无法从 --base-url 解析 app_token/table_id");
  }

  const onlyNames = new Set(parseNameList(args.names));
  const dryRun = toBoolean(args["dry-run"], false);
  const attachmentCookie = String(args["attachment-cookie"] ?? process.env.MAIMAI_ATTACHMENT_COOKIE ?? "").trim();
  const attachmentAuthorization = String(
    args["attachment-auth"] ?? process.env.MAIMAI_ATTACHMENT_AUTHORIZATION ?? ""
  ).trim();
  const tempDir = resolve(String(args["temp-dir"] ?? DEFAULT_TEMP_DIR));

  const recordsFromInput = await readJsonFile(resolve(inputPath));
  const candidates = Array.isArray(recordsFromInput) ? recordsFromInput : [];
  const targetCandidates = candidates.filter((item) => {
    const name = String(item?.candidate_name ?? "").trim();
    if (!name) {
      return false;
    }
    if (onlyNames.size > 0 && !onlyNames.has(name)) {
      return false;
    }
    return Boolean(item?.has_attachment_resume);
  });

  const token = await getTenantAccessToken(appId, appSecret);
  const tableFields = await listTableFields(token, appToken, tableId);
  const attachmentField = findAttachmentField(tableFields);
  const candidateNameField = findCandidateNameField(tableFields);
  if (!attachmentField) {
    throw new Error("候选人表未找到附件字段（type=17）");
  }
  if (!candidateNameField) {
    throw new Error("候选人表未找到候选人姓名字段");
  }

  const tableRecords = await listTableRecords(token, appToken, tableId, {
    viewId: viewId ?? ""
  });

  const recordsByName = new Map();
  for (const row of tableRecords) {
    const fields = row.fields ?? {};
    const name = String(fields[candidateNameField.field_name] ?? "").trim();
    if (!name) {
      continue;
    }
    if (!recordsByName.has(name)) {
      recordsByName.set(name, []);
    }
    recordsByName.get(name).push(row);
  }

  let downloadedCount = 0;
  let uploadedCount = 0;
  let updatedRowCount = 0;
  let skippedNoSource = 0;
  let skippedNoRow = 0;
  let failedCount = 0;
  const tempFiles = [];
  const detail = [];

  try {
    for (const item of targetCandidates) {
      const candidateName = String(item.candidate_name ?? "").trim();
      const sourceUrl = pickAttachmentUrl(item);
      if (!sourceUrl) {
        skippedNoSource += 1;
        detail.push({ candidate_name: candidateName, status: "skipped_no_source" });
        continue;
      }

      const rows = recordsByName.get(candidateName) ?? [];
      if (!rows.length) {
        skippedNoRow += 1;
        detail.push({ candidate_name: candidateName, status: "skipped_no_row" });
        continue;
      }

      try {
        const downloaded = await downloadAttachmentFile(sourceUrl, tempDir, {
          cookie: attachmentCookie,
          authorization: attachmentAuthorization
        });
        downloadedCount += 1;
        tempFiles.push(downloaded.filePath);

        const uploaded = await uploadFileToBitable(token, appToken, downloaded.filePath, {
          fileName: buildCandidatePdfFileName(candidateName, basename(downloaded.filePath))
        });
        uploadedCount += 1;

        for (const row of rows) {
          if (!dryRun) {
            await updateRecordFields(token, appToken, tableId, row.record_id, {
              [attachmentField.field_name]: [{ file_token: uploaded.file_token }]
            });
          }
          updatedRowCount += 1;
        }

        detail.push({
          candidate_name: candidateName,
          status: dryRun ? "dry_run_ready" : "updated",
          matched_rows: rows.length
        });
      } catch (error) {
        failedCount += 1;
        detail.push({
          candidate_name: candidateName,
          status: "failed",
          error: String(error.message ?? error)
        });
      }
    }
  } finally {
    await Promise.all(
      tempFiles.map(async (filePath) => {
        try {
          await rm(filePath, { force: true });
        } catch {
          // ignore cleanup error
        }
      })
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        mode: "backfill-candidate-attachments",
        input: resolve(inputPath),
        app_token: appToken,
        table_id: tableId,
        attachment_field_name: attachmentField.field_name,
        candidate_name_field: candidateNameField.field_name,
        dry_run: dryRun,
        target_candidate_count: targetCandidates.length,
        downloaded_count: downloadedCount,
        uploaded_count: uploadedCount,
        updated_row_count: updatedRowCount,
        skipped_no_source_count: skippedNoSource,
        skipped_no_row_count: skippedNoRow,
        failed_count: failedCount,
        detail
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

