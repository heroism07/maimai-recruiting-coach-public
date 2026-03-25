#!/usr/bin/env node

const allowDeprecated = process.argv.includes("--allow-deprecated");

if (!allowDeprecated) {
  // eslint-disable-next-line no-console
  console.error(
    [
      "该脚本已废弃：migrate-filter-table-schema.js",
      "请改用：",
      "1) node skills/maimai-recruiting-coach/scripts/upgrade-filter-table-v2.js ...",
      "2) node skills/maimai-recruiting-coach/scripts/prune-filter-table-fields.js ...",
      "若确需强制执行历史脚本，请显式追加参数 --allow-deprecated。"
    ].join("\n")
  );
  process.exit(1);
}

await import("./legacy/migrate-filter-table-schema.js");
