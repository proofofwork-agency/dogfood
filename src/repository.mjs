import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { lstatSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeGitPath, portableRelative, tryRealpath } from "./files.mjs";
import { sha256, sha256File } from "./hash.mjs";

// Git hardcodes the empty tree, so it resolves even in a repository that holds no objects yet.
const EMPTY_TREE_OID = Object.freeze({
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
});
export async function captureRepositoryState(cwd, { authoritative = false } = {}) {
  const rootResult = gitSmall(cwd, ["rev-parse", "--show-toplevel"]);
  if (rootResult.status !== 0) {
    return unavailable(cleanError(rootResult.stderr) || "not inside a Git working tree");
  }

  const root = tryRealpath(normalizeGitPath(rootResult.stdout.trim()));
  const scope = authoritative ? root : tryRealpath(resolve(cwd));
  const pathspec = authoritative ? [] : ["--", "."];
  // A repository with no commit has no HEAD. That is an ordinary state, not broken infrastructure,
  // so the diff is taken against the empty tree and the run can still reach a verdict.
  const headResult = gitSmall(root, ["rev-parse", "HEAD"]);
  const unborn = headResult.status !== 0;
  if (unborn && gitSmall(root, ["rev-parse", "--git-dir"]).status !== 0) {
    return unavailable(cleanError(headResult.stderr) || "could not resolve HEAD", root);
  }
  const diffBase = unborn ? emptyTreeOid(root) : "HEAD";
  const [statusResult, trackedStatusResult, diffResult, untrackedResult] = await Promise.all([
    hashGitOutput(scope, ["status", "--porcelain=v1", "--untracked-files=normal", ...pathspec]),
    hashGitOutput(scope, ["status", "--porcelain=v1", "--untracked-files=no", ...pathspec]),
    hashGitOutput(scope, ["diff", "--binary", "--no-ext-diff", diffBase, ...pathspec]),
    gitOutput(scope, ["ls-files", "--others", "--exclude-standard", "-z", ...pathspec]),
  ]);
  const failure = [statusResult, trackedStatusResult, diffResult, untrackedResult]
    .find((result) => result.status !== 0);
  if (failure) {
    return unavailable(cleanError(failure.stderr) || "could not inspect Git working tree", root);
  }

  const untracked = {};
  for (const name of untrackedResult.stdout.split("\0").filter(Boolean).sort()) {
    const absolute = resolve(scope, name);
    const repositoryPath = portableRelative(root, absolute);
    try {
      const stat = lstatSync(absolute, { bigint: true });
      if (stat.isFile()) {
        untracked[repositoryPath] = await untrackedFileEntry(absolute, stat);
      } else if (stat.isSymbolicLink()) {
        const target = readlinkSync(absolute);
        untracked[repositoryPath] = { type: "symlink", size: Buffer.byteLength(target), digest: sha256(target) };
      }
    } catch (error) {
      // error.message carries the absolute path Node tried; the report only ever names it relatively.
      return unavailable(`could not inspect untracked path ${repositoryPath}: ${errorCode(error)}`, root);
    }
  }

  return {
    available: true,
    error: null,
    root,
    scope: portableRelative(root, scope),
    authoritative,
    head: unborn ? null : headResult.stdout.trim(),
    headState: unborn ? "unborn" : "born",
    dirty: statusResult.hasOutput,
    trackedDirty: trackedStatusResult.hasOutput,
    dirtyStateDigest: statusResult.digest,
    trackedStateDigest: trackedStatusResult.digest,
    diffDigest: diffResult.digest,
    untracked,
    ignoredFilesCovered: false,
  };
}

/**
 * The single recorded shape of a repository snapshot. Report and manifest both take this exact
 * object, so verify's report/manifest repository cross-check compares like with like, and the
 * root is workspace-relative because the absolute path of the proving machine is not evidence.
 */
export function summarizeRepository(repository, { cwd } = {}) {
  if (!repository) return null;
  return {
    available: repository.available,
    root: repository.root && cwd ? portableRelative(cwd, repository.root) : null,
    scope: repository.scope,
    authoritative: repository.authoritative,
    head: repository.head,
    headState: repository.headState ?? null,
    dirty: repository.dirty,
    trackedDirty: repository.trackedDirty,
    dirtyStateDigest: repository.dirtyStateDigest,
    trackedStateDigest: repository.trackedStateDigest,
    diffDigest: repository.diffDigest,
    untracked: repository.untracked,
    ignoredFilesCovered: false,
    error: repository.error,
  };
}

