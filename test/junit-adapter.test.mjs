import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  evaluateAdapter,
  evaluateJunitXml,
  MAX_EVIDENCE_REPORT_BYTES,
  prepareAdapter,
} from "../src/adapters.mjs";
import { junitSelectorKey } from "../src/junit.mjs";
import { createRedactor } from "../src/redact.mjs";
import { runDogfood } from "../src/run.mjs";
import { expectedJunitCases } from "../src/score-ac.mjs";
import { validateContract } from "../src/validate.mjs";
import { verifyBundle } from "../src/verify.mjs";
import { createProject } from "./helpers.mjs";

const REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="example" tests="2" failures="0" errors="0">
  <testcase classname="checkout" name="expired card"/>
  <testcase classname="pricing" name="bulk discount"/>
</testsuite>
`;

const DEFINITION = { adapter: "junit-xml", run: "noop", timeoutMs: 1000, reportPath: "reports/junit.xml" };
const OK = { status: "pass", code: 0, timedOut: false, stdout: "" };
const SELECTOR = { classname: "checkout", name: "expired card" };

function workspace() {
  const cwd = createProject();
  mkdirSync(join(cwd, "artifacts"), { recursive: true });
  return { cwd, artifactDir: join(cwd, "artifacts") };
}

function writeReport(cwd, body = REPORT, path = "reports/junit.xml") {
  const full = join(cwd, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body, "utf8");
  return full;
}

function junitContract(overrides = {}) {
  return {
    version: 1,
    project: "junit-fixture",
    commands: {
      suite: { run: "node run-suite.mjs", timeoutMs: 60000, adapter: "junit-xml", reportPath: "reports/junit.xml" },
    },
    gates: { verification: ["suite"] },
    oracles: { expired: { kind: "junit", command: "suite", testcase: SELECTOR } },
    acceptanceCriteria: [{ id: "AC-expired", class: "deterministic", oracle: "expired", severity: "blocker" }],
    ...overrides,
  };
}

/** A stand-in runner that writes the report the contract declares, and nothing else. */
const RUNNER = `import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("reports", { recursive: true });
writeFileSync("reports/junit.xml", ${JSON.stringify(REPORT)}, "utf8");
`;

test("a pre-planted report is cleared, so evidence can only come from the command", () => {
  const { cwd, artifactDir } = workspace();
  const reportPath = writeReport(cwd);
  const prepared = prepareAdapter("suite", DEFINITION, artifactDir, { cwd });
  assert.equal(existsSync(reportPath), false, "the declared path is cleared before the command runs");

  const result = evaluateJunitXml(OK, prepared, [SELECTOR]);
  assert.equal(result.status, "fail");
  assert.equal(result.reportSource, "missing");
  assert.equal(result.accepted, false);
  assert.match(result.detail, /missing at reports\/junit\.xml/);
});

test("a report is accepted, republished into the bundle and redacted on the way", () => {
  const { cwd, artifactDir } = workspace();
  const secret = "environment-secret-value";
  writeReport(cwd, REPORT.replace("bulk discount", `bulk discount ${secret}`));
  const prepared = prepareAdapter("suite", DEFINITION, artifactDir, { cwd });
  writeReport(cwd, REPORT.replace("bulk discount", `bulk discount ${secret}`));

  const result = evaluateJunitXml(OK, prepared, [SELECTOR], createRedactor({ capture: "full-redacted", redactLiterals: [secret] }, {}));
  assert.equal(result.status, "pass");
  assert.equal(result.reportSource, "file");
  assert.equal(result.accepted, true);
  assert.equal(result.testcases[junitSelectorKey(SELECTOR)].status, "pass");

  const published = readFileSync(prepared.reportPath, "utf8");
  assert.equal(published.includes(secret), false);
  assert.match(published, /\[REDACTED\]/);
  assert.match(published, /classname="checkout"/, "the rest of the evidence survives verbatim");
});

test("stdout can never stand in for the report", () => {
  const { cwd, artifactDir } = workspace();
  const prepared = prepareAdapter("suite", DEFINITION, artifactDir, { cwd });
  const result = evaluateJunitXml({ ...OK, stdout: REPORT }, prepared, [SELECTOR]);
  assert.equal(result.status, "fail");
  assert.equal(result.reportSource, "missing");
});

test("a reportPath escaping the workspace is refused and never cleared", () => {
  const { cwd, artifactDir } = workspace();
  const outside = join(cwd, "..", `dogfood-outside-${process.pid}.xml`);
  writeFileSync(outside, REPORT, "utf8");
  try {
    const prepared = prepareAdapter("suite", { ...DEFINITION, reportPath: "../escape.xml" }, artifactDir, { cwd });
    assert.equal(prepared.sourceEscapes, true);
    assert.equal(prepared.sourcePath, null);
    const result = evaluateJunitXml(OK, prepared, [SELECTOR]);
    assert.equal(result.status, "fail");
    assert.match(result.detail, /does not resolve inside the workspace/);
    assert.equal(existsSync(outside), true, "a path outside the workspace is never deleted");
  } finally {
    rmSync(outside, { force: true });
  }
});

test("a report directory that becomes a symlink out of the tree is caught after the command", { skip: process.platform === "win32" }, () => {
  const { cwd, artifactDir } = workspace();
  const prepared = prepareAdapter("suite", DEFINITION, artifactDir, { cwd });
  // The pre-run check can only see the path it was going to become; this is the command escaping
  // during its own run, which is why containment is re-checked before the bytes are read.
  const elsewhere = join(cwd, "..", `dogfood-elsewhere-${process.pid}`);
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, "junit.xml"), REPORT, "utf8");
  try {
    symlinkSync(elsewhere, join(cwd, "reports"));
    const result = evaluateJunitXml(OK, prepared, [SELECTOR]);
    assert.equal(result.status, "fail");
    assert.match(result.detail, /outside the workspace/);
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("an oversized report is refused before it is read into memory", () => {
  const { cwd, artifactDir } = workspace();
  const prepared = prepareAdapter("suite", DEFINITION, artifactDir, { cwd });
  const reportPath = writeReport(cwd, "");
  truncateSync(reportPath, MAX_EVIDENCE_REPORT_BYTES + 1);
  const result = evaluateJunitXml(OK, prepared, [SELECTOR]);
  assert.equal(result.status, "fail");
  assert.equal(result.accepted, false);
  assert.match(result.detail, /evidence limit/);
});

test("an unparseable report fails and keeps its markup out of the detail", () => {
  const { cwd, artifactDir } = workspace();
  const prepared = prepareAdapter("suite", DEFINITION, artifactDir, { cwd });
  writeReport(cwd, `<!DOCTYPE x [<!ENTITY a "aaaa">]><testsuite name="s"><testcase classname="a" name="&a;"/></testsuite>`);
  const result = evaluateJunitXml(OK, prepared, [SELECTOR]);
  assert.equal(result.status, "fail");
  assert.equal(result.accepted, false);
  assert.match(result.detail, /document type/);
  assert.equal(result.detail.length <= 140, true, `detail is capped, got ${result.detail.length}`);
});

test("a command exiting non-zero fails even when the bound testcase passed", () => {
  const { cwd, artifactDir } = workspace();
  const prepared = prepareAdapter("suite", DEFINITION, artifactDir, { cwd });
  writeReport(cwd);
  const result = evaluateJunitXml({ ...OK, status: "fail", code: 1 }, prepared, [SELECTOR]);
  assert.equal(result.status, "fail");
  assert.match(result.detail, /code=1/);
  assert.equal(result.testcases[junitSelectorKey(SELECTOR)].status, "pass", "the selector result is still recorded");
});

test("an infra result never reads a report at all", () => {
  const { cwd, artifactDir } = workspace();
  const prepared = prepareAdapter("suite", DEFINITION, artifactDir, { cwd });
  writeReport(cwd);
  const result = evaluateJunitXml({ status: "infra", code: null, timedOut: true, stdout: "" }, prepared, [SELECTOR]);
  assert.equal(result.status, "infra");
  assert.equal(existsSync(prepared.reportPath), false, "nothing is published for a run that never produced evidence");
});

test("evaluateAdapter dispatches junit-xml and writes its evaluation", () => {
  const { cwd, artifactDir } = workspace();
  const prepared = prepareAdapter("suite", DEFINITION, artifactDir, { cwd });
  writeReport(cwd);
  const result = evaluateAdapter(DEFINITION, OK, prepared, [], null, [SELECTOR]);
  assert.equal(result.adapter, "junit-xml");
  assert.equal(result.status, "pass");
  assert.deepEqual(JSON.parse(readFileSync(prepared.evaluationPath, "utf8")).testcases, result.testcases);
});

test("the contract rejects reportPath on the wrong adapter and demands it on the right one", () => {
  const missing = junitContract();
  delete missing.commands.suite.reportPath;
  assert.equal(validateContract(missing).ok, false);

  const misplaced = junitContract();
  misplaced.commands.suite = { run: "x", timeoutMs: 1000, adapter: "exit-code", reportPath: "reports/junit.xml" };
  assert.equal(validateContract(misplaced).ok, false);

  for (const bad of ["/etc/passwd", "../escape.xml", "reports/../../escape.xml", "C:\\Windows\\x.xml"]) {
    const contract = junitContract();
    contract.commands.suite.reportPath = bad;
    assert.equal(validateContract(contract).ok, false, `${bad} must not validate`);
  }

  assert.equal(validateContract(junitContract()).ok, true);
});

test("a junit oracle must point at a junit-xml command, and a gated one needs a deterministic testcase", () => {
  const wrongAdapter = junitContract();
  wrongAdapter.commands.suite = { run: "x", timeoutMs: 1000, adapter: "exit-code" };
  assert.match(
    validateContract(wrongAdapter).errors.join("\n"),
    /kind=junit requires commands\.suite\.adapter=junit-xml/,
  );

  const ungated = junitContract();
  ungated.acceptanceCriteria = [{ id: "AC-x", class: "excluded", reason: "not in scope", severity: "minor" }];
  ungated.oracles = {};
  assert.match(
    validateContract(ungated).errors.join("\n"),
    /uses junit-xml in a gate but has no deterministic JUnit oracle testcase/,
  );
});

test("expectedJunitCases collects and dedupes selectors per command", () => {
  const contract = junitContract();
  contract.oracles.duplicate = { kind: "junit", command: "suite", testcase: { ...SELECTOR } };
  contract.oracles.other = { kind: "junit", command: "suite", testcase: { classname: "pricing", name: "bulk discount" } };
  contract.acceptanceCriteria.push(
    { id: "AC-duplicate", class: "deterministic", oracle: "duplicate", severity: "minor" },
    { id: "AC-other", class: "deterministic", oracle: "other", severity: "minor" },
  );
  assert.deepEqual(expectedJunitCases(contract).suite, [SELECTOR, { classname: "pricing", name: "bulk discount" }]);
});

test("end to end: a junit proof passes, verifies, and the bundle carries the report", async () => {
  const cwd = createProject(junitContract(), { "run-suite.mjs": RUNNER });
  const { report, artifactDir } = await runDogfood({ cwd });
  assert.equal(report.verdict, "PASS", JSON.stringify(report.hardFails));
  assert.equal(report.acceptanceCriteria[0].verdict, "pass");

  const published = join(artifactDir, "evidence", "junit-xml", "suite.report.xml");
  assert.equal(existsSync(published), true);
  assert.match(readFileSync(published, "utf8"), /classname="checkout"/);
  assert.equal(verifyBundle(artifactDir, { cwd }).ok, true, "the republished report is covered by the manifest");
});

test("end to end: renaming the test unbinds the criterion and fails", async () => {
  const contract = junitContract();
  contract.oracles.expired.testcase = { classname: "checkout", name: "expired card renamed" };
  const cwd = createProject(contract, { "run-suite.mjs": RUNNER });

  const { report } = await runDogfood({ cwd });
  assert.equal(report.verdict, "FAIL");
  assert.match(report.acceptanceCriteria[0].detail, /no testcase matching/);
});

test("end to end: a command that writes no report cannot pass", async () => {
  const cwd = createProject(junitContract(), { "run-suite.mjs": "process.stdout.write('all green\\n');\n" });
  const { report } = await runDogfood({ cwd });
  assert.equal(report.verdict, "FAIL");
  assert.match(report.acceptanceCriteria[0].detail, /missing at reports\/junit\.xml/);
});
