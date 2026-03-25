import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEFAULT_RUNTIME_CONFIG_PATH = resolve("data/maimai-runtime-config.json");

function normalizeText(value) {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim();
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function looksLikeBitableUrl(value) {
  const text = normalizeText(value);
  if (!text) {
    return false;
  }
  return /^https?:\/\/[^/\s]+\/base\/[^?\s]+.*\btable=tbl/i.test(text);
}

export function getRuntimeConfigPath(inputPath = "") {
  const text = normalizeText(inputPath);
  if (text) {
    return resolve(text);
  }
  return DEFAULT_RUNTIME_CONFIG_PATH;
}

export async function readRuntimeConfig(inputPath = "") {
  const configPath = getRuntimeConfigPath(inputPath);
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!isObject(parsed)) {
      return {
        configPath,
        config: {}
      };
    }
    return {
      configPath,
      config: parsed
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {
        configPath,
        config: {}
      };
    }
    throw error;
  }
}

export async function mergeRuntimeConfig(patch = {}, inputPath = "") {
  const { configPath, config } = await readRuntimeConfig(inputPath);
  const next = { ...config };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    next[key] = value;
  }
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return {
    configPath,
    config: next
  };
}

export function pickFirstNonEmpty(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) {
      return text;
    }
  }
  return "";
}

export function extractBitableUrlFromFields(fields = {}, options = {}) {
  if (!isObject(fields)) {
    return "";
  }
  const preferredKeys = Array.isArray(options.preferredKeys) ? options.preferredKeys : [];
  for (const key of preferredKeys) {
    const value = fields[key];
    const text = normalizeText(value);
    if (looksLikeBitableUrl(text)) {
      return text;
    }
  }
  const keyHints = Array.isArray(options.keyHints)
    ? options.keyHints.map((item) => normalizeText(item).toLowerCase()).filter(Boolean)
    : [];
  for (const [key, value] of Object.entries(fields)) {
    const text = normalizeText(value);
    if (!looksLikeBitableUrl(text)) {
      continue;
    }
    if (keyHints.length === 0) {
      return text;
    }
    const lowered = normalizeText(key).toLowerCase();
    if (keyHints.some((hint) => lowered.includes(hint))) {
      return text;
    }
  }
  return "";
}

export function sanitizeConfigPatch(input = {}) {
  const patch = {};
  const filterBaseUrl = normalizeText(input.filter_base_url);
  const candidateBaseUrl = normalizeText(input.candidate_base_url);
  const maimaiListUrl = normalizeText(input.maimai_list_url);
  const storageStatePath = normalizeText(input.storage_state_path);
  const browserProfileDir = normalizeText(input.browser_profile_dir);
  const onlineSelectorMap = normalizeText(input.online_selector_map);
  const onlineCandidateSelectorMap = normalizeText(input.online_candidate_selector_map);
  const onlineCaptureSelectors = normalizeText(input.online_capture_selectors);
  const executionMode = normalizeText(input.execution_mode).toLowerCase();
  if (looksLikeBitableUrl(filterBaseUrl)) {
    patch.filter_base_url = filterBaseUrl;
  }
  if (looksLikeBitableUrl(candidateBaseUrl)) {
    patch.candidate_base_url = candidateBaseUrl;
  }
  if (maimaiListUrl) {
    patch.maimai_list_url = maimaiListUrl;
  }
  if (storageStatePath) {
    patch.storage_state_path = storageStatePath;
  }
  if (browserProfileDir) {
    patch.browser_profile_dir = browserProfileDir;
  }
  if (onlineSelectorMap) {
    patch.online_selector_map = onlineSelectorMap;
  }
  if (onlineCandidateSelectorMap) {
    patch.online_candidate_selector_map = onlineCandidateSelectorMap;
  }
  if (onlineCaptureSelectors) {
    patch.online_capture_selectors = onlineCaptureSelectors;
  }
  if (["offline", "online", "realtime"].includes(executionMode)) {
    patch.execution_mode = executionMode;
  }
  return patch;
}
