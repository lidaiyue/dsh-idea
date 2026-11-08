import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export const MAX_FILES = 8000;
export const MAX_SOURCE_BYTES = 800 * 1024;

export const SKIP = {
  node_modules: 1, ".git": 1, dist: 1, "dist-ssr": 1, ".next": 1, ".nuxt": 1,
  ".turbo": 1, ".cache": 1, build: 1, out: 1, target: 1, vendor: 1,
  __pycache__: 1, ".venv": 1, venv: 1, coverage: 1, ".pnpm-store": 1,
  ".output": 1, ".svelte-kit": 1, logs: 1, ".idea": 1, ".vscode": 1,
  ".DS_Store": 1, tmp: 1, temp: 1, ".gradle": 1, ".mvn": 1
};

export function basenameOf(path) {
  const trimmed = String(path).replace(/[/\\]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut < 0 ? trimmed : trimmed.slice(cut + 1);
}

export function pathWithin(root, path) {
  try {
    const rel = relative(root, path);
    if (rel === "") return ".";
    if (rel === ".." || rel.startsWith(".." + "/") || rel.startsWith(".." + "\\")) return String(path);
    return rel.split("\\").join("/");
  } catch {
    return String(path);
  }
}

/**
 * Walk `absDir` into `files`, skipping `SKIP` names, capped at `MAX_FILES`.
 */
export async function walk(absDir, relDir, files) {
  if (files.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.length >= MAX_FILES) return;
    if (!entry || typeof entry.name !== "string") continue;
    if (SKIP[entry.name] === 1) continue;
    const rel = relDir === "" ? entry.name : relDir + "/" + entry.name;
    const abs = join(absDir, entry.name);
    if (entry.isDirectory()) await walk(abs, rel, files);
    else if (entry.isFile()) files.push({ path: abs, rel, name: entry.name });
  }
}
