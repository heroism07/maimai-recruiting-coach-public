import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createEmptyMemoryStore } from "./schemas.js";

async function ensureParentDir(filePath) {
  await mkdir(dirname(filePath), { recursive: true });
}

export async function ensureFile(filePath, defaultContent) {
  await ensureParentDir(filePath);
  try {
    await stat(filePath);
  } catch {
    await writeFile(filePath, defaultContent, "utf8");
  }
}

export async function ensureDataFiles(memoryPath, runsPath) {
  const memoryContent = `${JSON.stringify(createEmptyMemoryStore(), null, 2)}\n`;
  await ensureFile(memoryPath, memoryContent);
  await ensureFile(runsPath, "");
}

export async function loadMemory(memoryPath) {
  const raw = await readFile(memoryPath, "utf8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed.workflows)) {
    throw new Error("流程记忆库格式错误：缺少 workflows 数组。");
  }
  return parsed;
}

export async function saveMemory(memoryPath, memory) {
  await ensureParentDir(memoryPath);
  const tmpPath = `${memoryPath}.tmp`;
  const content = `${JSON.stringify(memory, null, 2)}\n`;
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, memoryPath);
}

export async function appendRunLog(runsPath, runEntry) {
  await ensureParentDir(runsPath);
  const line = `${JSON.stringify(runEntry)}\n`;
  await appendFile(runsPath, line, "utf8");
}
