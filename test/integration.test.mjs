import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { stringify as stringifyYaml } from "yaml";
import { initProject, PACKAGE_ROOT, runDogfood } from "../src/run.mjs";
import { validateContract } from "../src/validate.mjs";
import { createProject, validContract } from "./helpers.mjs";

const packageVersion = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;

test("validate checks mappings without pretending execution", async () => {
  const cwd = createProject();
  const { report, artifactDir } = await runDogfood({ cwd, validateOnly: true });
  assert.equal(report.verdict, "VALID");
  assert.equal(report.validationVerdict, "VALID");
  assert.equal(report.proofVerdict, "NOT_RUN");
  assert.equal(report.acceptanceCriteria[0].verdict, "not-run");
  assert.equal(report.commands.length, 0);
  assert.ok(existsSync(join(artifactDir, "manifest.json")));
});

test("standard mode preserves excluded-only runs and never auto-loads a policy", async () => {
  const contract = {
    version: 1,
    project: "excluded-only",
    commands: {},
    gates: {},
    oracles: {},
    acceptanceCriteria: [{ id: "AC-excluded", class: "excluded", severity: "minor", reason: "Owned elsewhere" }],
  };
  const cwd = createProject(contract);
  writeFileSync(join(cwd, ".dogfood", "dogfood.policy.yaml"), "this: would-be-invalid-if-loaded\n");
  const { report } = await runDogfood({ cwd });
  assert.equal(report.profile, "standard");
  assert.equal(report.verdict, "PASS", JSON.stringify(report.hardFails));
  assert.equal(report.acceptanceCriteria[0].verdict, "excluded");
  assert.ok(report.validation.warnings.some((warning) => warning.includes("--policy was not supplied")));
});

test("an empty contract is an ordinary validation FAIL with failing JUnit", async () => {
  const cwd = createProject();
  writeFileSync(join(cwd, ".dogfood", "dogfood.contract.yaml"), "", "utf8");
  const { report, artifactDir } = await runDogfood({ cwd, validateOnly: true });
  assert.equal(report.verdict, "INVALID");
  assert.ok(report.validation.errors.length > 0);
  assert.match(readFileSync(join(artifactDir, "junit.xml"), "utf8"), /<failure/);
});

test("a passing run emits the complete portable artifact bundle", async () => {
  const cwd = createProject();
  const { report, artifactDir, manifest } = await runDogfood({ cwd });
  assert.equal(report.verdict, "PASS", JSON.stringify(report.hardFails));
  for (const path of [
    "summary.json",
    "summary.md",
    "matrix.json",
    "junit.xml",
    "manifest.json",
    "contract.original.yaml",
    "contract.snapshot.yaml",
    "commands/proof/metadata.json",
    "commands/proof/stdout.log",
    "commands/proof/stderr.log",
    "evidence/exit-code/proof.evaluation.json",
  ]) {
    assert.ok(existsSync(join(artifactDir, path)), path);
  }
  assert.ok(manifest.checksums["summary.json"]);
  assert.equal(
    manifest.checksums["summary.json"],
    createHash("sha256").update(readFileSync(join(artifactDir, "summary.json"))).digest("hex"),
  );
  assert.equal(manifest.version, 1);
  assert.equal(manifest.package.version, packageVersion);
  const latest = JSON.parse(readFileSync(join(cwd, "artifacts", "dogfood", "latest.json")));
  assert.equal(latest.path, report.runId);
  assert.equal(latest.path.startsWith("/"), false);
});

test("validate keeps its own pointer instead of clobbering the proof pointer", async () => {
  const cwd = createProject();
  const proof = await runDogfood({ cwd });
  assert.equal(proof.report.verdict, "PASS", JSON.stringify(proof.report.hardFails));
  const validated = await runDogfood({ cwd, validateOnly: true });
  assert.equal(validated.report.verdict, "VALID");
  const artifactRoot = join(cwd, "artifacts", "dogfood");
  const latest = JSON.parse(readFileSync(join(artifactRoot, "latest.json"), "utf8"));
  const latestValidate = JSON.parse(readFileSync(join(artifactRoot, "latest-validate.json"), "utf8"));
  assert.equal(latest.runId, proof.report.runId);
  assert.equal(latest.path, proof.report.runId);
  assert.equal(latestValidate.runId, validated.report.runId);
  assert.equal(latestValidate.path, validated.report.runId);
});

