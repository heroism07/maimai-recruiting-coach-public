import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { parseTemplateVersionName } from "./template-version.js";

const DEFAULT_MEMORY_PATH = resolve("data/maimai-filter-path-memory.json");
const DEFAULT_SIGNATURE_PLACEHOLDER = "__default__";
const SUCCESS_STATUSES = new Set(["success", "ok", "passed", "true", "1"]);

function nowIso() {
  return new Date().toISOString();
}

function hashText(value) {
  return createHash("sha1").update(String(value ?? "")).digest("hex");
}

function normalizeOperations(rawValue) {
  if (Array.isArray(rawValue)) {
    return rawValue;
  }
  if (rawValue && Array.isArray(rawValue.operations)) {
    return rawValue.operations;
  }
  return [];
}

function signatureHash(pageSignature) {
  return hashText(pageSignature || DEFAULT_SIGNATURE_PLACEHOLDER);
}

function normalizePathMetrics(metrics = {}) {
  return {
    total_runs: Number(metrics.total_runs ?? 0),
    success_runs: Number(metrics.success_runs ?? 0),
    fail_runs: Number(metrics.fail_runs ?? 0),
    last_success_at: metrics.last_success_at || null,
    last_fail_at: metrics.last_fail_at || null,
    consecutive_failures: Number(metrics.consecutive_failures ?? 0)
  };
}

function normalizeReuseStats(stats = {}) {
  return {
    resolve_total: Number(stats.resolve_total ?? 0),
    resolve_hit_exact: Number(stats.resolve_hit_exact ?? 0),
    resolve_hit_fallback: Number(stats.resolve_hit_fallback ?? 0),
    resolve_miss: Number(stats.resolve_miss ?? 0),
    apply_total: Number(stats.apply_total ?? 0),
    apply_success: Number(stats.apply_success ?? 0),
    apply_failed: Number(stats.apply_failed ?? 0),
    apply_retry_total: Number(stats.apply_retry_total ?? 0)
  };
}

function normalizePathItem(item = {}) {
  return {
    ...item,
    status: item.status || "active",
    page_signature: item.page_signature || "",
    page_signature_hash: item.page_signature_hash || signatureHash(item.page_signature || ""),
    operations: normalizeOperations(item.operations),
    metrics: normalizePathMetrics(item.metrics ?? {})
  };
}

function normalizeMemory(payload) {
  const empty = {
    schema_version: 1,
    updated_at: nowIso(),
    paths: [],
    stats: normalizeReuseStats()
  };
  if (!payload || typeof payload !== "object") {
    return empty;
  }
  return {
    schema_version: Number(payload.schema_version || 1),
    updated_at: payload.updated_at || nowIso(),
    paths: Array.isArray(payload.paths) ? payload.paths.map((item) => normalizePathItem(item)) : [],
    stats: normalizeReuseStats(payload.stats ?? {})
  };
}

