import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

async function ensureParentDir(filePath) {
  await mkdir(dirname(filePath), { recursive: true });
}

export async function ensureJsonFile(filePath, defaultValue) {
  await ensureParentDir(filePath);
  try {
    await stat(filePath);
  } catch {
    const content = `${JSON.stringify(defaultValue, null, 2)}\n`;
    await writeFile(filePath, content, "utf8");
  }
}

export async function readJsonFile(filePath) {
  const content = await readFile(filePath, "utf8");
  return JSON.parse(content);
}

export async function writeJsonFile(filePath, value) {
  await ensureParentDir(filePath);
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(filePath, content, "utf8");
}

export async function appendNdjson(filePath, list) {
  await ensureParentDir(filePath);
  const lines = list.map((item) => `${JSON.stringify(item)}\n`).join("");
  await appendFile(filePath, lines, "utf8");
}
