import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { captureRepositoryState, repositoryStateChanged } from "../src/repository.mjs";
import { runCommand } from "../src/run-commands.mjs";
import { createProject, git } from "./helpers.mjs";

test("untracked workspace changes are recorded but intentionally do not trip tracked mutation", async () => {
  const cwd = createProject();
  try {
    const before = await captureRepositoryState(cwd);
    writeFileSync(join(cwd, "untracked-output.txt"), "generated\n", "utf8");
    const after = await captureRepositoryState(cwd);
    assert.equal(before.dirty, false);
    assert.equal(after.dirty, true);
    assert.notEqual(before.dirtyStateDigest, after.dirtyStateDigest);
    assert.equal(repositoryStateChanged(before, after), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test(
  "large tracked diffs are hashed without a maxBuffer infrastructure failure",
  { timeout: 30000 },
  async () => {
    const cwd = createProject();
    try {
      const path = join(cwd, "large.txt");
      writeFileSync(path, "a".repeat(10_600_000), "utf8");
      git(cwd, ["add", "large.txt"]);
      git(cwd, ["commit", "-qm", "large baseline"]);
      writeFileSync(path, "b".repeat(10_600_000), "utf8");
      const first = await captureRepositoryState(cwd);
      assert.equal(first.available, true, first.error);
      assert.equal(first.trackedDirty, true);
      writeFileSync(path, "c".repeat(10_600_000), "utf8");
      const second = await captureRepositoryState(cwd);
      assert.equal(second.available, true, second.error);
      assert.notEqual(first.diffDigest, second.diffDigest);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);

test("large UTF-8 logs retain a byte-bounded, valid tail", { timeout: 15000 }, async () => {
  const cwd = createProject();
  try {
    const result = await runCommand(
      "utf8-log",
      `node -e "process.stdout.write('😀'.repeat(1400000) + 'x')"`,
      { cwd, timeoutMs: 10000 },
    );
    assert.equal(result.status, "pass");
    assert.equal(result.stdoutTruncated, true);
    assert.ok(Buffer.byteLength(result.stdout) <= 5 * 1024 * 1024);
    assert.equal(result.stdout.startsWith("�"), false);
    assert.equal(result.stdout.endsWith("x"), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