test("the pointer follows the run that started last, not the one that finished last", async () => {
  const cwd = createProject(validContract());
  const slow = runDogfood({ cwd, runId: "slow-first" });
  // A concurrent run that starts later must own the pointer even when it finishes first.
  await new Promise((resolve) => setTimeout(resolve, 25));
  const fast = await runDogfood({ cwd, runId: "fast-second" });
  await slow;
  const latest = JSON.parse(readFileSync(join(cwd, "artifacts", "dogfood", "latest.json"), "utf8"));
  assert.equal(latest.runId, "fast-second");
  assert.equal(latest.startedAt, fast.report.startedAt);
  assert.equal(latest.mode, "run");
});

test("a Playwright report printed only to stdout is never accepted as evidence", async () => {
  const contract = validContract({
    commands: {
      proof: {
        run: "node -e \"console.log(JSON.stringify({suites:[],stats:{}}))\"",
        timeoutMs: 5000,
        adapter: "playwright-json",
      },
    },
  });
  contract.oracles.proof = { kind: "playwright", command: "proof", tag: "@dogfood:AC-proof" };
  const { report, artifactDir } = await runDogfood({ cwd: createProject(contract) });
  assert.equal(report.verdict, "FAIL");
  const summary = JSON.parse(readFileSync(join(artifactDir, "summary.json"), "utf8"));
  const evidence = summary.commands.find((command) => command.name === "proof").evidence;
  assert.equal(evidence.reportSource, "missing");
  assert.equal(evidence.reportAccepted, false);
});

test("command failures and missing Playwright reports cannot pass", async () => {
  const failing = createProject(
    validContract(),
    { "check.mjs": "process.exit(7);\n" },
  );
  assert.equal((await runDogfood({ cwd: failing })).report.verdict, "FAIL");

  const contract = validContract();
  contract.commands.proof.adapter = "playwright-json";
  contract.oracles.proof = {
    kind: "playwright",
    command: "proof",
    tag: "@dogfood:AC-proof",
  };
  const missingReport = createProject(contract);
  const result = await runDogfood({ cwd: missingReport });
  assert.equal(result.report.verdict, "FAIL");
  assert.match(result.report.acceptanceCriteria[0].detail, /report is missing/i);
});

test("a deterministic minor criterion still blocks the hard verdict", async () => {
  const contract = validContract({
    commands: {
      proof: {
        run: "node -e \"process.exit(1)\"",
        timeoutMs: 5000,
        adapter: "exit-code",
      },
    },
  });
  contract.acceptanceCriteria[0].severity = "minor";
  const { report } = await runDogfood({ cwd: createProject(contract) });
  assert.equal(report.verdict, "FAIL");
  assert.equal(report.acceptanceCriteria[0].verdict, "fail");
  assert.equal(report.enforcement.severityAffectsVerdict, false);
});

test("infrastructure blocks criteria and mixed problems produce FAIL", async () => {
  const infraContract = validContract({
    commands: {
      proof: {
        run: "node -e \"setTimeout(() => {}, 10000)\"",
        timeoutMs: 20,
        adapter: "exit-code",
      },
    },
  });
  const infra = await runDogfood({ cwd: createProject(infraContract) });
  assert.equal(infra.report.verdict, "INFRA_ERROR");
  assert.equal(infra.report.acceptanceCriteria[0].verdict, "blocked");

  const mixedContract = validContract();
  mixedContract.commands.product = {
    run: "node -e \"process.exit(1)\"",
    timeoutMs: 5000,
    adapter: "exit-code",
  };
  mixedContract.gates.verification.push("product");
  mixedContract.oracles.product = { kind: "command", command: "product" };
  mixedContract.acceptanceCriteria.push({
    id: "AC-product",
    class: "deterministic",
    oracle: "product",
    severity: "major",
  });
  mixedContract.commands.proof = infraContract.commands.proof;
  const mixed = await runDogfood({ cwd: createProject(mixedContract) });
  assert.equal(mixed.report.verdict, "FAIL");
  assert.ok(mixed.report.hardFails.some((problem) => problem.category === "infrastructure"));
  assert.ok(mixed.report.hardFails.some((problem) => problem.category === "product"));
});

test("the CLI timeout override is a ceiling and cannot extend command timeouts", async () => {
  const contract = validContract({
    commands: {
      proof: {
        run: "node -e \"setTimeout(() => {}, 500)\"",
        timeoutMs: 1000,
        adapter: "exit-code",
      },
    },
  });
  const { report } = await runDogfood({ cwd: createProject(contract), timeoutMs: 20 });
  assert.equal(report.verdict, "INFRA_ERROR");
  assert.equal(report.commands.find((command) => command.name === "proof").timeoutMs, 20);
});

