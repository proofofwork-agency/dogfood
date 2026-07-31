import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { captureRepositoryState, repositoryStateChanged } from "../src/repository.mjs";
import { runCommand } from "../src/run-commands.mjs";
import { runDogfood } from "../src/run.mjs";
import { stringify as stringifyYaml } from "yaml";
import { authoritativePolicy, createProject, git, validContract } from "./helpers.mjs";

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

test("timeouts terminate a command's complete process tree", { timeout: 15000 }, async () => {
  const cwd = createProject(validContract(), {
    "writer.mjs": "import { writeFileSync } from 'node:fs'; setTimeout(() => writeFileSync('late.txt', 'escaped\\n'), 1000);\n",
    "parent.mjs": "import { spawn } from 'node:child_process'; spawn(process.execPath, ['writer.mjs'], { stdio: 'ignore' }); setInterval(() => {}, 1000);\n",
  });
  try {
    const result = await runCommand("tree", "node parent.mjs", { cwd, timeoutMs: 50 });
    assert.equal(result.status, "infra");
    assert.equal(result.timedOut, true);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(existsSync(join(cwd, "late.txt")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runner cancellation classifies started and remaining proof commands as infrastructure trouble", async () => {
  const contract = validContract({ commands: {
    proof: { run: "node -e \"setInterval(() => {}, 1000)\"", timeoutMs: 10000, adapter: "exit-code" },
    second: { run: "node check.mjs", timeoutMs: 5000, adapter: "exit-code" },
  } });
  contract.gates.verification.push("second");
  contract.oracles.second = { kind: "command", command: "second" };
  contract.acceptanceCriteria.push({ id: "AC-second", class: "deterministic", oracle: "second", severity: "major" });
  const cwd = createProject(contract);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const { report } = await runDogfood({ cwd, signal: controller.signal });
  assert.equal(report.verdict, "INFRA_ERROR", JSON.stringify(report.hardFails));
  assert.equal(report.commands.find((item) => item.name === "proof").interrupted, true);
  assert.equal(report.commands.find((item) => item.name === "second").interrupted, true);
  assert.ok(report.acceptanceCriteria.every((item) => item.verdict === "blocked"));
});

test("authoritative mode detects changed untracked files and honors only untracked allowlists", async () => {
  for (const scenario of [
    { name: "create", command: "node -e \"require('fs').writeFileSync('generated.txt','new')\"", prepare: null },
    { name: "modify", command: "node -e \"require('fs').writeFileSync('generated.txt','after')\"", prepare: "before" },
    { name: "delete", command: "node -e \"require('fs').unlinkSync('generated.txt')\"", prepare: "before" },
  ]) {
    const contract = validContract({ commands: { proof: { run: scenario.command, timeoutMs: 5000, adapter: "exit-code" } } });
    const cwd = createProject(contract);
    installPolicy(cwd, authoritativePolicy());
    if (scenario.prepare !== null) writeFileSync(join(cwd, "generated.txt"), scenario.prepare);
    const { report } = await runDogfood({ cwd, policy: ".dogfood/policy.yaml" });
    assert.equal(report.verdict, "FAIL", scenario.name);
    assert.ok(report.hardFails.some((problem) => problem.kind === "mutation" && problem.message.includes("generated.txt")), scenario.name);
  }

  const allowedContract = validContract({ commands: { proof: { run: "node -e \"require('fs').writeFileSync('generated.txt','new')\"", timeoutMs: 5000, adapter: "exit-code" } } });
  const allowed = createProject(allowedContract);
  installPolicy(allowed, authoritativePolicy({ mutation: { allowUntracked: ["artifacts/dogfood/**", "generated.txt"] } }));
  const allowedRun = await runDogfood({ cwd: allowed, policy: ".dogfood/policy.yaml" });
  assert.equal(allowedRun.report.verdict, "PASS", JSON.stringify(allowedRun.report.hardFails));

  const trackedContract = validContract({ commands: { proof: { run: "node -e \"require('fs').writeFileSync('tracked.txt','after')\"", timeoutMs: 5000, adapter: "exit-code" } } });
  const tracked = createProject(trackedContract, { "tracked.txt": "before" });
  installPolicy(tracked, authoritativePolicy({ mutation: { allowUntracked: ["artifacts/dogfood/**", "tracked.txt"] } }));
  const trackedRun = await runDogfood({ cwd: tracked, policy: ".dogfood/policy.yaml" });
  assert.equal(trackedRun.report.verdict, "FAIL");
  assert.ok(trackedRun.report.hardFails.some((problem) => problem.kind === "mutation"));
});

test("authoritative mode covers Git-root siblings, initial tracked dirtiness, and documents ignored files", async () => {
  const root = createProject();
  const packageDir = join(root, "package");
  mkdirSync(join(packageDir, ".dogfood"), { recursive: true });
  const contract = validContract({ commands: { proof: { run: "node -e \"require('fs').writeFileSync('../sibling.txt','after')\"", timeoutMs: 5000, adapter: "exit-code" } } });
  writeFileSync(join(packageDir, ".dogfood", "dogfood.contract.yaml"), stringifyYaml(contract));
  writeFileSync(join(packageDir, ".dogfood", "policy.yaml"), stringifyYaml(authoritativePolicy({ mutation: { allowUntracked: ["package/artifacts/dogfood/**"] } })));
  writeFileSync(join(root, "sibling.txt"), "before");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "nested package"]);
  const sibling = await runDogfood({ cwd: packageDir, policy: ".dogfood/policy.yaml" });
  assert.equal(sibling.report.verdict, "FAIL");
  assert.ok(sibling.report.hardFails.some((problem) => problem.message.includes("tracked repository state changed")));

  const dirty = createProject();
  installPolicy(dirty, authoritativePolicy());
  writeFileSync(join(dirty, "check.mjs"), "console.log('dirty but passing');\n");
  const dirtyRun = await runDogfood({ cwd: dirty, policy: ".dogfood/policy.yaml" });
  assert.equal(dirtyRun.report.verdict, "FAIL");
  assert.ok(dirtyRun.report.hardFails.some((problem) => problem.message.includes("started with tracked changes")));

  const ignoredContract = validContract({ commands: { proof: { run: "node -e \"require('fs').writeFileSync('ignored.txt','ignored output')\"", timeoutMs: 5000, adapter: "exit-code" } } });
  const ignored = createProject(ignoredContract, { ".gitignore": "ignored.txt\n" });
  installPolicy(ignored, authoritativePolicy());
  const ignoredRun = await runDogfood({ cwd: ignored, policy: ".dogfood/policy.yaml" });
  assert.equal(ignoredRun.report.verdict, "PASS", JSON.stringify(ignoredRun.report.hardFails));
  assert.equal(ignoredRun.report.enforcement.ignoredFilesCovered, false);
});

function installPolicy(cwd, policy) {
  writeFileSync(join(cwd, ".dogfood", "policy.yaml"), stringifyYaml(policy));
  git(cwd, ["add", ".dogfood/policy.yaml"]);
  git(cwd, ["commit", "-qm", "authoritative policy"]);
}