async function ensureMemoryFile(filePath) {
  await mkdir(dirname(filePath), { recursive: true });
  try {
    await stat(filePath);
  } catch {
    await writeFile(
      filePath,
      `${JSON.stringify(
        {
          schema_version: 1,
          updated_at: nowIso(),
          paths: [],
          stats: normalizeReuseStats()
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }
}

export async function loadFilterPathMemory(memoryPath = DEFAULT_MEMORY_PATH) {
  const targetPath = resolve(memoryPath);
  await ensureMemoryFile(targetPath);
  const raw = await readFile(targetPath, "utf8");
  return {
    path: targetPath,
    memory: normalizeMemory(JSON.parse(raw))
  };
}

export async function saveFilterPathMemory(memoryPath, memory) {
  const targetPath = resolve(memoryPath);
  await mkdir(dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(memory, null, 2)}\n`, "utf8");
  await rename(tmpPath, targetPath);
}

function comparePathScore(left, right) {
  const leftScore = Number(left.metrics?.success_runs ?? 0);
  const rightScore = Number(right.metrics?.success_runs ?? 0);
  if (leftScore !== rightScore) {
    return rightScore - leftScore;
  }
  const leftTime = Date.parse(left.metrics?.last_success_at ?? left.updated_at ?? 0);
  const rightTime = Date.parse(right.metrics?.last_success_at ?? right.updated_at ?? 0);
  return rightTime - leftTime;
}

export function findBestFilterPath(paths, { templateName, pageSignature = "" } = {}) {
  const parsedTemplate = parseTemplateVersionName(templateName);
  const baseName = parsedTemplate.base_name || templateName;
  if (!baseName) {
    return {
      path: null,
      match_type: "none",
      miss_reason: "no_template"
    };
  }

  const matched = paths.filter((item) => item.template_base_name === baseName && item.status !== "deprecated");
  if (matched.length === 0) {
    return {
      path: null,
      match_type: "none",
      miss_reason: "no_path"
    };
  }

  if (pageSignature) {
    const exact = matched.filter((item) => item.page_signature_hash === signatureHash(pageSignature));
    if (exact.length > 0) {
      return {
        path: [...exact].sort(comparePathScore)[0],
        match_type: "exact",
        miss_reason: ""
      };
    }
    return {
      path: [...matched].sort(comparePathScore)[0],
      match_type: "fallback",
      miss_reason: "no_signature_match"
    };
  }

  return {
    path: [...matched].sort(comparePathScore)[0],
    match_type: "fallback",
    miss_reason: ""
  };
}

export function pickBestFilterPath(paths, options = {}) {
  return findBestFilterPath(paths, options).path;
}

function isSuccessStatus(status) {
  return SUCCESS_STATUSES.has(String(status ?? "").trim().toLowerCase());
}

function normalizeReuseMode(mode) {
  const normalized = String(mode ?? "").trim().toLowerCase();
  if (normalized === "on" || normalized === "off" || normalized === "auto" || normalized === "exact") {
    return normalized;
  }
  return "auto";
}

function areOperationsSame(leftOps = [], rightOps = []) {
  try {
    return JSON.stringify(normalizeOperations(leftOps)) === JSON.stringify(normalizeOperations(rightOps));
  } catch {
    return false;
  }
}

function applyResolveStat(memory, source) {
  memory.stats = normalizeReuseStats(memory.stats);
  memory.stats.resolve_total += 1;
  if (source === "success_path_exact") {
    memory.stats.resolve_hit_exact += 1;
    return;
  }
  if (source === "success_path_fallback") {
    memory.stats.resolve_hit_fallback += 1;
    return;
  }
  memory.stats.resolve_miss += 1;
}

function applyExecutionStat(memory, success, retryCount = 0) {
  memory.stats = normalizeReuseStats(memory.stats);
  memory.stats.apply_total += 1;
  if (success) {
    memory.stats.apply_success += 1;
  } else {
    memory.stats.apply_failed += 1;
  }
  const retry = Number(retryCount);
  if (Number.isFinite(retry) && retry > 0) {
    memory.stats.apply_retry_total += retry;
  }
}

function upsertSuccessPath(memory, { templateName, baseName, operations, pageSignature = "", note = "" }) {
  const now = nowIso();
  const sigHash = signatureHash(pageSignature);
  const existingIndex = memory.paths.findIndex(
    (item) =>
      item.template_base_name === baseName &&
      (item.page_signature_hash || signatureHash(item.page_signature || "")) === sigHash &&
      item.status !== "deprecated"
  );

  if (existingIndex >= 0) {
    const previous = normalizePathItem(memory.paths[existingIndex]);
    const changed = !areOperationsSame(previous.operations, operations);
    const totalRuns = Number(previous.metrics?.total_runs ?? 0) + 1;
    const successRuns = Number(previous.metrics?.success_runs ?? 0) + 1;
    memory.paths[existingIndex] = {
      ...previous,
      template_name: templateName || previous.template_name,
      page_signature: pageSignature || previous.page_signature || "",
      page_signature_hash: sigHash,
      operations: normalizeOperations(operations),
      note: note || previous.note || "",
      updated_at: now,
      status: "active",
      metrics: {
        ...normalizePathMetrics(previous.metrics),
        total_runs: totalRuns,
        success_runs: successRuns,
        consecutive_failures: 0,
        last_success_at: now
      }
    };
    return {
      path: memory.paths[existingIndex],
      changed
    };
  }

  const created = {
    path_id: `fpath_${hashText(`${baseName}:${sigHash}:${now}`).slice(0, 12)}`,
    template_base_name: baseName,
    template_name: templateName || baseName,
    page_signature: pageSignature || "",
    page_signature_hash: sigHash,
    status: "active",
    operations: normalizeOperations(operations),
    note: note || "",
    created_at: now,
    updated_at: now,
    metrics: {
      total_runs: 1,
      success_runs: 1,
      fail_runs: 0,
      last_success_at: now,
      last_fail_at: null,
      consecutive_failures: 0
    }
  };
  memory.paths.push(created);
  return {
    path: created,
    changed: true
  };
}

function markFailureOnPath(memory, path) {
  if (!path) {
    return {
      updated_path: null,
      deprecated: false
    };
  }
  const now = nowIso();
  const idx = memory.paths.findIndex((item) => item.path_id === path.path_id);
  if (idx < 0) {
    return {
      updated_path: null,
      deprecated: false
    };
  }
  const current = normalizePathItem(memory.paths[idx]);
  const metrics = normalizePathMetrics(current.metrics);
  const nextConsecutive = metrics.consecutive_failures + 1;
  const deprecated = nextConsecutive >= 2;
  memory.paths[idx] = {
    ...current,
    status: deprecated ? "deprecated" : current.status,
    updated_at: now,
    metrics: {
      ...metrics,
      total_runs: metrics.total_runs + 1,
      fail_runs: metrics.fail_runs + 1,
      consecutive_failures: nextConsecutive,
      last_fail_at: now
    }
  };
  return {
    updated_path: memory.paths[idx],
    deprecated
  };
}

export function summarizePathReuseStats(memoryOrStats = {}) {
  const stats = normalizeReuseStats(memoryOrStats.stats ?? memoryOrStats);
  const hit = stats.resolve_hit_exact + stats.resolve_hit_fallback;
  return {
    path_hit_rate: stats.resolve_total > 0 ? hit / stats.resolve_total : 0,
    avg_apply_retry_count: stats.apply_total > 0 ? stats.apply_retry_total / stats.apply_total : 0,
    apply_success_rate: stats.apply_total > 0 ? stats.apply_success / stats.apply_total : 0,
    totals: stats
  };
}

export async function resolveApplyOperations(
  {
    templateName,
    pageSignature = "",
    generatedOperations = [],
    reuseMode = "auto"
  },
  memoryPath = DEFAULT_MEMORY_PATH
) {
  const { path: targetPath, memory } = await loadFilterPathMemory(memoryPath);
  const mode = normalizeReuseMode(reuseMode);
  const generated = normalizeOperations(generatedOperations);

  let operations = generated;
  let source = generated.length > 0 ? "generated" : "learned";
  let selectedPathId = "";
  let missReason = "";

  if (mode === "off") {
    missReason = "reuse_disabled";
  } else if (mode === "exact") {
    const matched = findBestFilterPath(memory.paths, { templateName, pageSignature });
    const exactHit = matched.path && matched.match_type === "exact";
    if (exactHit && Array.isArray(matched.path.operations) && matched.path.operations.length > 0) {
      operations = normalizeOperations(matched.path.operations);
      source = "success_path_exact";
      selectedPathId = matched.path.path_id || "";
      missReason = "";
    } else {
      missReason = matched.miss_reason || "no_exact_path";
      if (generated.length > 0) {
        source = "generated";
      } else {
        source = "learned";
        if (!missReason) {
          missReason = "no_generated_operations";
        }
      }
    }
  } else {
    const matched = findBestFilterPath(memory.paths, { templateName, pageSignature });
    if (matched.path && Array.isArray(matched.path.operations) && matched.path.operations.length > 0) {
      operations = normalizeOperations(matched.path.operations);
      source = matched.match_type === "exact" ? "success_path_exact" : "success_path_fallback";
      selectedPathId = matched.path.path_id || "";
      missReason = matched.miss_reason || "";
    } else {
      missReason = matched.miss_reason || "";
      if (generated.length > 0) {
        source = "generated";
      } else {
        source = "learned";
        if (!missReason) {
          missReason = "no_generated_operations";
        }
      }
    }
  }

  applyResolveStat(memory, source);
  memory.updated_at = nowIso();
  await saveFilterPathMemory(targetPath, memory);

  return {
    memory_path: targetPath,
    reuse_mode: mode,
    operations,
    apply_ops_source: source,
    path_reuse_miss_reason: missReason,
    selected_path_id: selectedPathId,
    observability: summarizePathReuseStats(memory)
  };
}

export async function reportApplyExecution(
  {
    templateName,
    pageSignature = "",
    operations = [],
    status = "success",
    retryCount = 0,
    selectedPathId = "",
    note = ""
  },
  memoryPath = DEFAULT_MEMORY_PATH
) {
  const { path: targetPath, memory } = await loadFilterPathMemory(memoryPath);
  const success = isSuccessStatus(status);
  const normalizedOperations = normalizeOperations(operations);
  const parsedTemplate = parseTemplateVersionName(templateName);
  const baseName = parsedTemplate.base_name || templateName || "";
  const sigHash = signatureHash(pageSignature);

  let selectedPath = selectedPathId
    ? memory.paths.find((item) => item.path_id === selectedPathId) ?? null
    : null;
  if (!selectedPath && baseName) {
    selectedPath =
      memory.paths.find(
        (item) =>
          item.template_base_name === baseName &&
          item.page_signature_hash === sigHash &&
          item.status !== "deprecated"
      ) ?? null;
  }
  if (!selectedPath && baseName) {
    selectedPath = pickBestFilterPath(memory.paths, { templateName: baseName, pageSignature: "" });
  }

  let operationsChanged = false;
  let updatedPath = selectedPath;
  let deprecated = false;

  if (success) {
    if (baseName && normalizedOperations.length > 0) {
      const upserted = upsertSuccessPath(memory, {
        templateName,
        baseName,
        operations: normalizedOperations,
        pageSignature,
        note
      });
      updatedPath = upserted.path;
      operationsChanged = upserted.changed;
    }
  } else {
    const failed = markFailureOnPath(memory, updatedPath);
    updatedPath = failed.updated_path ?? updatedPath;
    deprecated = failed.deprecated;
  }

  applyExecutionStat(memory, success, retryCount);
  memory.updated_at = nowIso();
  await saveFilterPathMemory(targetPath, memory);

  return {
    memory_path: targetPath,
    status: success ? "success" : "failed",
    selected_path_id: updatedPath?.path_id ?? "",
    selected_path_status: updatedPath?.status ?? "",
    operations_changed: operationsChanged,
    deprecated,
    observability: summarizePathReuseStats(memory)
  };
}

export async function recordSuccessfulFilterPath(
  {
    templateName,
    operations,
    pageSignature = "",
    note = ""
  },
  memoryPath = DEFAULT_MEMORY_PATH
) {
  const { path: targetPath, memory } = await loadFilterPathMemory(memoryPath);
  const parsedTemplate = parseTemplateVersionName(templateName);
  const baseName = parsedTemplate.base_name || templateName;
  if (!baseName) {
    throw new Error("recordSuccessfulFilterPath 缺少 templateName");
  }
  const normalizedOps = normalizeOperations(operations);
  if (!Array.isArray(normalizedOps) || normalizedOps.length === 0) {
    throw new Error("recordSuccessfulFilterPath 缺少 operations");
  }

  const upserted = upsertSuccessPath(memory, {
    templateName,
    baseName,
    operations: normalizedOps,
    pageSignature,
    note
  });
  applyExecutionStat(memory, true, 0);
  memory.updated_at = nowIso();
  await saveFilterPathMemory(targetPath, memory);
  return {
    memory_path: targetPath,
    best_path: upserted.path,
    observability: summarizePathReuseStats(memory)
  };
}
