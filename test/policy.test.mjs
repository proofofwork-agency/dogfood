import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { stringify as stringifyYaml } from "yaml";
import { ContractInputError } from "../src/load-contract.mjs";
import { listFiles } from "../src/report.mjs";
import { runDogfood } from "../src/run.mjs";
import { verifyBundle } from "../src/verify.mjs";
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

test("logs are redacted with no policy at all", async () => {
  const contract = validContract({ commands: { proof: { run: "node -e \"console.log(process.env.DOGFOOD_TEST_TOKEN)\"", timeoutMs: 5000, adapter: "exit-code" } } });
  const cwd = createProject(contract);
  const previous = process.env.DOGFOOD_TEST_TOKEN;
  process.env.DOGFOOD_TEST_TOKEN = "environment-secret-value";
  try {
    const { report, artifactDir } = await runDogfood({ cwd });
    assert.equal(report.verdict, "PASS", JSON.stringify(report.hardFails));
    const log = readFileSync(join(artifactDir, "commands", "proof", "stdout.log"), "utf8");
    assert.equal(log.includes("environment-secret-value"), false);
    assert.match(log, /\[REDACTED\]/);
    const metadata = JSON.parse(readFileSync(join(artifactDir, "commands", "proof", "metadata.json"), "utf8"));
    assert.equal(metadata.logCapture, "full-redacted");
    assert.equal(metadata.redactionApplied, true);
  } finally {
    if (previous === undefined) delete process.env.DOGFOOD_TEST_TOKEN;
    else process.env.DOGFOOD_TEST_TOKEN = previous;
  }
});

test("a declared literal reaches no file in the bundle, and the bundle still verifies", async () => {
  const secret = "literalsecret-ZZZZXXXXCCCCVVVV-8888";
  const contract = validContract({ commands: { proof: { run: `node check.mjs --api-token=${secret}`, timeoutMs: 5000, adapter: "exit-code" } } });
  const cwd = createProject(contract);
  writeFileSync(
    join(cwd, ".dogfood", "policy.yaml"),
    stringifyYaml(authoritativePolicy({ logs: { capture: "full-redacted", redactEnv: [], redactLiterals: [secret] } })),
  );
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-qm", "policy with a declared literal"]);
  const { report, artifactDir } = await runDogfood({ cwd, policy: ".dogfood/policy.yaml" });
  assert.equal(report.verdict, "PASS", JSON.stringify(report.hardFails));
  // Declaring a string as a secret is what used to publish it: the policy copy carried the list,
  // and the command line carried the value into metadata.json, summary.json and the manifest.
  const leaking = listFiles(artifactDir).filter((file) => readFileSync(file, "utf8").includes(secret));
  assert.deepEqual(leaking.map((file) => relative(artifactDir, file)), []);
  assert.match(readFileSync(join(artifactDir, "policy.original.yaml"), "utf8"), /redactLiterals:\n\s+- REDACTED/);
  // Digests are taken over the published copies, so masking cannot break offline verification.
  const verification = verifyBundle(artifactDir);
  assert.equal(verification.ok, true, verification.errors.join("\n"));
});

test("redaction leaves short numeric secrets alone instead of shredding the log", async () => {
  const contract = validContract({ commands: { proof: { run: "node -e \"console.log('attempt 1 of 1, 11 checks')\"", timeoutMs: 5000, adapter: "exit-code" } } });
  const cwd = createProject(contract);
  writeFileSync(join(cwd, ".dogfood", "policy.yaml"), stringifyYaml(authoritativePolicy()));
  git(cwd, ["add", ".dogfood/policy.yaml"]);
  git(cwd, ["commit", "-qm", "policy"]);
  const previous = process.env.DOGFOOD_TEST_KEY;
  process.env.DOGFOOD_TEST_KEY = "1";
  try {
    const { report, artifactDir } = await runDogfood({ cwd, policy: ".dogfood/policy.yaml" });
    assert.equal(report.verdict, "PASS", JSON.stringify(report.hardFails));
    const log = readFileSync(join(artifactDir, "commands", "proof", "stdout.log"), "utf8");
    assert.match(log, /attempt 1 of 1, 11 checks/);
    assert.equal(log.includes("[REDACTED]"), false);
  } finally {
    if (previous === undefined) delete process.env.DOGFOOD_TEST_KEY;
    else process.env.DOGFOOD_TEST_KEY = previous;
  }
});
