#!/usr/bin/env node
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";

function parseArgs(rawArgs) {
  const parsed = { _: [] };
  for (let i = 0; i < rawArgs.length; i += 1) {
    const token = rawArgs[i];
    if (!token.startsWith("--")) {
      parsed._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = rawArgs[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    i += 1;
  }
  return parsed;
}

async function readJson(path) {
  const text = await readFile(path, "utf8");
  return JSON.parse(text);
}

function countTextHit(text, pattern) {
  let cursor = 0;
  let count = 0;
  while (cursor < text.length) {
    const idx = text.indexOf(pattern, cursor);
    if (idx === -1) {
      break;
    }
    count += 1;
    cursor = idx + pattern.length;
  }
  return count;
}

async function listTopLevelScripts(scriptsDir) {
  const items = await readdir(scriptsDir, { withFileTypes: true });
  return items
    .filter((item) => item.isFile() && item.name.endsWith(".js"))
    .map((item) => item.name)
    .sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function statusSummary(entries) {
  const summary = {};
  for (const entry of entries) {
    summary[entry.status] = Number(summary[entry.status] ?? 0) + 1;
  }
  return summary;
}

async function loadDocsText(paths) {
  const docs = [];
  for (const path of paths) {
    try {
      const content = await readFile(path, "utf8");
      docs.push({ path, content });
    } catch {
      docs.push({ path, content: "" });
    }
  }
  return docs;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const scriptsDir = resolve(root, "skills/maimai-recruiting-coach/scripts");
  const registryPath = resolve(scriptsDir, "script-registry.json");
  const packagePath = resolve(root, "package.json");
  const strictMode = Boolean(args.strict);
  const outputPath = args.output
    ? resolve(String(args.output))
    : resolve(root, "data/script-audit.last.json");

  const [registry, packageJson, discoveredScripts] = await Promise.all([
    readJson(registryPath),
    readJson(packagePath),
    listTopLevelScripts(scriptsDir)
  ]);

  const registryEntries = Array.isArray(registry?.scripts) ? registry.scripts : [];
  const registryNames = registryEntries.map((entry) => String(entry?.name ?? "").trim()).filter(Boolean);
  const registryNameSet = new Set(registryNames);
  const discoveredSet = new Set(discoveredScripts);
  const packageScripts = packageJson?.scripts ?? {};
  const packageScriptValues = Object.values(packageScripts).map((value) => String(value));

  const referencesDir = resolve(root, "skills/maimai-recruiting-coach/references");
  const referenceFiles = (await readdir(referencesDir))
    .filter((name) => name.endsWith(".md"))
    .map((name) => resolve(referencesDir, name));
  const docFiles = [
    resolve(root, "skills/maimai-recruiting-coach/SKILL.md"),
    ...referenceFiles
  ];
  const docs = await loadDocsText(docFiles);

  const unregisteredScripts = discoveredScripts.filter((name) => !registryNameSet.has(name));
  const missingScriptFiles = registryNames.filter((name) => !discoveredSet.has(name));

  const allowedStatuses = new Set(["active", "support", "maintenance", "deprecated"]);
  const unknownStatus = registryEntries
    .filter((entry) => !allowedStatuses.has(String(entry?.status ?? "")))
    .map((entry) => ({
      name: String(entry?.name ?? ""),
      status: String(entry?.status ?? "")
    }));
  const archivedMissingLocation = registryEntries
    .filter((entry) => ["maintenance", "deprecated"].includes(String(entry?.status ?? "")))
    .filter((entry) => !String(entry?.location ?? "").trim())
    .map((entry) => ({
      name: String(entry?.name ?? ""),
      status: String(entry?.status ?? "")
    }));

  const missingLocationFiles = [];
  for (const entry of registryEntries) {
    const location = String(entry?.location ?? "").trim();
    if (!location) {
      continue;
    }
    const locationPath = resolve(scriptsDir, location);
    try {
      await readFile(locationPath, "utf8");
    } catch {
      missingLocationFiles.push({
        name: String(entry?.name ?? ""),
        location
      });
    }
  }

  const dependencyRows = registryEntries.map((entry) => {
    const name = String(entry?.name ?? "");
    const status = String(entry?.status ?? "");
    const packageRefs = packageScriptValues.filter((scriptCmd) => scriptCmd.includes(name)).length;
    let docsRefs = 0;
    for (const doc of docs) {
      docsRefs += countTextHit(doc.content, name);
    }
    return {
      name,
      status,
      package_refs: packageRefs,
      docs_refs: docsRefs
    };
  });

  const deprecatedInPackage = dependencyRows.filter(
    (row) => row.status === "deprecated" && row.package_refs > 0
  );
  const activeNoDoc = dependencyRows.filter(
    (row) => row.status === "active" && row.docs_refs === 0
  );
  const activeNoPackage = dependencyRows.filter(
    (row) => row.status === "active" && row.package_refs === 0
  );

  const report = {
    generated_at: new Date().toISOString(),
    strict_mode: strictMode,
    summary: {
      discovered_script_count: discoveredScripts.length,
      registry_script_count: registryEntries.length,
      status_breakdown: statusSummary(registryEntries)
    },
    issues: {
      unregistered_scripts: unregisteredScripts,
      missing_script_files: missingScriptFiles,
      unknown_status: unknownStatus,
      archived_missing_location: archivedMissingLocation,
      missing_location_files: missingLocationFiles,
      deprecated_in_package: deprecatedInPackage,
      active_without_doc_ref: activeNoDoc,
      active_without_package_ref: activeNoPackage
    },
    rows: dependencyRows
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  // eslint-disable-next-line no-console
  console.log(`脚本合规检查完成: ${outputPath}`);
  // eslint-disable-next-line no-console
  console.log(
    `发现脚本 ${discoveredScripts.length} 个，登记 ${registryEntries.length} 个，未登记 ${unregisteredScripts.length} 个`
  );

  const shouldFail =
    strictMode &&
    (unregisteredScripts.length > 0 ||
      missingScriptFiles.length > 0 ||
      unknownStatus.length > 0 ||
      archivedMissingLocation.length > 0 ||
      missingLocationFiles.length > 0 ||
      deprecatedInPackage.length > 0);

  if (shouldFail) {
    throw new Error("脚本合规检查未通过：请先修复注册与停用脚本引用问题。");
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`合规检查失败: ${error.message}`);
  process.exit(1);
});

