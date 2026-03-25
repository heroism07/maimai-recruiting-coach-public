import { createHash, randomUUID } from "node:crypto";

export function isoNow() {
  return new Date().toISOString();
}

export function makeRunId() {
  return randomUUID();
}

export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashObject(value) {
  return createHash("sha1").update(stableStringify(value)).digest("hex");
}

export function buildWorkflowId(jobFamily, taskType, pageSignature) {
  const key = `${jobFamily}:${taskType}:${hashObject(pageSignature).slice(0, 10)}`;
  return key
    .toLowerCase()
    .replace(/[^a-z0-9:]+/g, "-")
    .replace(/-+/g, "-");
}

export function sleep(ms) {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function wildcardToRegExp(input) {
  const escaped = input.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}
