import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluatePlaywrightJson, evaluatePlaywrightTag } from "../src/adapters.mjs";
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

test("persists a standalone Playwright JSON stdout fallback when the report file is absent", () => {
  const directory = mkdtempSync(join(tmpdir(), "dogfood-adapter-"));
  try {
    const reportPath = join(directory, "report.json");
    const report = playwrightReport([playwrightSpec()]);
    const result = evaluatePlaywrightJson(
      { status: "pass", code: 0, timedOut: false, stdout: JSON.stringify(report) },
      reportPath,
      ["@dogfood:AC-proof"],
      "evidence/playwright-json/report.json",
    );
    assert.equal(result.status, "pass");
    assert.equal(result.reportSource, "stdout-fallback");
    assert.ok(existsSync(reportPath));
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")).stats, {});
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
