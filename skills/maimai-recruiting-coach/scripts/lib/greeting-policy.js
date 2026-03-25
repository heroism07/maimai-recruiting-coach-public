const NORMALIZED_WRITE_POLICIES = new Map([
  ["empty_only", "empty_only"],
  ["empty-only", "empty_only"],
  ["if_empty", "empty_only"],
  ["if-empty", "empty_only"],
  ["overwrite", "overwrite"],
  ["always", "overwrite"]
]);

export function resolveGreetingWritePolicy(rawPolicy, overwriteFlag = false) {
  const text = String(rawPolicy ?? "")
    .trim()
    .toLowerCase();

  if (!text) {
    return overwriteFlag ? "overwrite" : "empty_only";
  }

  const normalized = NORMALIZED_WRITE_POLICIES.get(text);
  if (!normalized) {
    throw new Error("greeting-write-policy 仅支持 empty_only 或 overwrite");
  }
  return normalized;
}

