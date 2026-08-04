#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Every runtime path the published tarball must carry. */
export const REQUIRED_PREFIXES = ["bin/", "src/", "schemas/", "templates/", "README.md", "LICENSE"];

/** Paths that must never ship: tests, run output, tooling, and live credentials. */
export const FORBIDDEN_PREFIXES = ["test/", "artifacts/", ".contextrelay/", "node_modules/", "scripts/", ".github/"];

/**
 * Pure contents check over package-relative paths. A required prefix is satisfied when any
 * file starts with it; a forbidden prefix is violated when any file starts with it.
 */
export function checkPackFiles(files, { required = REQUIRED_PREFIXES, forbidden = FORBIDDEN_PREFIXES } = {}) {
  const paths = normalizePaths(files);
  const violations = [];
  for (const prefix of required) {
    if (!paths.some((path) => path.startsWith(prefix))) {
      violations.push(`Missing required package path: ${prefix}`);
    }
  }
  for (const prefix of forbidden) {
    const hits = paths.filter((path) => path.startsWith(prefix));
    if (hits.length > 0) {
      violations.push(`Forbidden package path: ${prefix} (${describeHits(hits)})`);
    }
  }
  return { ok: violations.length === 0, violations };
}

export function main() {
  const result = spawnSync("npm pack --dry-run --json", {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    shell: true,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    console.error(`Could not run npm pack --dry-run --json: ${result.error.message}`);
    return 1;
  }
  if (result.status !== 0) {
    console.error(`npm pack --dry-run --json exited ${result.status}`);
    if (result.stderr) process.stderr.write(result.stderr);
    return 1;
  }

  let entries;
  try {
    entries = JSON.parse(sliceJsonArray(result.stdout));
  } catch (error) {
    console.error(`Could not parse npm pack --dry-run --json output: ${error.message}`);
    return 1;
  }
  const files = (entries?.[0]?.files ?? []).map((file) => file?.path);
  if (files.length === 0) {
    console.error("npm pack --dry-run --json reported no packaged files.");
    return 1;
  }

  const { ok, violations } = checkPackFiles(files);
  if (!ok) {
    console.error(`Package contents check failed for ${files.length} packaged files:`);
    for (const violation of violations) console.error(`  ✗ ${violation}`);
    return 1;
  }
  console.log(`Package contents OK — ${files.length} files carry every required path and no forbidden path.`);
  return 0;
}

function normalizePaths(files) {
  if (!Array.isArray(files)) return [];
  return files.filter((file) => typeof file === "string").map((file) => file.replaceAll("\\", "/").replace(/^\.\//, ""));
}

function describeHits(hits) {
  const shown = hits.slice(0, 3).join(", ");
  return hits.length > 3 ? `${shown}, +${hits.length - 3} more` : shown;
}

function sliceJsonArray(stdout) {
  const text = String(stdout || "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("npm printed no JSON array");
  return text.slice(start, end + 1);
}

const invokedPath = realPathOrNull(process.argv[1]);
const modulePath = realPathOrNull(fileURLToPath(import.meta.url));
if (invokedPath && invokedPath === modulePath) {
  process.exitCode = main();
}

function realPathOrNull(value) {
  if (!value) return null;
  try {
    return realpathSync(resolve(value));
  } catch {
    return null;
  }
}
