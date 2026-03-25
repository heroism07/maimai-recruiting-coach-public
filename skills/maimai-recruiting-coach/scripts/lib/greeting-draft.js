function toText(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }
  return String(value).trim();
}

function splitTokens(text) {
  return toText(text)
    .split(/[；;，,、\/|或]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function extractForbiddenTerms(requirementText) {
  const source = toText(requirementText);
  if (!source) {
    return [];
  }

  const terms = new Set();
  for (const matched of source.matchAll(/[“"']([^”"']+)[”"']/g)) {
    splitTokens(matched[1]).forEach((item) => terms.add(item));
  }
  for (const matched of source.matchAll(/不得出现([^。；;，,\n]+)/g)) {
    splitTokens(matched[1]).forEach((item) => terms.add(item));
  }
  for (const matched of source.matchAll(/不能出现([^。；;，,\n]+)/g)) {
    splitTokens(matched[1]).forEach((item) => terms.add(item));
  }

  return [...terms].filter(Boolean);
}

function removeForbiddenTokens(text, forbiddenTerms) {
  let output = toText(text);
  for (const term of forbiddenTerms) {
    if (!term) continue;
    output = output.replaceAll(term, "核心岗位");
  }
  return output;
}

export function buildGreetingDraft(candidate, options = {}) {
  const requirement = toText(options.greetingRequirement);
  const forbiddenTerms = extractForbiddenTerms(requirement);
  const highlight = Array.isArray(candidate?.employment_highlights)
    ? toText(candidate.employment_highlights[0])
    : "";
  const desiredPosition = toText(candidate?.desired_position);
  const companyText = toText(options.companyName);
  const confidentiality = requirement.includes("保密") ? "该岗位为保密招聘，" : "";

  const base =
    `${candidate?.candidate_name ?? "你好"}，你好。` +
    `${confidentiality}我们在看与你经历匹配的核心岗位机会，` +
    `你在${highlight || "相关业务"}方面的经历与团队当前需求较契合。` +
    `若你近期有交流窗口，想邀请你做一次15分钟沟通，` +
    `${companyText ? `由${companyText}团队` : "由团队"}进一步介绍职责边界与阶段目标。` +
    `${desiredPosition ? `也欢迎你交流对“${desiredPosition}”方向的考虑。` : ""}`;

  const sanitized = removeForbiddenTokens(base, forbiddenTerms);
  return sanitized.replace(/\s+/g, " ").trim();
}

export function shouldGenerateGreetingByConclusion(conclusion, expectedConclusion = "可沟通") {
  return toText(conclusion) === toText(expectedConclusion);
}
