const ALLOWED_ACTIONS = new Set([
  "open_page",
  "wait_for_stable",
  "apply_filter",
  "apply_filter_bundle",
  "capture_filter_summary",
  "scroll_candidates",
  "open_profile",
  "send_greeting",
  "back_to_list",
  "refresh_page"
]);

function validateSelector(selector) {
  if (!selector || typeof selector !== "object") {
    throw new Error("selector 必须是对象。");
  }
  if (typeof selector.key !== "string" || selector.key.trim() === "") {
    throw new Error("selector.key 必须为非空字符串。");
  }
  if (typeof selector.primary !== "string" || selector.primary.trim() === "") {
    throw new Error(`selector(${selector.key}) 缺少 primary。`);
  }
  if (selector.fallbacks && !Array.isArray(selector.fallbacks)) {
    throw new Error(`selector(${selector.key}) 的 fallbacks 必须是数组。`);
  }
}

export function assertCompliantWorkflow(workflow) {
  if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) {
    throw new Error("workflow.steps 不能为空。");
  }
  if (!Array.isArray(workflow.selectors)) {
    throw new Error("workflow.selectors 必须是数组。");
  }
  workflow.selectors.forEach(validateSelector);

  workflow.steps.forEach((step, index) => {
    if (!ALLOWED_ACTIONS.has(step.action)) {
      throw new Error(`步骤 ${index + 1} 的 action(${step.action}) 不在允许列表。`);
    }
    if (step.fallback_action && !ALLOWED_ACTIONS.has(step.fallback_action)) {
      throw new Error(`步骤 ${index + 1} 的 fallback_action(${step.fallback_action}) 不在允许列表。`);
    }
  });
}

export function resolveSelector(selectors, selectorKey) {
  if (!selectorKey) {
    return null;
  }
  const found = selectors.find((item) => item.key === selectorKey);
  if (!found) {
    return null;
  }
  return {
    primary: found.primary,
    fallbacks: found.fallbacks ?? []
  };
}
