import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, lstatSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeGitPath, portableRelative, tryRealpath } from "./files.mjs";

export async function captureRepositoryState(cwd, { authoritative = false } = {}) {
  const rootResult = gitSmall(cwd, ["rev-parse", "--show-toplevel"]);
  if (rootResult.status !== 0) {
    return unavailable(cleanError(rootResult.stderr) || "not inside a Git working tree");
  }

  const root = tryRealpath(normalizeGitPath(rootResult.stdout.trim()));
  const scope = authoritative ? root : tryRealpath(resolve(cwd));
  const pathspec = authoritative ? [] : ["--", "."];
  const headResult = gitSmall(root, ["rev-parse", "HEAD"]);
  const [statusResult, trackedStatusResult, diffResult, untrackedResult] = await Promise.all([
    hashGitOutput(scope, ["status", "--porcelain=v1", "--untracked-files=normal", ...pathspec]),
    hashGitOutput(scope, ["status", "--porcelain=v1", "--untracked-files=no", ...pathspec]),
    hashGitOutput(scope, ["diff", "--binary", "--no-ext-diff", "HEAD", ...pathspec]),
    gitOutput(scope, ["ls-files", "--others", "--exclude-standard", "-z", ...pathspec]),
  ]);
  const failure = [headResult, statusResult, trackedStatusResult, diffResult, untrackedResult]
    .find((result) => result.status !== 0);
  if (failure) {
    return unavailable(cleanError(failure.stderr) || "could not inspect Git working tree", root);
  }

  const untracked = {};
  for (const name of untrackedResult.stdout.split("\0").filter(Boolean).sort()) {
    const absolute = resolve(scope, name);
    const repositoryPath = portableRelative(root, absolute);
    try {
      const stat = lstatSync(absolute);
      if (stat.isFile()) {
        untracked[repositoryPath] = { type: "file", size: stat.size, digest: await sha256File(absolute) };
      } else if (stat.isSymbolicLink()) {
        const target = readlinkSync(absolute);
        untracked[repositoryPath] = { type: "symlink", size: Buffer.byteLength(target), digest: sha256(target) };
      }
    } catch (error) {
      return unavailable(`could not inspect untracked path ${repositoryPath}: ${error.message}`, root);
    }
  }

  return {
    available: true,
    error: null,
    root,
    scope: portableRelative(root, scope),
    authoritative,
    head: headResult.stdout.trim(),
    dirty: statusResult.hasOutput,
    trackedDirty: trackedStatusResult.hasOutput,
    dirtyStateDigest: statusResult.digest,
    trackedStateDigest: trackedStatusResult.digest,
    diffDigest: diffResult.digest,
    untracked,
    ignoredFilesCovered: false,
  };
}

export function repositoryStateChanged(before, after) {
  return Boolean(
    before?.available &&
      after?.available &&
      (before.head !== after.head || before.diffDigest !== after.diffDigest),
  );
}

export function authoritativeRepositoryProblems(before, after, allowUntracked = []) {
  const problems = [];
  if (!before?.available || !after?.available) return problems;
  if (before.trackedDirty) {
    problems.push("authoritative proof started with tracked changes anywhere in the Git repository");
  }
  if (before.head !== after.head || before.diffDigest !== after.diffDigest) {
    problems.push("tracked repository state changed during authoritative verification");
  }
  const paths = new Set([...Object.keys(before.untracked || {}), ...Object.keys(after.untracked || {})]);
  for (const path of [...paths].sort()) {
    const previous = before.untracked?.[path] || null;
    const current = after.untracked?.[path] || null;
    if (JSON.stringify(previous) === JSON.stringify(current)) continue;
    if (matchesAny(path, allowUntracked)) continue;
    const action = previous === null ? "created" : current === null ? "removed" : "content-changed";
    problems.push(`non-ignored untracked file ${action} during authoritative verification: ${path}`);
  }
  return problems;
}

export function authoritativeInitialProblems(snapshot, allowUntracked = []) {
  const problems = [];
  if (!snapshot?.available) return problems;
  if (snapshot.trackedDirty) {
    problems.push("authoritative proof started with tracked changes anywhere in the Git repository");
  }
  for (const path of Object.keys(snapshot.untracked || {}).sort()) {
    if (!matchesAny(path, allowUntracked)) {
      problems.push(`authoritative proof started with a non-ignored untracked file outside the allowlist: ${path}`);
    }
  }
  return problems;
}

export function matchesAny(path, patterns) {
  const normalized = String(path).replaceAll("\\", "/");
  return patterns.some((pattern) => globToRegExp(String(pattern).replaceAll("\\", "/")).test(normalized));
}

function globToRegExp(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index++;
        if (pattern[index + 1] === "/") {
          index++;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function gitSmall(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 });
}

function hashGitOutput(cwd, args) {
  return new Promise((resolvePromise) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const hash = createHash("sha256");
    let hasOutput = false;
    let stderr = "";
    let settled = false;
    child.stdout.on("data", (chunk) => {
      hasOutput ||= chunk.length > 0;
      hash.update(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 65536) stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      resolvePromise({ status: null, stderr: `${stderr}\n${error.message}`.trim(), hasOutput, digest: null });
    });
    child.on("close", (status) => {
      if (settled) return;
      settled = true;
      resolvePromise({ status, stderr, hasOutput, digest: hash.digest("hex") });
    });
  });
}

function gitOutput(cwd, args) {
  return new Promise((resolvePromise) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 65536) stderr += chunk.toString();
    });
    child.on("error", (error) => resolvePromise({ status: null, stderr: `${stderr}\n${error.message}`.trim(), stdout: "" }));
    child.on("close", (status) => resolvePromise({ status, stderr, stdout: Buffer.concat(chunks).toString("utf8") }));
  });
}

function unavailable(error, root = null) {
  return {
    available: false,
    error,
    root,
    scope: null,
    authoritative: null,
    head: null,
    dirty: null,
    trackedDirty: null,
    dirtyStateDigest: null,
    trackedStateDigest: null,
    diffDigest: null,
    untracked: {},
    ignoredFilesCovered: false,
  };
}

function cleanError(value) {
  return String(value || "").trim().split("\n").filter(Boolean).pop() || "";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}