test("required build identity failures cannot be accepted", async () => {
  for (const identityCommand of ["node -e \"\"", "node -e \"process.exit(1)\""]) {
    const contract = validContract({
      build: {
        requireIdentity: true,
        identityCommand,
        timeoutMs: 1000,
      },
    });
    const { report } = await runDogfood({ cwd: createProject(contract) });
    assert.equal(report.verdict, "FAIL");
    assert.ok(report.hardFails.some((problem) => problem.kind === "build-identity"));
  }
});

test("a verification command that mutates tracked state fails", async () => {
  const cwd = createProject(
    validContract(),
    {
      "tracked.txt": "before\n",
      "check.mjs":
        "import { writeFileSync } from 'node:fs'; writeFileSync('tracked.txt', 'after\\n');\n",
    },
  );
  const { report } = await runDogfood({ cwd });
  assert.equal(report.verdict, "FAIL");
  assert.ok(report.commands.find((command) => command.name === "proof").mutationDetected);
  assert.ok(report.hardFails.some((problem) => problem.kind === "mutation"));
});

test("advisory concern receipts are copied but do not change PASS", async () => {
  const contract = validContract();
  contract.oracles.review = { kind: "advisory" };
  contract.acceptanceCriteria.push({
    id: "AC-usability",
    class: "judgmental",
    oracle: "review",
    severity: "minor",
  });
  const cwd = createProject(contract, {
    "reviews/screenshot.txt": "image stand-in\n",
    "reviews/receipt.json": JSON.stringify({
      version: 1,
      acId: "AC-usability",
      actor: "human reviewer",
      driver: "browser-review",
      assessment: "concern",
      summary: "A non-blocking concern",
      artifacts: ["reviews/screenshot.txt"],
    }),
  });
  const { report, artifactDir } = await runDogfood({
    cwd,
    evidence: ["reviews/receipt.json"],
  });
  assert.equal(report.verdict, "PASS");
  assert.equal(report.advisoryEvidence[0].assessment, "concern");
  assert.ok(existsSync(join(artifactDir, "evidence", "advisory", "receipt-1.json")));
  assert.ok(existsSync(join(artifactDir, "evidence", "advisory", "artifacts", "1", "1-screenshot.txt")));
});

test("oversized advisory artifacts are rejected instead of read into memory", async () => {
  const contract = validContract();
  contract.oracles.review = { kind: "advisory" };
  contract.acceptanceCriteria.push({
    id: "AC-usability",
    class: "judgmental",
    oracle: "review",
    severity: "minor",
  });
  const cwd = createProject(contract, {
    "reviews/huge.bin": "",
    "reviews/receipt.json": JSON.stringify({
      version: 1,
      acId: "AC-usability",
      actor: "human reviewer",
      driver: "browser-review",
      assessment: "satisfied",
      summary: "Oversized attachment",
      artifacts: ["reviews/huge.bin"],
    }),
  });
  truncateSync(join(cwd, "reviews", "huge.bin"), 25 * 1024 * 1024 + 1);
  const { report } = await runDogfood({ cwd, evidence: ["reviews/receipt.json"] });
  assert.equal(report.verdict, "FAIL");
  assert.ok(report.hardFails.some((problem) => problem.message.includes("per-file limit")));
});


test("init installs equivalent skills without overwriting existing agent files", async () => {
  const cwd = createProject();
  const target = join(cwd, "initialized");
  const existing = join(target, ".agents", "skills", "dogfood", "SKILL.md");
  mkdirSync(join(target, ".agents", "skills", "dogfood"), { recursive: true });
  writeFileSync(existing, "custom skill\n", "utf8");
  const result = await initProject(target);
  assert.ok(existsSync(join(target, ".claude", "skills", "dogfood", "SKILL.md")));
  assert.ok(result.skillDests.includes(existing));
  assert.equal(readFileSync(existing, "utf8"), "custom skill\n");
  assert.equal(existsSync(join(target, ".codex", "skills", "dogfood", "SKILL.md")), false);
  const initialized = (await import("yaml")).parse(
    readFileSync(join(target, ".dogfood", "dogfood.contract.yaml"), "utf8"),
  );
  assert.equal(validateContract(initialized).ok, false);
});

test("authoritative init installs explicit protected-policy and CODEOWNERS templates", async () => {
  const cwd = createProject();
  const target = join(cwd, "authoritative-init");
  const result = await initProject(target, { authoritative: true });
  assert.ok(existsSync(result.policyPath));
  assert.ok(existsSync(join(target, ".dogfood", "CODEOWNERS.fragment")));
  const policy = (await import("yaml")).parse(readFileSync(result.policyPath, "utf8"));
  assert.equal(policy.profile, "authoritative");
});
