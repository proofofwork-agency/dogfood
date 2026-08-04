import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  authoritativeInitialProblems,
  authoritativeRepositoryProblems,
  captureRepositoryState,
  MUTATION_PROBLEM_CODES,
  repositoryStateChanged,
} from "../src/repository.mjs";
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

test("timeout settlement is bounded when a detached grandchild retains the stdio pipes", { skip: process.platform === "win32", timeout: 10000 }, async () => {
  const cwd = createProject(validContract(), {
    "detached-parent.mjs": [
      "import { spawn } from 'node:child_process';",
      "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  });
  try {
    const result = await runCommand("detached", "node detached-parent.mjs", { cwd, timeoutMs: 50 });
    assert.equal(result.status, "infra");
    assert.equal(result.timedOut, true);
    assert.ok(result.durationMs < 3500, `timeout settled after ${result.durationMs}ms`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("authoritative snapshots hash large untracked files and detect same-size rewrites with restored mtime", { timeout: 15000 }, async () => {
  const cwd = createProject();
  const path = join(cwd, "large-untracked.bin");
  try {
    writeFileSync(path, Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
    const beforeStat = statSync(path);
    const before = await captureRepositoryState(cwd, { authoritative: true });
    writeFileSync(path, Buffer.alloc(8 * 1024 * 1024 + 1, 0x62));
    utimesSync(path, beforeStat.atime, beforeStat.mtime);
    const after = await captureRepositoryState(cwd, { authoritative: true });
    const problems = authoritativeRepositoryProblems(before, after);
    assert.ok(
      problems.some((problem) => problem.code === "untracked-content-changed"),
      JSON.stringify({ before: before.untracked, after: after.untracked, problems }),
    );
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
  assert.ok(dirtyRun.report.hardFails.some((problem) => problem.kind === "mutation" && problem.code === "initial-tracked-dirty"));

  const ignoredContract = validContract({ commands: { proof: { run: "node -e \"require('fs').writeFileSync('ignored.txt','ignored output')\"", timeoutMs: 5000, adapter: "exit-code" } } });
  const ignored = createProject(ignoredContract, { ".gitignore": "ignored.txt\n" });
  installPolicy(ignored, authoritativePolicy());
  const ignoredRun = await runDogfood({ cwd: ignored, policy: ".dogfood/policy.yaml" });
  assert.equal(ignoredRun.report.verdict, "PASS", JSON.stringify(ignoredRun.report.hardFails));
  assert.equal(ignoredRun.report.enforcement.ignoredFilesCovered, false);
});

test("every authoritative mutation problem is classified by a declared code, not by its prose", () => {
  const snapshot = (overrides = {}) => ({
    available: true,
    trackedDirty: false,
    head: "0000000000000000000000000000000000000000",
    diffDigest: "digest",
    untracked: {},
    ...overrides,
  });

  const changed = authoritativeRepositoryProblems(
    snapshot({
      trackedDirty: true,
      untracked: { "gone.txt": { digest: "2" }, "kept.txt": { digest: "1" }, "same.txt": { digest: "3" } },
    }),
    snapshot({
      trackedDirty: true,
      diffDigest: "other",
      untracked: { "kept.txt": { digest: "9" }, "made.txt": { digest: "4" }, "same.txt": { digest: "3" } },
    }),
  );
  assert.deepEqual(changed.map((problem) => problem.code), [
    "initial-tracked-dirty",
    "tracked-state-changed",
    "untracked-removed",
    "untracked-content-changed",
    "untracked-created",
  ]);
  assert.equal(changed[0].message, "authoritative proof started with tracked changes anywhere in the Git repository");
  assert.equal(changed[1].message, "tracked repository state changed during authoritative verification");
  assert.equal(changed[2].message, "non-ignored untracked file removed during authoritative verification: gone.txt");
  assert.equal(changed[3].message, "non-ignored untracked file content-changed during authoritative verification: kept.txt");
  assert.equal(changed[4].message, "non-ignored untracked file created during authoritative verification: made.txt");

  // The allowlist suppresses the whole problem, not merely its message.
  assert.deepEqual(
    authoritativeRepositoryProblems(
      snapshot(),
      snapshot({ untracked: { "artifacts/dogfood/run/summary.json": { digest: "1" } } }),
      ["artifacts/dogfood/**"],
    ),
    [],
  );

  assert.deepEqual(
    authoritativeInitialProblems(
      snapshot({ trackedDirty: true, untracked: { "artifacts/dogfood/run/x": { digest: "2" }, "stray.txt": { digest: "1" } } }),
      ["artifacts/dogfood/**"],
    ),
    [
      { code: "initial-tracked-dirty", message: "authoritative proof started with tracked changes anywhere in the Git repository" },
      { code: "initial-untracked-outside-allowlist", message: "authoritative proof started with a non-ignored untracked file outside the allowlist: stray.txt" },
    ],
  );

  const produced = new Set([...changed, ...authoritativeInitialProblems(snapshot({ trackedDirty: true, untracked: { "stray.txt": { digest: "1" } } }))].map((problem) => problem.code));
  assert.deepEqual([...produced].sort(), [...MUTATION_PROBLEM_CODES].sort());
});

test("mutation problems carry stable codes that separate an already-dirty repository from a mutating command", async () => {
  const mutatingContract = validContract({ commands: { proof: { run: "node -e \"require('fs').writeFileSync('tracked.txt','after')\"", timeoutMs: 5000, adapter: "exit-code" } } });
  const mutating = createProject(mutatingContract, { "tracked.txt": "before" });
  installPolicy(mutating, authoritativePolicy());
  const mutatingRun = await runDogfood({ cwd: mutating, policy: ".dogfood/policy.yaml" });
  const mutatingProof = mutatingRun.report.commands.find((command) => command.name === "proof");
  assert.equal(mutatingRun.report.verdict, "FAIL");
  assert.equal(mutatingProof.mutationDetected, true);
  assert.deepEqual(mutatingProof.mutationProblems, [{
    code: "tracked-state-changed",
    message: "tracked repository state changed during authoritative verification",
  }]);
  assert.ok(mutatingRun.report.hardFails.some((problem) => problem.kind === "mutation" && problem.code === "tracked-state-changed"));
  assert.ok(mutatingRun.report.hardFails.every((problem) => problem.code !== "initial-tracked-dirty"));

  // The repository was dirty before anything ran, so the run fails — but no command wrote
  // anything, and charging each command with the pre-existing dirtiness would be a false accusation.
  const dirty = createProject();
  installPolicy(dirty, authoritativePolicy());
  writeFileSync(join(dirty, "check.mjs"), "console.log('dirty but passing');\n");
  const dirtyRun = await runDogfood({ cwd: dirty, policy: ".dogfood/policy.yaml" });
  const dirtyProof = dirtyRun.report.commands.find((command) => command.name === "proof");
  assert.equal(dirtyRun.report.verdict, "FAIL");
  assert.equal(dirtyProof.status, "pass");
  assert.equal(dirtyProof.mutationDetected, false);
  assert.deepEqual(dirtyProof.mutationProblems, [{
    code: "initial-tracked-dirty",
    message: "authoritative proof started with tracked changes anywhere in the Git repository",
  }]);
  assert.deepEqual(
    dirtyRun.report.hardFails.map((problem) => problem.code),
    ["initial-tracked-dirty"],
    JSON.stringify(dirtyRun.report.hardFails),
  );
  assert.ok(dirtyRun.report.commands.every((command) => command.mutationDetected === false));
});

test("a rejected --evidence receipt is reported as an input failure and validate mode never collects one", async () => {
  const contract = validContract();
  contract.oracles.review = { kind: "advisory" };
  contract.acceptanceCriteria.push({ id: "AC-usability", class: "judgmental", oracle: "review", severity: "minor" });
  const cwd = createProject(contract, {
    "reviews/receipt.json": JSON.stringify({
      version: 1,
      acId: "AC-never-declared",
      actor: "human reviewer",
      driver: "browser-review",
      assessment: "satisfied",
      summary: "points at a criterion this contract does not declare",
      artifacts: [],
    }),
  });

  const { report } = await runDogfood({ cwd, evidence: ["reviews/receipt.json"] });
  assert.equal(report.verdict, "FAIL");
  assert.deepEqual(report.hardFails.map((problem) => problem.kind), ["advisory-input"], JSON.stringify(report.hardFails));
  assert.ok(report.hardFails[0].message.startsWith("--evidence input rejected: "));
  assert.ok(report.hardFails[0].message.includes("AC-never-declared"));
  assert.equal(report.advisoryEvidence.length, 0);
  assert.ok(report.nextSteps.some((step) => step.includes("--evidence")));
  // The receipt argument is what failed; the proof itself still ran and passed.
  assert.ok(report.acceptanceCriteria.find((criterion) => criterion.id === "AC-proof").verdict === "pass");

  // Validate mode expresses only the validation verdict, so it must not collect a blocking
  // problem it has no way to report; VALID with a non-empty hardFails array is not a state.
  const validated = await runDogfood({ cwd, validateOnly: true, evidence: ["reviews/receipt.json"] });
  assert.equal(validated.report.verdict, "VALID");
  assert.deepEqual(validated.report.hardFails, []);
  assert.deepEqual(validated.report.advisoryEvidence, []);
});

function installPolicy(cwd, policy) {
  writeFileSync(join(cwd, ".dogfood", "policy.yaml"), stringifyYaml(policy));
  git(cwd, ["add", ".dogfood/policy.yaml"]);
  git(cwd, ["commit", "-qm", "authoritative policy"]);
}
