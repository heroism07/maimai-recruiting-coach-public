import { isoNow } from "./utils.js";

export const CANDIDATE_RECORD_SCHEMA_VERSION = 1;

const DEFAULT_MATCH_LEVEL = {
  industry_core_background: "unknown",
  party_a_core_background: "unknown",
  domain_relevance: "unknown"
};

function splitByCommonDelimiters(value) {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(/[;；\n]/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergeStatusWithDetail(candidateStatus, statusChangeDate, statusChangeDetail) {
  const status = String(candidateStatus ?? "").trim();
  const detailText = String(statusChangeDetail ?? "").trim();
  const dateText = String(statusChangeDate ?? "").trim();
  if (!status) {
    return status;
  }

  const dynamicStatusRegex = /近期有动向(?!（)/;
  if (detailText) {
    if (status.includes(detailText)) {
      return status;
    }
    if (dynamicStatusRegex.test(status)) {
      return status.replace(dynamicStatusRegex, `近期有动向（${detailText}）`);
    }
    return `${status}（${detailText}）`;
  }

  if (!dateText || status.includes(dateText)) {
    return status;
  }
  if (dynamicStatusRegex.test(status)) {
    return status.replace(dynamicStatusRegex, `近期有动向（${dateText}）`);
  }
  return `${status}（${dateText}）`;
}

function mergeEducationWithTimeline(educationSummary, educationTimeline) {
  const summary = String(educationSummary ?? "").trim();
  const timeline = String(educationTimeline ?? "").trim();
  if (!summary || !timeline) {
    return summary;
  }
  if (summary.includes(timeline)) {
    return summary;
  }

  const summaryParts = splitByCommonDelimiters(summary);
  const timelineParts = splitByCommonDelimiters(timeline);
  const degreePattern = /(博士后|博士|硕士|本科|大专|专科|MBA|EMBA)/i;
  const timelineByDegree = new Map();
  for (const item of timelineParts) {
    const match = item.match(degreePattern);
    if (match?.[1]) {
      timelineByDegree.set(match[1].toLowerCase(), item);
    }
  }

  const usedTimeline = new Set();
  const mergedByDegree = summaryParts.map((item) => {
    const match = item.match(degreePattern);
    if (!match?.[1]) {
      return item;
    }
    const key = match[1].toLowerCase();
    const timeText = timelineByDegree.get(key);
    if (!timeText) {
      return item;
    }
    usedTimeline.add(timeText);
    return `${item}（${timeText}）`;
  });
  const matchedCount = mergedByDegree.filter((item) => /（.+）/.test(item)).length;
  if (matchedCount > 0) {
    const unusedTimeline = timelineParts.filter((item) => !usedTimeline.has(item));
    if (unusedTimeline.length === 0) {
      return mergedByDegree.join("；");
    }
    return `${mergedByDegree.join("；")}；其他在校时间：${unusedTimeline.join("；")}`;
  }

  if (summaryParts.length > 0 && summaryParts.length === timelineParts.length) {
    return summaryParts
      .map((item, index) => `${item}（${timelineParts[index]}）`)
      .join("；");
  }

  return `${summary}；在校时间：${timeline}`;
}

function ensureNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`字段 ${fieldName} 不能为空字符串`);
  }
}

function ensureBoolean(value, fieldName) {
  if (typeof value !== "boolean") {
    throw new Error(`字段 ${fieldName} 必须是布尔值`);
  }
}

function ensureFiniteNumber(value, fieldName) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`字段 ${fieldName} 必须是有效数字`);
  }
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[;；\n]/g)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

export function deriveConclusionByScore(score) {
  if (score >= 85) {
    return "可沟通";
  }
  if (score >= 70) {
    return "储备观察";
  }
  return "不合适";
}

export function buildPositionMatchSummary(match) {
  return `行业核心背景=${match.industry_core_background}; 甲方核心岗位背景=${match.party_a_core_background}; 科技/互联网相关性=${match.domain_relevance}`;
}

export function normalizeCandidateRecord(input, now = isoNow()) {
  ensureNonEmptyString(input.candidate_name, "candidate_name");
  ensureNonEmptyString(input.employment_history, "employment_history");
  ensureNonEmptyString(input.education_summary, "education_summary");
  ensureNonEmptyString(input.desired_position, "desired_position");
  ensureNonEmptyString(input.candidate_status, "candidate_status");
  ensureNonEmptyString(input.position_match_note, "position_match_note");
  ensureFiniteNumber(input.score, "score");
  ensureBoolean(input.has_attachment_resume, "has_attachment_resume");

  if (input.detail_reviewed !== undefined) {
    ensureBoolean(input.detail_reviewed, "detail_reviewed");
  }
  if (input.attachment_reviewed !== undefined) {
    ensureBoolean(input.attachment_reviewed, "attachment_reviewed");
  }
  if (input.age !== undefined && input.age !== null) {
    ensureFiniteNumber(input.age, "age");
  }

  const normalizedMatch = {
    ...DEFAULT_MATCH_LEVEL,
    ...(input.position_match_levels ?? {})
  };

  const conclusion = input.conclusion_override ?? deriveConclusionByScore(input.score);
  ensureNonEmptyString(conclusion, "conclusion");

  const attachmentResumeInfo =
    (input.attachment_resume_info ?? "").trim() ||
    (input.has_attachment_resume ? "有附件简历，详情页已查看" : "无附件简历");
  const rawStatusChangeDate = (input.status_change_date ?? "").trim();
  const rawStatusChangeDetail = (input.status_change_detail ?? "").trim();
  const rawEducationTimeline = (input.education_timeline ?? "").trim();
  const normalizedStatus = mergeStatusWithDetail(
    input.candidate_status,
    rawStatusChangeDate,
    rawStatusChangeDetail
  );
  const normalizedEducation = mergeEducationWithTimeline(input.education_summary, rawEducationTimeline);

  return {
    schema_version: CANDIDATE_RECORD_SCHEMA_VERSION,
    evaluated_at: input.evaluated_at ?? now,
    source_page: input.source_page ?? "",
    candidate_name: input.candidate_name.trim(),
    age: input.age ?? null,
    candidate_status: normalizedStatus,
    status_change_date: rawStatusChangeDate,
    status_change_detail: rawStatusChangeDetail,
    desired_position: input.desired_position.trim(),
    education_summary: normalizedEducation,
    education_timeline: rawEducationTimeline,
    employment_history: input.employment_history.trim(),
    employment_highlights: normalizeList(input.employment_highlights),
    has_attachment_resume: input.has_attachment_resume,
    attachment_resume_info: attachmentResumeInfo,
    attachment_resume_preview_url: (input.attachment_resume_preview_url ?? "").trim(),
    attachment_resume_local_path: (input.attachment_resume_local_path ?? "").trim(),
    detail_reviewed: input.detail_reviewed ?? true,
    attachment_reviewed: input.attachment_reviewed ?? false,
    position_match_note: input.position_match_note.trim(),
    position_match_levels: normalizedMatch,
    position_match_summary: buildPositionMatchSummary(normalizedMatch),
    score: Number(input.score),
    conclusion,
    conclusion_reason: (input.conclusion_reason ?? "").trim(),
    greeting_draft: (input.greeting_draft ?? "").trim(),
    tags: normalizeList(input.tags)
  };
}

export function normalizeCandidateRecordList(inputList, now = isoNow()) {
  if (!Array.isArray(inputList)) {
    throw new Error("候选人输入必须是数组");
  }
  return inputList.map((item) => normalizeCandidateRecord(item, now));
}

