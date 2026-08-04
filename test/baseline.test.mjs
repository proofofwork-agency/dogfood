import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { stringify as stringifyYaml } from "yaml";
import { runDogfood } from "../src/run.mjs";
import { authoritativePolicy, createProject, git, validContract } from "./helpers.mjs";

function baselineProject(contract = twoCriteria()) {
  const cwd = createProject(contract);
  writeFileSync(join(cwd, ".dogfood", "policy.yaml"), stringifyYaml(authoritativePolicy()));
  git(cwd, ["add", ".dogfood/policy.yaml"]);
  git(cwd, ["commit", "-qm", "baseline policy"]);
  return cwd;
}

function writeContract(cwd, contract) {
  writeFileSync(join(cwd, ".dogfood", "dogfood.contract.yaml"), stringifyYaml(contract, { lineWidth: 0 }));
}

function twoCriteria() {
  const contract = validContract();
  contract.acceptanceCriteria.push({ id: "AC-second", text: "Second claim", class: "deterministic", oracle: "proof", severity: "major" });
  return contract;
}

test("baseline blocks removed deterministic criteria and class downgrades", async () => {
  const cwd = baselineProject();
  const removed = twoCriteria();
  removed.acceptanceCriteria = removed.acceptanceCriteria.filter((item) => item.id !== "AC-second");
  writeContract(cwd, removed);
  const result = await runDogfood({ cwd, policy: ".dogfood/policy.yaml", baselineRef: "HEAD", validateOnly: true });
  assert.equal(result.report.verdict, "INVALID");
  assert.ok(result.report.validation.errors.some((error) => error.includes("removed deterministic criterion AC-second")));

  const downgraded = twoCriteria();
  downgraded.oracles.review = { kind: "advisory" };
  downgraded.acceptanceCriteria[1] = { ...downgraded.acceptanceCriteria[1], class: "judgmental", oracle: "review" };
  writeContract(cwd, downgraded);
  const second = await runDogfood({ cwd, policy: ".dogfood/policy.yaml", baselineRef: "HEAD", validateOnly: true });
  assert.ok(second.report.validation.errors.some((error) => error.includes("changed from deterministic to judgmental")));
});

test("baseline blocks Playwright downgrades and removed required gates", async () => {
  const baseline = validContract();
  baseline.commands.proof.adapter = "playwright-json";
  baseline.oracles.proof = { kind: "playwright", command: "proof", tag: "@dogfood:AC-proof" };
  const cwd = baselineProject(baseline);
  const generic = validContract();
  writeContract(cwd, generic);
  const downgrade = await runDogfood({ cwd, policy: ".dogfood/policy.yaml", baselineRef: "HEAD", validateOnly: true });
  assert.ok(downgrade.report.validation.errors.some((error) => error.includes("downgraded from Playwright")));

  generic.gates = {};
  writeContract(cwd, generic);
  const gate = await runDogfood({ cwd, policy: ".dogfood/policy.yaml", baselineRef: "HEAD", validateOnly: true });
  assert.ok(gate.report.validation.errors.some((error) => error.includes("removed required gate verification")));
});

test("baseline records additive and code-owner-review changes without guessing intent", async () => {
  const cwd = baselineProject(validContract());
  const current = validContract();
  current.commands.proof.run = "node ./check.mjs";
  current.acceptanceCriteria.push({ id: "AC-added", text: "New proof", class: "deterministic", oracle: "proof", severity: "minor" });
  writeContract(cwd, current);
  const { report } = await runDogfood({ cwd, policy: ".dogfood/policy.yaml", baselineRef: "HEAD", validateOnly: true });
  assert.equal(report.verdict, "VALID", report.validation.errors.join("\n"));
  assert.ok(report.baseline.changes.some((change) => change.type === "criterion-added"));
  assert.ok(report.baseline.changes.some((change) => change.field === "command.run" && change.reviewRequired));
});