export function repositoryStateChanged(before, after) {
  return Boolean(
    before?.available &&
      after?.available &&
      (before.head !== after.head || before.diffDigest !== after.diffDigest),
  );
}

/**
 * The stable identifiers callers branch on. A mutation problem is classified by its `code`;
 * `message` is prose for humans and may be reworded without changing any verdict.
 */
export const MUTATION_PROBLEM_CODES = Object.freeze([
  "initial-tracked-dirty",
  "tracked-state-changed",
  "untracked-created",
  "untracked-removed",
  "untracked-content-changed",
  "initial-untracked-outside-allowlist",
]);

// Both producers of "the repository was already dirty" share one literal. Two copies invited a
// reword of only one of them, and the old string-matching consumers then read the survivor as
// a live mutation, failing every authoritative command run in an already-dirty repository.
const INITIAL_TRACKED_DIRTY = Object.freeze({
  code: "initial-tracked-dirty",
  message: "authoritative proof started with tracked changes anywhere in the Git repository",
});

const UNTRACKED_CHANGE_CODES = Object.freeze({
  created: "untracked-created",
  removed: "untracked-removed",
  "content-changed": "untracked-content-changed",
});

export function authoritativeRepositoryProblems(before, after, allowUntracked = []) {
  const problems = [];
  if (!before?.available || !after?.available) return problems;
  if (before.trackedDirty) {
    problems.push({ ...INITIAL_TRACKED_DIRTY });
  }
  if (before.head !== after.head || before.diffDigest !== after.diffDigest) {
    problems.push({
      code: "tracked-state-changed",
      message: "tracked repository state changed during authoritative verification",
    });
  }
  const paths = new Set([...Object.keys(before.untracked || {}), ...Object.keys(after.untracked || {})]);
  for (const path of [...paths].sort()) {
    const previous = before.untracked?.[path] || null;
    const current = after.untracked?.[path] || null;
    if (JSON.stringify(previous) === JSON.stringify(current)) continue;
    if (matchesAny(path, allowUntracked)) continue;
    const action = previous === null ? "created" : current === null ? "removed" : "content-changed";
    problems.push({
      code: UNTRACKED_CHANGE_CODES[action],
      message: `non-ignored untracked file ${action} during authoritative verification: ${path}`,
    });
  }
  return problems;
}

export function authoritativeInitialProblems(snapshot, allowUntracked = []) {
  const problems = [];
  if (!snapshot?.available) return problems;
  if (snapshot.trackedDirty) {
    problems.push({ ...INITIAL_TRACKED_DIRTY });
  }
  for (const path of Object.keys(snapshot.untracked || {}).sort()) {
    if (!matchesAny(path, allowUntracked)) {
      problems.push({
        code: "initial-untracked-outside-allowlist",
        message: `authoritative proof started with a non-ignored untracked file outside the allowlist: ${path}`,
      });
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

function emptyTreeOid(root) {
  const format = gitSmall(root, ["rev-parse", "--show-object-format"]);
  return format.status === 0 && format.stdout.trim() === "sha256"
    ? EMPTY_TREE_OID.sha256
    : EMPTY_TREE_OID.sha1;
}

// Stable file identity and metadata for the lifetime of one run. ctime cannot be restored with
// ordinary utimes calls, so a same-size rewrite with a restored mtime cannot reuse an old digest.
const untrackedDigests = new Map();
const MAX_UNTRACKED_DIGEST_ENTRIES = 50_000;

/** Drop the memoized digests; a long-lived host process should start each run with a cold cache. */
export function resetUntrackedDigestCache() {
  untrackedDigests.clear();
}

async function untrackedFileEntry(path, stat) {
  const size = Number(stat.size);
  const key = `${path}\0${stat.dev}\0${stat.ino}\0${size}\0${stat.mtimeNs}\0${stat.ctimeNs}`;
  const memoized = untrackedDigests.get(key);
  if (memoized) return { type: "file", size, digest: memoized };
  // Hash every file, regardless of size. sha256File streams, so this closes the old >8 MiB
  // same-size blind spot without retaining the file in memory.
  const digest = await sha256File(path);
  if (untrackedDigests.size >= MAX_UNTRACKED_DIGEST_ENTRIES) untrackedDigests.clear();
  untrackedDigests.set(key, digest);
  return { type: "file", size, digest };
}

function errorCode(error) {
  return error?.code || error?.name || "Error";
}

function unavailable(error, root = null) {
  return {
    available: false,
    error,
    root,
    scope: null,
    authoritative: null,
    head: null,
    headState: null,
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

