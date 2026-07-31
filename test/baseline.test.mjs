import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
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

test("missing baseline contract is a first-adoption warning", async () => {
  const cwd = baselineProject(validContract());
  git(cwd, ["mv", ".dogfood/dogfood.contract.yaml", ".dogfood/renamed.yaml"]);
  git(cwd, ["commit", "-qm", "move baseline away"]);
  writeContract(cwd, validContract());
  const { report } = await runDogfood({ cwd, policy: ".dogfood/policy.yaml", baselineRef: "HEAD", validateOnly: true });
  assert.equal(report.verdict, "VALID");
  assert.ok(report.validation.warnings.some((warning) => warning.includes("first adoption")));
});
