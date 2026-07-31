import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { stringify as stringifyYaml } from "yaml";
import { ContractInputError } from "../src/load-contract.mjs";
import { runDogfood } from "../src/run.mjs";
import { authoritativePolicy, createProject, git, validContract } from "./helpers.mjs";

test("authoritative policy fails closed on unknown fields and missing files", async () => {
  const cwd = createProject();
  const policy = authoritativePolicy();
  policy.surprise = true;
  writeFileSync(join(cwd, ".dogfood", "policy.yaml"), stringifyYaml(policy));
  const result = await runDogfood({ cwd, policy: ".dogfood/policy.yaml", validateOnly: true });
  assert.equal(result.report.verdict, "INVALID");
  assert.ok(result.report.validation.errors.some((error) => error.includes('unknown field "surprise"')));
  await assert.rejects(
    runDogfood({ cwd, policy: ".dogfood/missing.yaml", validateOnly: true }),
    ContractInputError,
  );
});

test("authoritative criteria rules reject zero scope and missing required gates", async () => {
  const contract = validContract();
  contract.acceptanceCriteria[0] = {
    id: "AC-excluded",
    class: "excluded",
    severity: "minor",
    reason: "Not in scope",
  };
  contract.gates = {};
  contract.oracles = {};
  contract.commands = {};
  const cwd = createProject(contract);
  writeFileSync(join(cwd, ".dogfood", "policy.yaml"), stringifyYaml(authoritativePolicy()));
  const { report } = await runDogfood({ cwd, policy: ".dogfood/policy.yaml", validateOnly: true });
  assert.equal(report.verdict, "INVALID");
  assert.ok(report.validation.errors.some((error) => error.includes("at least 1 deterministic")));
  assert.ok(report.validation.errors.some((error) => error.includes("excluded-only")));
  assert.ok(report.validation.errors.some((error) => error.includes('gate "verification"')));
});

test("authoritative policy can require a regular build subject", async () => {
  const missingContract = validContract();
  const missing = createProject(missingContract);
  writeFileSync(join(missing, ".dogfood", "policy.yaml"), stringifyYaml(authoritativePolicy({ build: { requireSubject: true } })));
  const invalid = await runDogfood({ cwd: missing, policy: ".dogfood/policy.yaml", validateOnly: true });
  assert.equal(invalid.report.verdict, "INVALID");
  assert.ok(invalid.report.validation.errors.some((error) => error.includes("build.subject")));

  const contract = validContract({ build: { requireIdentity: true, subject: { path: "dist/app.tar.gz", algorithm: "sha256" } } });
  const cwd = createProject(contract, { "dist/app.tar.gz": "candidate\n" });
  writeFileSync(join(cwd, ".dogfood", "policy.yaml"), stringifyYaml(authoritativePolicy({ build: { requireSubject: true } })));
  git(cwd, ["add", ".dogfood/policy.yaml"]);
  git(cwd, ["commit", "-qm", "authoritative policy"]);
  const { report } = await runDogfood({ cwd, policy: ".dogfood/policy.yaml" });
  assert.equal(report.verdict, "PASS", JSON.stringify(report.hardFails));
  assert.equal(report.buildSubject.path, "dist/app.tar.gz");
  assert.equal(report.buildSubject.size, Buffer.byteLength("candidate\n"));
});

test("authoritative logs redact secrets and support metadata-only capture", async () => {
  const contract = validContract({ commands: { proof: { run: "node -e \"console.log(process.env.DOGFOOD_TEST_TOKEN, 'literal-secret')\"", timeoutMs: 5000, adapter: "exit-code" } } });
  const cwd = createProject(contract);
  const policy = authoritativePolicy({ logs: { capture: "full-redacted", redactEnv: ["*_TOKEN"], redactLiterals: ["literal-secret"] } });
  writeFileSync(join(cwd, ".dogfood", "policy.yaml"), stringifyYaml(policy));
  git(cwd, ["add", ".dogfood/policy.yaml"]);
  git(cwd, ["commit", "-qm", "policy"]);
  const previous = process.env.DOGFOOD_TEST_TOKEN;
  process.env.DOGFOOD_TEST_TOKEN = "environment-secret";
  try {
    const { report, artifactDir } = await runDogfood({ cwd, policy: ".dogfood/policy.yaml" });
    assert.equal(report.verdict, "PASS");
    const log = readFileSync(join(artifactDir, "commands", "proof", "stdout.log"), "utf8");
    assert.equal(log.includes("environment-secret"), false);
    assert.equal(log.includes("literal-secret"), false);
    assert.match(log, /\[REDACTED\]/);
  } finally {
    if (previous === undefined) delete process.env.DOGFOOD_TEST_TOKEN;
    else process.env.DOGFOOD_TEST_TOKEN = previous;
  }

  policy.logs.capture = "metadata-only";
  writeFileSync(join(cwd, ".dogfood", "policy.yaml"), stringifyYaml(policy));
  git(cwd, ["add", ".dogfood/policy.yaml"]);
  git(cwd, ["commit", "-qm", "metadata only"]);
  const metadataOnly = await runDogfood({ cwd, policy: ".dogfood/policy.yaml" });
  assert.equal(readFileSync(join(metadataOnly.artifactDir, "commands", "proof", "stdout.log"), "utf8"), "");
});