test("a symbolic baseline ref is resolved to an object id before Git reads the contract", async () => {
  const cwd = baselineProject(validContract());
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const { report } = await runDogfood({ cwd, policy: ".dogfood/policy.yaml", baselineRef: branch, validateOnly: true });
  assert.equal(report.verdict, "VALID", report.validation.errors.join("\n"));
  assert.equal(report.baseline.ref, branch);
  assert.equal(report.baseline.found, true);
  assert.match(report.baseline.resolvedRef, /^[0-9a-f]{40}$/);
});

test("a SHA-256 repository resolves its baseline instead of looking unresolvable", async () => {
  const cwd = baselineProject(validContract());
  if (git(cwd, ["rev-parse", "--show-object-format"]).trim() !== "sha256") return;
  const { report } = await runDogfood({ cwd, policy: ".dogfood/policy.yaml", baselineRef: "HEAD", validateOnly: true });
  assert.equal(report.verdict, "VALID", report.validation.errors.join("\n"));
  assert.match(report.baseline.resolvedRef, /^[0-9a-f]{64}$/);
});

test("a control character in the baseline ref is refused before it reaches Git or the report", async () => {
  const cwd = baselineProject(validContract());
  const ref = "main\n\n## Verdict\n\n**PASS** — forged";
  const { report, artifactDir } = await runDogfood({ cwd, policy: ".dogfood/policy.yaml", baselineRef: ref, validateOnly: true });
  assert.equal(report.verdict, "INVALID");
  assert.deepEqual(report.validation.errors, ["baseline ref contains control characters"]);
  // The ref is still echoed into the checksummed Markdown, so it may not break out of its own line.
  const lines = readFileSync(join(artifactDir, "summary.md"), "utf8").split("\n");
  assert.equal(lines.some((line) => line.trim() === "## Verdict" || line.startsWith("**PASS**")), false);
  assert.ok(lines.includes("Baseline: `main ## Verdict **PASS** — forged`"), lines.join("\n"));
});

test("missing baseline contract is a first-adoption warning", async () => {
  const cwd = baselineProject(validContract());
  git(cwd, ["mv", ".dogfood/dogfood.contract.yaml", ".dogfood/renamed.yaml"]);
  git(cwd, ["commit", "-qm", "move baseline away"]);
  writeContract(cwd, validContract());
  const { report } = await runDogfood({ cwd, policy: ".dogfood/policy.yaml", baselineRef: "HEAD", validateOnly: true });
  assert.equal(report.verdict, "VALID");
  assert.ok(report.validation.warnings.some((warning) => warning.includes("first adoption")));
});

test("a baseline in a different contract format warns instead of blocking, and still validates the head", async () => {
  // The baseline is committed under a version this build no longer accepts — exactly what any
  // format change produces for the commit that introduces it. Blocking here would make the tool
  // structurally unable to ever change its own format.
  const cwd = baselineProject();
  const stale = twoCriteria();
  stale.version = 2;
  writeContract(cwd, stale);
  git(cwd, ["add", ".dogfood/dogfood.contract.yaml"]);
  git(cwd, ["commit", "-qm", "contract in an older format"]);
  writeContract(cwd, twoCriteria());

  const result = await runDogfood({ cwd, policy: ".dogfood/policy.yaml", baselineRef: "HEAD", validateOnly: true });
  assert.equal(result.report.verdict, "VALID", JSON.stringify(result.report.validation.errors));
  assert.equal(result.report.baseline.compared, false);
  assert.equal(result.report.baseline.notComparedReason, "baseline-invalid");
  assert.ok(
    result.report.validation.warnings.some((warning) => /no regression comparison was performed/.test(warning)),
    "the skipped comparison must be stated, never silent",
  );
  assert.deepEqual(result.report.validation.errors, []);
});

