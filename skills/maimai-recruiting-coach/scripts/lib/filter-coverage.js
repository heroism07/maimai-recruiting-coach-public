function toText(value) {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim();
}

function hasValue(value) {
  return toText(value) !== "";
}

function pickFirstFieldValue(scenario = {}, aliases = []) {
  for (const key of aliases) {
    const value = scenario?.[key];
    if (hasValue(value)) {
      return toText(value);
    }
  }
  return "";
}

function normalizeFieldMap(selectorMap = {}) {
  if (selectorMap?.field_map && typeof selectorMap.field_map === "object") {
    return selectorMap.field_map;
  }
  if (selectorMap?.fields && typeof selectorMap.fields === "object") {
    return selectorMap.fields;
  }
  return {};
}

const FIELD_REQUIREMENTS = [
  {
    id: "关键词",
    aliases: ["关键词"],
    operation_fields: ["关键词"],
    critical: true
  },
  {
    id: "关键词逻辑",
    aliases: ["关键词逻辑", "关键词逻辑(所有/任一)"],
    operation_fields: ["关键词逻辑"],
    critical: true
  },
  {
    id: "城市地区",
    aliases: ["城市地区", "城市地区_列表"],
    operation_fields: ["城市地区"],
    critical: false
  },
  {
    id: "学历下限",
    aliases: ["学历_最低"],
    operation_fields: ["学历_最低"],
    critical: true
  },
  {
    id: "学历上限",
    aliases: ["学历_最高"],
    operation_fields: ["学历_最高"],
    critical: false
  },
  {
    id: "工作年限",
    aliases: ["工作年限_最低_年", "工作年限_最高_年"],
    operation_fields: ["工作年限"],
    critical: false
  },
  {
    id: "就职公司",
    aliases: ["就职公司_范围", "就职公司_列表", "就职公司"],
    operation_fields: ["就职公司"],
    critical: false
  },
  {
    id: "职位名称",
    aliases: ["职位名称"],
    operation_fields: ["职位名称"],
    critical: true
  },
  {
    id: "行业方向",
    aliases: ["行业方向"],
    operation_fields: ["行业方向"],
    critical: false
  },
  {
    id: "年龄上限",
    aliases: ["年龄_最高"],
    operation_fields: ["年龄"],
    critical: true
  },
  {
    id: "智能筛选_近期有动向",
    aliases: ["智能筛选_近期有动向_开关", "智能筛选_近期有动向_范围"],
    operation_fields: ["智能筛选_近期有动向_开关", "智能筛选_近期有动向_范围"],
    critical: true
  },
  {
    id: "智能筛选_有附件简历",
    aliases: ["智能筛选_有附件简历_开关"],
    operation_fields: ["智能筛选_有附件简历_开关"],
    critical: false
  },
  {
    id: "排序方式",
    aliases: ["排序方式"],
    operation_fields: ["排序方式"],
    critical: false
  }
];

function collectOperationFieldSet(operations = []) {
  const fieldSet = new Set();
  for (const operation of operations) {
    const field = toText(operation?.field);
    if (field) {
      fieldSet.add(field);
    }
  }
  return fieldSet;
}

export function buildFilterCoverageChecklist({
  scenario = {},
  operations = [],
  selectorMap = {}
} = {}) {
  const operationFieldSet = collectOperationFieldSet(operations);
  const fieldMap = normalizeFieldMap(selectorMap);
  const selectorFieldSet = new Set(Object.keys(fieldMap));
  const checklist = [];

  for (const requirement of FIELD_REQUIREMENTS) {
    const scenarioValue = pickFirstFieldValue(scenario, requirement.aliases);
    if (!hasValue(scenarioValue)) {
      continue;
    }
    const hasOperation = requirement.operation_fields.some((field) => operationFieldSet.has(field));
    const hasSelector = requirement.operation_fields.some((field) => selectorFieldSet.has(field));
    const scriptCapable = hasOperation && hasSelector;
    checklist.push({
      id: requirement.id,
      value: scenarioValue,
      critical: Boolean(requirement.critical),
      operation_fields: requirement.operation_fields,
      has_operation: hasOperation,
      has_selector_mapping: hasSelector,
      script_capable: scriptCapable,
      recommended_channel: scriptCapable ? "script" : "ai"
    });
  }

  const criticalItems = checklist.filter((item) => item.critical);
  const criticalBlocked = criticalItems.filter((item) => !item.script_capable);
  const scriptCapableCount = checklist.filter((item) => item.script_capable).length;
  const total = checklist.length;

  return {
    generated_at: new Date().toISOString(),
    total_required: total,
    script_capable_count: scriptCapableCount,
    script_coverage_rate: total > 0 ? Number((scriptCapableCount / total).toFixed(4)) : 1,
    critical_required_count: criticalItems.length,
    critical_blocked_count: criticalBlocked.length,
    critical_blocked_fields: criticalBlocked.map((item) => item.id),
    items: checklist
  };
}

export function shouldFailOnCoverage(checklist, { failOnCriticalBlocked = true } = {}) {
  if (!failOnCriticalBlocked) {
    return false;
  }
  return Number(checklist?.critical_blocked_count ?? 0) > 0;
}
