function toText(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return String(value).trim();
}

function renderTemplate(template, payload) {
  return String(template ?? "").replace(/\{(\w+)\}/g, (_, key) => {
    return toText(payload?.[key] ?? "");
  });
}

function buildSourceValues(operation = {}, sourceMode = "") {
  const mode = toText(sourceMode || operation.mode || "").toLowerCase();
  if (mode === "companies") {
    return Array.isArray(operation.companies) ? operation.companies : [];
  }
  if (mode === "range") {
    return [
      {
        min: toText(operation.min),
        max: toText(operation.max)
      }
    ];
  }
  if (Array.isArray(operation.values) && operation.values.length > 0) {
    return operation.values;
  }
  if (toText(operation.value)) {
    return [operation.value];
  }
  return [];
}

function normalizeFieldMap(selectorMap = {}) {
  if (selectorMap.field_map && typeof selectorMap.field_map === "object") {
    return selectorMap.field_map;
  }
  if (selectorMap.fields && typeof selectorMap.fields === "object") {
    return selectorMap.fields;
  }
  return {};
}

export function compileApplyOpsForPlaywright(semanticOperations = [], selectorMap = {}) {
  const outputs = [];
  const fieldMap = normalizeFieldMap(selectorMap);
  if (!Array.isArray(semanticOperations) || semanticOperations.length === 0) {
    return outputs;
  }

  for (const operation of semanticOperations) {
    const fieldName = toText(operation?.field);
    const config = fieldMap[fieldName];
    if (!config || typeof config !== "object") {
      continue;
    }

    const sourceValues = buildSourceValues(operation, config.source);
    const usePerValue = Boolean(config.per_value);
    const runValues = usePerValue
      ? sourceValues
      : sourceValues.length === 1
        ? [sourceValues[0]]
        : [sourceValues];
    const opMode = toText(config.mode || "fill") || "fill";
    const waitMs = Number(config.wait_ms ?? 160);

    for (const runValue of runValues) {
      const payload = {
        field: fieldName,
        value: Array.isArray(runValue) ? runValue.join(" ") : toText(runValue),
        item: toText(runValue),
        min: typeof runValue === "object" ? toText(runValue.min) : "",
        max: typeof runValue === "object" ? toText(runValue.max) : "",
        values: Array.isArray(runValue) ? runValue.join(" ") : toText(runValue),
        companies: Array.isArray(operation.companies) ? operation.companies.join(" ") : "",
        raw_value: Array.isArray(runValue) ? JSON.stringify(runValue) : toText(runValue)
      };

      if (config.open_selector) {
        outputs.push({
          selector: toText(config.open_selector),
          mode: "click",
          input_text: "",
          wait_ms: waitMs
        });
      }

      const valueSelector = toText(config.value_selector_template)
        ? renderTemplate(config.value_selector_template, payload)
        : "";
      if (valueSelector) {
        outputs.push({
          selector: valueSelector,
          mode: "click",
          input_text: "",
          wait_ms: waitMs
        });
      } else {
        const selector = toText(config.selector);
        if (!selector) {
          continue;
        }
        outputs.push({
          selector,
          mode: opMode,
          input_text: renderTemplate(
            toText(config.input_template) || "{value}",
            payload
          ),
          wait_ms: waitMs
        });
      }

      if (config.confirm_selector) {
        outputs.push({
          selector: toText(config.confirm_selector),
          mode: "click",
          input_text: "",
          wait_ms: waitMs
        });
      }
    }
  }

  const appendOps = Array.isArray(selectorMap.append_operations) ? selectorMap.append_operations : [];
  for (const item of appendOps) {
    const selector = toText(item?.selector);
    if (!selector) continue;
    outputs.push({
      selector,
      mode: toText(item?.mode || "click") || "click",
      input_text: toText(item?.input_text),
      wait_ms: Number(item?.wait_ms ?? 160)
    });
  }

  return outputs;
}

export function getCaptureSelectors(selectorMap = {}) {
  if (Array.isArray(selectorMap.capture_selectors)) {
    return selectorMap.capture_selectors
      .map((item) => toText(item))
      .filter(Boolean);
  }
  return [];
}

export function normalizeSelectorMap(raw = {}) {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  return raw;
}
