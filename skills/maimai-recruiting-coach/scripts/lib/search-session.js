import { createHash } from "node:crypto";

const TEMPLATE_SPLIT_REGEXP = /[;,，；\n]+/;
const SOFT_REVIEW_CONCLUSIONS = new Set(["可沟通", "储备观察", "模糊", "待沟通"]);

export function parseTemplateNames(rawValue) {
  return String(rawValue ?? "")
    .split(TEMPLATE_SPLIT_REGEXP)
    .map((item) => item.trim())
    .filter(Boolean);
}

function toStringList(rawValue) {
  if (Array.isArray(rawValue)) {
    return rawValue.map((item) => String(item ?? "").trim()).filter(Boolean);
  }
  if (rawValue && typeof rawValue === "object") {
    return [];
  }
  return String(rawValue ?? "")
    .split(TEMPLATE_SPLIT_REGEXP)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeManifestEntry(rawValue) {
  if (Array.isArray(rawValue)) {
    return {
      page_files: toStringList(rawValue)
    };
  }

  if (rawValue && typeof rawValue === "object") {
    return {
      page_files: toStringList(rawValue.page_files ?? rawValue.pages ?? rawValue.files),
      page_signature: String(rawValue.page_signature ?? "").trim()
    };
  }

  return {
    page_files: toStringList(rawValue)
  };
}

export function parsePageManifest(rawManifest) {
  const map = new Map();
  if (!rawManifest) {
    return map;
  }

  if (Array.isArray(rawManifest.templates)) {
    for (const item of rawManifest.templates) {
      const templateName = String(item?.template_name ?? item?.name ?? "")
        .trim();
      if (!templateName) {
        continue;
      }
      map.set(templateName, normalizeManifestEntry(item));
    }
    return map;
  }

  if (Array.isArray(rawManifest)) {
    for (const item of rawManifest) {
      const templateName = String(item?.template_name ?? item?.name ?? "")
        .trim();
      if (!templateName) {
        continue;
      }
      map.set(templateName, normalizeManifestEntry(item));
    }
    return map;
  }

  if (typeof rawManifest === "object") {
    for (const [key, value] of Object.entries(rawManifest)) {
      const templateName = String(key ?? "").trim();
      if (!templateName) {
        continue;
      }
      map.set(templateName, normalizeManifestEntry(value));
    }
  }

  return map;
}

function findTemplateEntry(manifestMap, templateName) {
  if (!manifestMap || manifestMap.size === 0) {
    return null;
  }
  if (manifestMap.has(templateName)) {
    return manifestMap.get(templateName);
  }
  if (manifestMap.has("*")) {
    return manifestMap.get("*");
  }
  return null;
}

export function resolveTemplatePageConfig({
  manifestMap,
  templateName,
  defaultPageFiles = [],
  globalPageSignature = ""
} = {}) {
  const manifestEntry = findTemplateEntry(manifestMap, templateName) ?? {};
  const pageFiles = manifestEntry.page_files?.length ? manifestEntry.page_files : defaultPageFiles;
  const manifestSignature = String(manifestEntry.page_signature ?? "").trim();
  const pageSignature = manifestSignature || String(globalPageSignature ?? "").trim();
  return {
    page_files: pageFiles.map((item) => String(item).trim()).filter(Boolean),
    page_signature: pageSignature
  };
}

export function buildDefaultPageSignature(templateName, filterBaseUrl) {
  const seed = `${String(filterBaseUrl ?? "").trim()}::${String(templateName ?? "").trim()}`;
  return createHash("sha1").update(seed).digest("hex");
}

export function validateCandidateReviewRules(records = []) {
  const violations = [];
  if (!Array.isArray(records)) {
    return [
      {
        code: "invalid_records",
        message: "候选人评估数据不是数组"
      }
    ];
  }

  records.forEach((record, index) => {
    const conclusion = String(record?.conclusion ?? "").trim();
    const shouldStrictReview = SOFT_REVIEW_CONCLUSIONS.has(conclusion);
    if (!shouldStrictReview) {
      return;
    }

    if (!Boolean(record?.detail_reviewed)) {
      violations.push({
        code: "detail_not_reviewed",
        index,
        candidate_name: String(record?.candidate_name ?? "").trim(),
        message: "可沟通/模糊候选人必须先进入详情页评估"
      });
    }

    if (Boolean(record?.has_attachment_resume) && !Boolean(record?.attachment_reviewed)) {
      violations.push({
        code: "attachment_not_reviewed",
        index,
        candidate_name: String(record?.candidate_name ?? "").trim(),
        message: "可沟通/模糊且有附件简历的候选人必须评估附件简历"
      });
    }
  });

  return violations;
}
