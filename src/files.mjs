import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  fsyncSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  closeSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

// Temp files that exist on disk but have not been renamed or removed yet.
const pendingTemps = new Set();

/**
 * Write through a temp sibling so a reader never sees a half-written artifact, and fsync before
 * the rename so a crash cannot leave a named-but-empty file. The mode is left to the umask: a
 * bundle is evidence to be collected, and 0600 locks out CI collectors running as another user.
 */
export function atomicWriteFile(path, value, encoding = undefined, { mode } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor;
  pendingTemps.add(temporary);
  try {
    descriptor = mode === undefined ? openSync(temporary, "wx") : openSync(temporary, "wx", mode);
    writeFileSync(descriptor, value, encoding);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    pendingTemps.delete(temporary);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    pendingTemps.delete(temporary);
    throw error;
  }
}

export function atomicWriteJson(path, value) {
  atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Remove still-pending temp files under root; a non-empty result means a writer leaked one. */
export function sweepPendingTemps(root) {
  const swept = [];
  for (const temporary of pendingTemps) {
    if (!isPathInside(root, temporary)) continue;
    rmSync(temporary, { force: true });
    pendingTemps.delete(temporary);
    swept.push(temporary);
  }
  return swept;
}

/** Convert Git-for-Windows / MSYS absolute paths into Node-usable paths. */
export function normalizeGitPath(value) {
  const trimmed = String(value || "").trim().replaceAll("\\", "/");
  // /c/Users/... or //c/Users/... (MSYS style from some Git builds)
  const msys = trimmed.match(/^\/{1,2}([A-Za-z])\/(.*)$/);
  if (process.platform === "win32" && msys) {
    return `${msys[1].toUpperCase()}:/${msys[2]}`;
  }
  return trimmed;
}

/** Resolve to the canonical absolute path when possible (expands Windows 8.3 names). */
export function tryRealpath(path) {
  const normalized = normalizeGitPath(path);
  let resolved;
  try {
    resolved = typeof realpathSync.native === "function"
      ? realpathSync.native(normalized)
      : realpathSync(normalized);
  } catch {
    try {
      resolved = realpathSync(normalized);
    } catch {
      resolved = resolve(normalized);
    }
  }
  return expandWindowsShortPath(stripLongPathPrefix(resolved));
}

/**
 * True when candidate is the root directory or a descendant after realpath.
 * Handles Windows drive-letter case, 8.3 short names, and slash differences.
 */
export function isPathInside(root, candidate) {
  try {
    return pathRelation(tryRealpath(root), tryRealpath(candidate)) !== "outside";
  } catch {
    return false;
  }
}

/**
 * Relative path with forward slashes. Prefers realpath; on Windows falls back to
 * case-insensitive containment when Node's relative() treats equal roots as foreign.
 */
export function portableRelative(from, to) {
  const fromResolved = tryRealpath(from);
  const toResolved = tryRealpath(to);
  const relation = pathRelation(fromResolved, toResolved);
  if (relation === "same") return ".";
  if (relation === "inside") {
    const fromSlash = stripLongPathPrefix(fromResolved).replaceAll("\\", "/");
    const toSlash = stripLongPathPrefix(toResolved).replaceAll("\\", "/");
    // Length can differ when one side was short-name expanded; recompute via comparable prefix.
    const fromCmp = normalizeComparable(fromResolved);
    const toCmp = normalizeComparable(toResolved);
    if (toCmp === fromCmp) return ".";
    if (toCmp.startsWith(`${fromCmp}/`)) {
      // Preserve the casing of the expanded long path by slicing the comparable lengths.
      const expanded = toSlash;
      // Find the relative tail using case-insensitive prefix length of path segments.
      const fromParts = fromCmp.split("/").filter(Boolean);
      const toParts = toSlash.split("/").filter(Boolean);
      // Drive letter is first segment on Windows (e.g. "c:"); match segment count.
      return toParts.slice(fromParts.length).join("/") || ".";
    }
    return toSlash.slice(fromSlash.length).replace(/^\/+/, "") || ".";
  }
  const rel = relative(fromResolved, toResolved);
  if (rel === "") return ".";
  return rel.split(sep).join("/") || ".";
}

/** Expand 8.3 short path names (e.g. RUNNER~1 → runneradmin) on Windows. */
function expandWindowsShortPath(path) {
  if (process.platform !== "win32") return path;
  const value = String(path);
  if (!value.includes("~")) return value;
  // Prefer PowerShell FullName; falls back to the input when unavailable.
  const escaped = value.replaceAll("'", "''");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `(Get-Item -LiteralPath '${escaped}').FullName`],
    { encoding: "utf8", windowsHide: true },
  );
  const expanded = String(result.stdout || "").trim();
  return result.status === 0 && expanded ? expanded : value;
}

function pathRelation(root, candidate) {
  const a = normalizeComparable(root);
  const b = normalizeComparable(candidate);
  if (b === a) return "same";
  if (b.startsWith(`${a}/`)) return "inside";
  return "outside";
}

function normalizeComparable(path) {
  let normalized = stripLongPathPrefix(path).replaceAll("\\", "/");
  if (process.platform === "win32") normalized = normalized.toLowerCase();
  if (normalized.length > 3 && normalized.endsWith("/")) {
    normalized = normalized.replace(/\/+$/, "");
  }
  return normalized;
}

function stripLongPathPrefix(path) {
  const value = String(path);
  if (value.startsWith("\\\\?\\")) return value.slice(4);
  if (value.startsWith("//?/")) return value.slice(4);
  return value;
}
