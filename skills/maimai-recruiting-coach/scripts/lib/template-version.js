const DEFAULT_TEMPLATE_ALIASES = ["模版名称", "模板名称", "场景名称"];
const VERSION_SUFFIX_REGEX = /^(.*)@v(\d{1,6})$/i;

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
  if (typeof value === "object" && typeof value.text === "string") {
    return value.text.trim();
  }
  return String(value).trim();
}

export function parseTemplateVersionName(inputName) {
  const raw = toText(inputName);
  if (!raw) {
    return {
      raw_name: "",
      base_name: "",
      version: null,
      is_versioned: false,
      full_name: ""
    };
  }
  const matched = raw.match(VERSION_SUFFIX_REGEX);
  if (!matched) {
    return {
      raw_name: raw,
      base_name: raw,
      version: null,
      is_versioned: false,
      full_name: raw
    };
  }
  const baseName = toText(matched[1]);
  const version = Number(matched[2]);
  if (!baseName || !Number.isFinite(version)) {
    return {
      raw_name: raw,
      base_name: raw,
      version: null,
      is_versioned: false,
      full_name: raw
    };
  }
  return {
    raw_name: raw,
    base_name: baseName,
    version,
    is_versioned: true,
    full_name: buildVersionedTemplateName(baseName, version)
  };
}

export function buildVersionedTemplateName(baseName, version, width = 3) {
  const normalizedBase = toText(baseName);
  if (!normalizedBase) {
    return "";
  }
  const v = Number(version);
  if (!Number.isFinite(v) || v <= 0) {
    return normalizedBase;
  }
  return `${normalizedBase}@v${String(Math.trunc(v)).padStart(width, "0")}`;
}

export function getTemplateNameFromFields(fields = {}, aliases = DEFAULT_TEMPLATE_ALIASES) {
  for (const alias of aliases) {
    const text = toText(fields?.[alias]);
    if (text) {
      return text;
    }
  }
  return "";
}

function toTimestamp(value) {
  if (value === undefined || value === null || value === "") {
    return 0;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e12) return value;
    if (value > 1e9) return value * 1000;
    return value;
  }
  const text = toText(value);
  if (!text) return 0;
  const maybeNumber = Number(text);
  if (Number.isFinite(maybeNumber)) {
    return toTimestamp(maybeNumber);
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function extractRecordTemplateMeta(record, aliases = DEFAULT_TEMPLATE_ALIASES) {
  const templateName = getTemplateNameFromFields(record?.fields ?? {}, aliases);
  const parsed = parseTemplateVersionName(templateName);
  return {
    template_name: templateName,
    base_name: parsed.base_name,
    version: parsed.version,
    is_versioned: parsed.is_versioned
  };
}

export function filterTemplateRecordsByBase(records, baseName, aliases = DEFAULT_TEMPLATE_ALIASES) {
  const normalizedBase = toText(baseName);
  if (!normalizedBase) {
    return [];
  }
  return records.filter((record) => {
    const meta = extractRecordTemplateMeta(record, aliases);
    return meta.base_name === normalizedBase;
  });
}

export function pickLatestTemplateRecord(records, aliases = DEFAULT_TEMPLATE_ALIASES) {
  if (!Array.isArray(records) || records.length === 0) {
    return null;
  }
  return records
    .map((record, index) => {
      const meta = extractRecordTemplateMeta(record, aliases);
      return {
        record,
        index,
        version: Number.isFinite(meta.version) ? meta.version : 0,
        time: Math.max(
          toTimestamp(record.last_modified_time),
          toTimestamp(record.created_time),
          toTimestamp(record.fields?.["最近执行时间"])
        )
      };
    })
    .sort((a, b) => {
      if (b.version !== a.version) {
        return b.version - a.version;
      }
      if (b.time !== a.time) {
        return b.time - a.time;
      }
      return b.index - a.index;
    })[0]?.record;
}

export function pickTemplateRecordByQuery(records, queryName, aliases = DEFAULT_TEMPLATE_ALIASES) {
  const query = parseTemplateVersionName(queryName);
  if (!query.raw_name) {
    return null;
  }
  if (query.is_versioned) {
    const exact = records.filter((record) => {
      const meta = extractRecordTemplateMeta(record, aliases);
      return meta.template_name === query.full_name;
    });
    return pickLatestTemplateRecord(exact, aliases);
  }
  const byBase = filterTemplateRecordsByBase(records, query.base_name, aliases);
  return pickLatestTemplateRecord(byBase, aliases);
}

export function getNextTemplateVersion(records, baseName, aliases = DEFAULT_TEMPLATE_ALIASES) {
  const matched = filterTemplateRecordsByBase(records, baseName, aliases);
  const maxVersion = matched.reduce((acc, record) => {
    const meta = extractRecordTemplateMeta(record, aliases);
    const current = Number.isFinite(meta.version) ? meta.version : 0;
    return Math.max(acc, current);
  }, 0);
  return maxVersion + 1;
}

export function buildTemplateVersionFields(baseName, version) {
  const normalizedBase = toText(baseName);
  const normalizedVersion = Number.isFinite(Number(version)) ? Math.trunc(Number(version)) : 0;
  const fullName = buildVersionedTemplateName(normalizedBase, normalizedVersion);
  return {
    模版名称: fullName,
    模板名称: fullName,
    模版基础名: normalizedBase,
    模版版本: normalizedVersion
  };
}
