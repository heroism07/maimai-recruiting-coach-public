function toText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value).trim();
  return String(value).trim();
}

function splitMulti(value) {
  return toText(value)
    .split(/[;,，；、\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function hasValue(value) {
  return toText(value) !== "";
}

function pickFirstValue(scenario = {}, aliases = []) {
  for (const key of aliases) {
    const value = scenario?.[key];
    if (hasValue(value)) {
      return toText(value);
    }
  }
  return "";
}

function pushOperation(operations, operation) {
  if (!operation || !toText(operation.field)) {
    return;
  }
  operations.push(operation);
}

export function buildApplyOperationsFromScenario(scenario = {}) {
  const operations = [];

  const keyword = pickFirstValue(scenario, ["关键词"]);
  if (keyword) {
    pushOperation(operations, {
      field: "关键词",
      mode: "fill",
      value: keyword
    });
  }

  const keywordLogic = pickFirstValue(scenario, ["关键词逻辑", "关键词逻辑(所有/任一)"]);
  if (keywordLogic) {
    pushOperation(operations, {
      field: "关键词逻辑",
      mode: "select_one",
      value: keywordLogic
    });
  }

  const cities = splitMulti(pickFirstValue(scenario, ["城市地区", "城市地区_列表"]));
  if (cities.length > 0) {
    pushOperation(operations, {
      field: "城市地区",
      mode: "multi_select",
      values: cities
    });
  }

  const eduMin = pickFirstValue(scenario, ["学历_最低"]);
  if (eduMin) {
    pushOperation(operations, {
      field: "学历_最低",
      mode: "select_one",
      value: eduMin
    });
  }

  const eduMax = pickFirstValue(scenario, ["学历_最高"]);
  if (eduMax) {
    pushOperation(operations, {
      field: "学历_最高",
      mode: "select_one",
      value: eduMax
    });
  }

  const expMin = pickFirstValue(scenario, ["工作年限_最低(年)", "工作年限_最低_年"]);
  const expMax = pickFirstValue(scenario, ["工作年限_最高(年)", "工作年限_最高_年"]);
  if (expMin || expMax) {
    pushOperation(operations, {
      field: "工作年限",
      mode: "range",
      min: expMin || null,
      max: expMax || null
    });
  }

  const companyScope = splitMulti(pickFirstValue(scenario, ["就职公司_范围"]));
  const companies = splitMulti(pickFirstValue(scenario, ["就职公司_列表", "就职公司"]));
  if (companyScope.length > 0 || companies.length > 0) {
    pushOperation(operations, {
      field: "就职公司",
      mode: "company_filter",
      scope: companyScope,
      companies
    });
  }

  const positions = splitMulti(pickFirstValue(scenario, ["职位名称"]));
  if (positions.length > 0) {
    pushOperation(operations, {
      field: "职位名称",
      mode: "multi_select",
      values: positions
    });
  }

  const industries = splitMulti(pickFirstValue(scenario, ["行业方向"]));
  if (industries.length > 0) {
    pushOperation(operations, {
      field: "行业方向",
      mode: "multi_select",
      values: industries
    });
  }

  const schools = splitMulti(pickFirstValue(scenario, ["毕业学校"]));
  if (schools.length > 0) {
    pushOperation(operations, {
      field: "毕业学校",
      mode: "multi_select",
      values: schools
    });
  }

  const majors = splitMulti(pickFirstValue(scenario, ["专业"]));
  if (majors.length > 0) {
    pushOperation(operations, {
      field: "专业",
      mode: "multi_select",
      values: majors
    });
  }

  const gender = pickFirstValue(scenario, ["性别"]);
  if (gender) {
    pushOperation(operations, {
      field: "性别",
      mode: "select_one",
      value: gender
    });
  }

  const ageMin = pickFirstValue(scenario, ["年龄_最低"]);
  const ageMax = pickFirstValue(scenario, ["年龄_最高"]);
  if (ageMin || ageMax) {
    pushOperation(operations, {
      field: "年龄",
      mode: "range",
      min: ageMin || null,
      max: ageMax || null
    });
  }

  const salaryMin = pickFirstValue(scenario, ["期望月薪_最低K"]);
  const salaryMax = pickFirstValue(scenario, ["期望月薪_最高K"]);
  if (salaryMin || salaryMax) {
    pushOperation(operations, {
      field: "期望月薪",
      mode: "range",
      min: salaryMin || null,
      max: salaryMax || null
    });
  }

  const hometowns = splitMulti(pickFirstValue(scenario, ["家乡"]));
  if (hometowns.length > 0) {
    pushOperation(operations, {
      field: "家乡",
      mode: "multi_select",
      values: hometowns
    });
  }

  const openIntentSwitch = pickFirstValue(scenario, ["智能筛选_公开求职意向_开关"]);
  if (openIntentSwitch) {
    pushOperation(operations, {
      field: "智能筛选_公开求职意向_开关",
      mode: "toggle",
      value: openIntentSwitch
    });
  }

  const openIntentStatus = pickFirstValue(scenario, ["智能筛选_公开求职意向_状态"]);
  if (openIntentStatus) {
    pushOperation(operations, {
      field: "智能筛选_公开求职意向_状态",
      mode: "multi_select",
      values: splitMulti(openIntentStatus)
    });
  }

  const activeSwitch = pickFirstValue(scenario, ["智能筛选_近期有动向_开关"]);
  if (activeSwitch) {
    pushOperation(operations, {
      field: "智能筛选_近期有动向_开关",
      mode: "toggle",
      value: activeSwitch
    });
  }

  const activeRange = pickFirstValue(scenario, ["智能筛选_近期有动向_范围"]);
  if (activeRange) {
    pushOperation(operations, {
      field: "智能筛选_近期有动向_范围",
      mode: "select_one",
      value: activeRange
    });
  }

  const attachmentSwitch = pickFirstValue(scenario, ["智能筛选_有附件简历_开关"]);
  if (attachmentSwitch) {
    pushOperation(operations, {
      field: "智能筛选_有附件简历_开关",
      mode: "toggle",
      value: attachmentSwitch
    });
  }

  const hasIntentSwitch = pickFirstValue(scenario, ["智能筛选_有过意向_开关"]);
  if (hasIntentSwitch) {
    pushOperation(operations, {
      field: "智能筛选_有过意向_开关",
      mode: "toggle",
      value: hasIntentSwitch
    });
  }

  const enterpriseHelpSwitch = pickFirstValue(scenario, [
    "智能筛选_企业号互动_开关",
    "智能筛选_企业号互助_开关"
  ]);
  if (enterpriseHelpSwitch) {
    pushOperation(operations, {
      field: "智能筛选_企业号互动_开关",
      mode: "toggle",
      value: enterpriseHelpSwitch
    });
  }

  const enterpriseHelpTypes = splitMulti(
    pickFirstValue(scenario, ["智能筛选_企业号互动_类型", "智能筛选_企业号互助_类型"])
  );
  if (enterpriseHelpTypes.length > 0) {
    pushOperation(operations, {
      field: "智能筛选_企业号互动_类型",
      mode: "multi_select",
      values: enterpriseHelpTypes
    });
  }

  const sortMode = pickFirstValue(scenario, ["排序方式"]);
  if (sortMode) {
    pushOperation(operations, {
      field: "排序方式",
      mode: "select_one",
      value: sortMode
    });
  }

  return operations;
}

export function parseFilterSummaryToScenario(summaryItems = []) {
  const scenario = {};
  const plainText = summaryItems
    .flatMap((item) => (Array.isArray(item?.texts) ? item.texts : []))
    .join(" | ");

  const cityMatch = plainText.match(/城市地区[^-]*-\s*([^|]+)/);
  if (cityMatch?.[1]) {
    scenario["城市地区"] = cityMatch[1].replaceAll("、", ";").trim();
  }

  const ageMatch = plainText.match(/年龄[:：\s]*([0-9]+)岁?[^|]*/);
  if (ageMatch?.[1]) {
    scenario["年龄_最高"] = ageMatch[1];
  }

  const degreeMatch = plainText.match(/学历(?:要求)?[:：\s]*([^|]+)/);
  if (degreeMatch?.[1]) {
    scenario["学历要求"] = degreeMatch[1].trim();
  }

  const activeMatch = plainText.match(/近期有动向[^|]*/);
  if (activeMatch?.[0]) {
    scenario["智能筛选_近期有动向"] = activeMatch[0].trim();
  }

  return scenario;
}
