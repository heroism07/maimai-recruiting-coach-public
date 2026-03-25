function toText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value).trim();
  return String(value).trim();
}

export function inferContactWindowSuggestion(candidateStatus) {
  const status = toText(candidateStatus);
  if (!status) {
    return "3天内";
  }
  if (status.includes("急求职") || status.includes("刚刚活跃")) {
    return "24小时内";
  }
  if (status.includes("今日活跃") || status.includes("近期有动向")) {
    return "3天内";
  }
  if (status.includes("近1周活跃")) {
    return "7天内";
  }
  return "7天内";
}

export function buildRecommendationReason(record) {
  const reasons = [];
  if (Number.isFinite(Number(record?.score))) {
    reasons.push(`评分${Number(record.score)}`);
  }
  const note = toText(record?.position_match_note);
  if (note) {
    reasons.push(note);
  }
  const source = toText(record?.field_source);
  if (source) {
    reasons.push(`来源=${source}`);
  }
  const pending = toText(record?.pending_reason);
  if (pending) {
    reasons.push(`待关注=${pending}`);
  }
  return reasons.join("；").slice(0, 220);
}

export function buildShortlist(records = [], options = {}) {
  const highScoreThreshold = Number.isFinite(Number(options.highScoreThreshold))
    ? Number(options.highScoreThreshold)
    : 85;
  const topN = Number.isFinite(Number(options.topN)) ? Math.max(1, Math.trunc(Number(options.topN))) : 10;
  const candidates = Array.isArray(records) ? records : [];
  const filtered = candidates.filter((item) => {
    const score = Number(item?.score);
    if (!Number.isFinite(score)) return false;
    return (
      score >= highScoreThreshold &&
      toText(item?.conclusion) === "可沟通" &&
      toText(item?.data_status || "已复核") !== "待补全"
    );
  });

  const sorted = [...filtered].sort((a, b) => {
    const scoreDiff = Number(b.score) - Number(a.score);
    if (scoreDiff !== 0) return scoreDiff;
    return toText(a.candidate_name).localeCompare(toText(b.candidate_name), "zh-Hans-CN");
  });

  return sorted.slice(0, topN).map((item, index) => ({
    rank: index + 1,
    candidate_name: toText(item.candidate_name),
    score: Number(item.score),
    conclusion: toText(item.conclusion),
    recommendation_reason: buildRecommendationReason(item),
    contact_window_suggestion: inferContactWindowSuggestion(item.candidate_status),
    has_attachment_resume: Boolean(item.has_attachment_resume),
    field_source: toText(item.field_source),
    pending_reason: toText(item.pending_reason)
  }));
}
