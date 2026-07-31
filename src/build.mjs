import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { isPathInside, portableRelative } from "./files.mjs";

export function inspectBuildSubject(cwd, definition) {
  if (!definition) return { subject: null, error: null };
  if (definition.algorithm !== "sha256") return { subject: null, error: `unsupported build subject algorithm: ${definition.algorithm}` };
  const workspace = realpathSync(cwd);
  const candidate = resolve(cwd, definition.path);
  if (!existsSync(candidate)) return { subject: null, error: `build subject does not exist: ${definition.path}` };
  let real;
  try {
    if (lstatSync(candidate).isSymbolicLink()) return { subject: null, error: `build subject must be a regular file, not a symbolic link: ${definition.path}` };
    real = realpathSync(candidate);
  } catch (error) {
    return { subject: null, error: `could not inspect build subject ${definition.path}: ${error.message}` };
  }
  if (!isPathInside(workspace, real)) {
    return { subject: null, error: `build subject escapes the workspace: ${definition.path}` };
  }
  const stat = statSync(real);
  if (!stat.isFile()) return { subject: null, error: `build subject is not a regular file: ${definition.path}` };
  return {
    subject: {
      path: portableRelative(workspace, real),
      algorithm: "sha256",
      digest: sha256(readFileSync(real)),
      size: stat.size,
    },
    error: null,
  };
}

export function collectRuntimeMetadata(cwd, repositoryRoot = cwd) {
  const lockfiles = {};
  for (const directory of new Set([repositoryRoot || cwd, cwd])) {
    for (const name of ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]) {
      const path = join(directory, name);
      if (!existsSync(path) || !statSync(path).isFile()) continue;
      const value = readFileSync(path);
      const key = relative(repositoryRoot || cwd, path).split(sep).join("/") || name;
      lockfiles[key] = { algorithm: "sha256", digest: sha256(value), size: value.length };
    }
  }
  const playwrightPackage = packageVersion(join(cwd, "node_modules", "@playwright", "test", "package.json")) ||
    packageVersion(join(cwd, "node_modules", "playwright", "package.json")) ||
    packageVersion(join(repositoryRoot || cwd, "node_modules", "@playwright", "test", "package.json"));
  return {
    gitVersion: commandVersion(cwd, "git", ["--version"]),
    npmVersion: commandVersion(cwd, "npm", ["--version"]),
    playwrightVersion: playwrightPackage,
    browserVersions: playwrightPackage ? { source: "Playwright package", chromium: "managed by Playwright; exact executable metadata unavailable" } : null,
    lockfiles,
  };
}

function commandVersion(cwd, command, args) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 5000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

function packageVersion(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8")).version || null;
  } catch {
    return null;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
