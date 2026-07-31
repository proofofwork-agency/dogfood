import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

export async function captureRepositoryState(cwd) {
  const rootResult = gitSmall(cwd, ["rev-parse", "--show-toplevel"]);
  if (rootResult.status !== 0) {
    return unavailable(cleanError(rootResult.stderr) || "not inside a Git working tree");
  }

  const root = rootResult.stdout.trim();
  const headResult = gitSmall(cwd, ["rev-parse", "HEAD"]);
  const [statusResult, trackedStatusResult, diffResult] = await Promise.all([
    hashGitOutput(cwd, ["status", "--porcelain=v1", "--untracked-files=normal", "--", "."]),
    hashGitOutput(cwd, ["status", "--porcelain=v1", "--untracked-files=no", "--", "."]),
    hashGitOutput(cwd, ["diff", "--binary", "--no-ext-diff", "HEAD", "--", "."]),
  ]);
  const failure = [headResult, statusResult, trackedStatusResult, diffResult]
    .find((result) => result.status !== 0);
  if (failure) {
    return unavailable(cleanError(failure.stderr) || "could not inspect Git working tree", root);
  }

  return {
    available: true,
    error: null,
    root,
    head: headResult.stdout.trim(),
    dirty: statusResult.hasOutput,
    trackedDirty: trackedStatusResult.hasOutput,
    dirtyStateDigest: statusResult.digest,
    diffDigest: diffResult.digest,
  };
}

export function repositoryStateChanged(before, after) {
  return Boolean(
    before?.available &&
      after?.available &&
      (before.head !== after.head || before.diffDigest !== after.diffDigest),
  );
}

function gitSmall(cwd, args) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}

function hashGitOutput(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
      resolve({ status: null, stderr: `${stderr}\n${error.message}`.trim(), hasOutput, digest: null });
    });
    child.on("close", (status) => {
      if (settled) return;
      settled = true;
      resolve({ status, stderr, hasOutput, digest: hash.digest("hex") });
    });
  });
}

function unavailable(error, root = null) {
  return {
    available: false,
    error,
    root,
    head: null,
    dirty: null,
    trackedDirty: null,
    dirtyStateDigest: null,
    diffDigest: null,
  };
}

function cleanError(value) {
  return String(value || "").trim().split("\n").filter(Boolean).pop() || "";
}
