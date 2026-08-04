import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateAdapter, evaluatePlaywrightJson, evaluatePlaywrightTag, prepareAdapter } from "../src/adapters.mjs";
import { createRedactor } from "../src/redact.mjs";
import {
  playwrightExecution,
  playwrightReport,
  playwrightSpec,
} from "./helpers.mjs";

test("accepts every matching first-attempt execution across projects", () => {
  const report = playwrightReport([
    playwrightSpec({
      tests: [
        playwrightExecution({ projectName: "chromium" }),
        playwrightExecution({ projectName: "webkit" }),
      ],
    }),
  ]);
  const result = evaluatePlaywrightTag(report, "@dogfood:AC-proof");
  assert.equal(result.status, "pass");
  assert.equal(result.executions.length, 2);
});

test("requires an exact structured tag", () => {
  const report = playwrightReport([
    playwrightSpec({ title: "@dogfood:AC-proof in a title", tags: ["@dogfood:other"] }),
  ]);
  const result = evaluatePlaywrightTag(report, "@dogfood:AC-proof");
  assert.equal(result.status, "fail");
  assert.match(result.detail, /no test with exact tag/);
});

test("accepts Playwright's structured reporter form when it omits the leading at-sign", () => {
  const report = playwrightReport([
    playwrightSpec({ tags: ["dogfood:AC-proof"] }),
  ]);
  assert.equal(evaluatePlaywrightTag(report, "@dogfood:AC-proof").status, "pass");
});

test("rejects skipped and interrupted executions", () => {
  for (const status of ["skipped", "interrupted"]) {
    const report = playwrightReport([
      playwrightSpec({
        tests: [
          playwrightExecution({
            status: status === "skipped" ? "skipped" : "unexpected",
            results: [{ status, duration: 0 }],
          }),
        ],
      }),
    ]);
    assert.equal(evaluatePlaywrightTag(report, "@dogfood:AC-proof").status, "fail");
  }
});

test("rejects retry-passed and flaky executions", () => {
  const report = playwrightReport([
    playwrightSpec({
      tests: [
        playwrightExecution({
          status: "flaky",
          results: [
            { status: "failed", duration: 1 },
            { status: "passed", duration: 1 },
          ],
        }),
      ],
    }),
  ]);
  const result = evaluatePlaywrightTag(report, "@dogfood:AC-proof");
  assert.equal(result.status, "fail");
  assert.match(result.detail, /first attempt/);
});

test("rejects expected failures even when Playwright classifies them as expected", () => {
  const report = playwrightReport([
    playwrightSpec({
      tests: [
        playwrightExecution({
          expectedStatus: "failed",
          results: [{ status: "failed", duration: 1 }],
        }),
      ],
    }),
  ]);
  assert.equal(evaluatePlaywrightTag(report, "@dogfood:AC-proof").status, "fail");
});

test("refuses a Playwright report forged on stdout and copies no part of it into the bundle", () => {
  const directory = mkdtempSync(join(tmpdir(), "dogfood-adapter-"));
  try {
    const reportPath = join(directory, "report.json");
    const secret = `ghp_${"S".repeat(36)}`;
    const report = playwrightReport([playwrightSpec({ title: `checkout with ${secret}` })]);
    const result = evaluatePlaywrightJson(
      { status: "pass", code: 0, timedOut: false, stdout: JSON.stringify(report) },
      reportPath,
      ["@dogfood:AC-proof"],
      "evidence/playwright-json/report.json",
    );
    assert.equal(result.status, "fail");
    assert.equal(result.reportSource, "missing");
    assert.equal(result.accepted, false);
    assert.deepEqual(result.tags, {});
    assert.match(result.detail, /stdout is not acceptable evidence/);
    assert.equal(result.detail.includes(secret), false);
    // Stdout reaches the bundle only through the log policy, never as a second uncontrolled copy.
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("accepts a report file as evidence and republishes it redacted", () => {
  const directory = mkdtempSync(join(tmpdir(), "dogfood-adapter-"));
  try {
    const reportPath = join(directory, "report.json");
    const secret = "environment-secret-value";
    writeFileSync(reportPath, JSON.stringify(playwrightReport([playwrightSpec({ title: `checkout ${secret}` })])), "utf8");
    const result = evaluatePlaywrightJson(
      { status: "pass", code: 0, timedOut: false, stdout: "" },
      reportPath,
      ["@dogfood:AC-proof"],
      "evidence/playwright-json/report.json",
      createRedactor({ capture: "full-redacted", redactLiterals: [secret] }, {}),
    );
    assert.equal(result.status, "pass");
    assert.equal(result.reportSource, "file");
    assert.equal(result.accepted, true);
    const published = readFileSync(reportPath, "utf8");
    assert.equal(published.includes(secret), false);
    assert.match(published, /\[REDACTED\]/);
    assert.equal(JSON.parse(published).suites[0].specs[0].title, "checkout [REDACTED]");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("evaluateAdapter clears a pre-planted report so evidence can only come from the command", () => {
  const artifactDir = mkdtempSync(join(tmpdir(), "dogfood-adapter-"));
  try {
    const definition = { adapter: "playwright-json", run: "noop" };
    const planted = playwrightReport([playwrightSpec()]);
    const first = prepareAdapter("browser", definition, artifactDir);
    writeFileSync(first.reportPath, JSON.stringify(planted), "utf8");
    // A later command in the same run must not inherit the evidence an earlier one planted.
    const second = prepareAdapter("browser", definition, artifactDir);
    assert.equal(existsSync(second.reportPath), false);
    const result = evaluateAdapter(
      definition,
      { status: "pass", code: 0, timedOut: false, stdout: "1 passed (1.2s)" },
      second,
      ["@dogfood:AC-proof"],
    );
    assert.equal(result.status, "fail");
    assert.equal(result.reportSource, "missing");
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("keeps unparseable stdout out of the failure detail", () => {
  const secret = `ghp_${"S".repeat(36)}`;
  const result = evaluatePlaywrightJson(
    { status: "pass", code: 0, timedOut: false, stdout: `starting run with token ${secret}` },
    null,
    ["@dogfood:AC-proof"],
    "evidence/playwright-json/proof.report.json",
  );
  assert.equal(result.status, "fail");
  assert.equal(result.accepted, false);
  assert.equal(result.detail.includes(secret), false);
  assert.equal(result.detail.includes("SSS"), false);
  assert.match(result.detail, /PLAYWRIGHT_JSON_OUTPUT_FILE/);
  assert.match(result.detail, /not valid JSON \(SyntaxError\)/);
});