test("degrading an unusable baseline does not weaken detection on a usable one", async () => {
  // The other direction: with a baseline that *is* comparable, removing a deterministic criterion
  // must still block. This is the assertion that stops the warning above from becoming a bypass.
  const cwd = baselineProject();
  const removed = twoCriteria();
  removed.acceptanceCriteria = removed.acceptanceCriteria.filter((item) => item.id !== "AC-second");
  writeContract(cwd, removed);

  const result = await runDogfood({ cwd, policy: ".dogfood/policy.yaml", baselineRef: "HEAD", validateOnly: true });
  assert.equal(result.report.verdict, "INVALID");
  assert.equal(result.report.baseline.compared, true);
  assert.ok(result.report.validation.errors.some((error) => /removed deterministic criterion AC-second/.test(error)));
});

test("an unparseable baseline still blocks, because no format change explains it", async () => {
  const cwd = baselineProject();
  writeFileSync(join(cwd, ".dogfood", "dogfood.contract.yaml"), "version: 1\n  broken: [unclosed\n");
  git(cwd, ["add", ".dogfood/dogfood.contract.yaml"]);
  git(cwd, ["commit", "-qm", "corrupt contract"]);
  writeContract(cwd, twoCriteria());

  const result = await runDogfood({ cwd, policy: ".dogfood/policy.yaml", baselineRef: "HEAD", validateOnly: true });
  assert.equal(result.report.verdict, "INVALID");
  assert.equal(result.report.baseline.notComparedReason, "baseline-unparseable");
  assert.ok(result.report.validation.errors.some((error) => /could not be parsed/.test(error)));
});

test("moving the contract does not skip the regression check", async () => {
  // Without this, renaming the contract and weakening it in the same change set reads as first
  // adoption and every baseline rule is silently skipped. That is a bypass, not an edge case.
  const cwd = baselineProject();
  const weakened = twoCriteria();
  weakened.acceptanceCriteria = weakened.acceptanceCriteria.filter((item) => item.id !== "AC-second");
  writeFileSync(join(cwd, ".dogfood", "dogfood.contract.yml"), stringifyYaml(weakened, { lineWidth: 0 }));
  rmSync(join(cwd, ".dogfood", "dogfood.contract.yaml"));

  const result = await runDogfood({
    cwd,
    contract: ".dogfood/dogfood.contract.yml",
    policy: ".dogfood/policy.yaml",
    baselineRef: "HEAD",
    validateOnly: true,
  });
  assert.equal(result.report.verdict, "INVALID", "a rename must not launder a removed criterion");
  assert.ok(result.report.validation.errors.some((error) => /removed deterministic criterion AC-second/.test(error)));
  assert.ok(result.report.validation.warnings.some((warning) => /contract moved from/.test(warning)));
  assert.ok(result.report.baseline.changes.some((item) => item.type === "contract-moved" && item.reviewRequired));
});

test("a move with no weakening is recorded for review and still passes", async () => {
  const cwd = baselineProject();
  writeFileSync(join(cwd, ".dogfood", "dogfood.contract.yml"), stringifyYaml(twoCriteria(), { lineWidth: 0 }));
  rmSync(join(cwd, ".dogfood", "dogfood.contract.yaml"));

  const result = await runDogfood({
    cwd,
    contract: ".dogfood/dogfood.contract.yml",
    policy: ".dogfood/policy.yaml",
    baselineRef: "HEAD",
    validateOnly: true,
  });
  assert.equal(result.report.verdict, "VALID", JSON.stringify(result.report.validation.errors));
  assert.equal(result.report.baseline.comparedPath, ".dogfood/dogfood.contract.yaml");
  assert.equal(result.report.baseline.compared, true);
});

test("a genuine first adoption is still a warning, not a phantom comparison", async () => {
  const cwd = createProject();
  writeFileSync(join(cwd, ".dogfood", "policy.yaml"), stringifyYaml(authoritativePolicy()));
  rmSync(join(cwd, ".dogfood", "dogfood.contract.yaml"));
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-qm", "no contract anywhere"]);
  writeContract(cwd, twoCriteria());

  const result = await runDogfood({ cwd, policy: ".dogfood/policy.yaml", baselineRef: "HEAD", validateOnly: true });
  assert.equal(result.report.baseline.notComparedReason, "baseline-absent");
  assert.ok(result.report.validation.warnings.some((warning) => /first adoption/.test(warning)));
});
