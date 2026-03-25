const PLACEHOLDER_TOKENS = [
  "以候选人卡片展示为准",
  "详见脉脉列表卡片",
  "本轮初筛",
  "卡片展示为准"
];

const CORE_FIELD_RULES = [
  {
    key: "education_summary",
    label: "学历情况",
    type: "text",
    missingReason: "未提取到学历经历"
  },
  {
    key: "employment_history",
    label: "工作履历任职情况",
    type: "text",
    missingReason: "未提取到任职经历"
  },
  {
    key: "employment_highlights",
    label: "履历中的工作内容和亮点",
    type: "list",
    missingReason: "未提取到履历亮点"
  }
];

function normalizeText(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeText(item))
      .filter(Boolean)
      .join("；");
  }
  return String(value).trim();
}

function splitToList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeText(item)).filter(Boolean);
  }
  const text = normalizeText(value);
  if (!text) {
    return [];
  }
  return text
    .split(/[;；\n]/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isPlaceholderText(value) {
  const text = normalizeText(value);
  if (!text) {
    return false;
  }
  return PLACEHOLDER_TOKENS.some((token) => text.includes(token));
}

function sanitizeTextField(value) {
  const text = normalizeText(value);
  if (!text) {
    return {
      valid: false,
      value: "",
      placeholderInterceptedCount: 0
    };
  }
  if (isPlaceholderText(text)) {
    return {
      valid: false,
      value: "",
      placeholderInterceptedCount: 1
    };
  }
  return {
    valid: true,
    value: text,
    placeholderInterceptedCount: 0
  };
}

function sanitizeListField(value) {
  const list = splitToList(value);
  if (list.length === 0) {
    return {
      valid: false,
      value: "",
      placeholderInterceptedCount: 0
    };
  }

  let placeholderInterceptedCount = 0;
  const filtered = [];
  for (const item of list) {
    if (isPlaceholderText(item)) {
      placeholderInterceptedCount += 1;
      continue;
    }
    filtered.push(item);
  }

  if (filtered.length === 0) {
    return {
      valid: false,
      value: "",
      placeholderInterceptedCount
    };
  }

  return {
    valid: true,
    value: filtered,
    placeholderInterceptedCount
  };
}

export function inferFieldSource(record = {}) {
  if (record.has_attachment_resume && record.attachment_reviewed) {
    return "附件简历";
  }
  if (record.detail_reviewed) {
    return "详情页";
  }
  return "卡片(禁写核心字段)";
}

export function assessCandidateDataQuality(record = {}, nowIso = new Date().toISOString()) {
  const reasons = [];
  const sanitized = { ...record };
  let placeholderInterceptedCount = 0;
  let realCoreFieldCount = 0;

  for (const rule of CORE_FIELD_RULES) {
    const sanitizer = rule.type === "list" ? sanitizeListField : sanitizeTextField;
    const result = sanitizer(record[rule.key]);
    placeholderInterceptedCount += result.placeholderInterceptedCount;
    if (result.valid) {
      sanitized[rule.key] = result.value;
      realCoreFieldCount += 1;
      continue;
    }
    sanitized[rule.key] = "";
    reasons.push(rule.missingReason);
  }

  const fieldSource = inferFieldSource(record);
  if (fieldSource === "卡片(禁写核心字段)") {
    reasons.push("仅卡片信息");
  }

  const uniqueReasons = [...new Set(reasons)];
  const dataStatus = uniqueReasons.length === 0 ? "已复核" : "待补全";
  const pendingReason = uniqueReasons.join("；");
  const collectedAt = normalizeText(record.evaluated_at) || nowIso;

  sanitized.data_status = dataStatus;
  sanitized.pending_reason = pendingReason;
  sanitized.field_source = fieldSource;
  sanitized.collected_at = collectedAt;

  return {
    record: sanitized,
    data_status: dataStatus,
    pending_reason: pendingReason,
    field_source: fieldSource,
    placeholder_intercepted_count: placeholderInterceptedCount,
    real_core_field_count: realCoreFieldCount,
    core_field_total_count: CORE_FIELD_RULES.length
  };
}
