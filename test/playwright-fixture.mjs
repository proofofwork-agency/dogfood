import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "examples", "playwright");
const bin = join(root, "bin", "dogfood.mjs");

// Needs a real Chromium, so this file stays out of the npm test list.
test("the neutral Playwright fixture passes", () => {
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(parse(result).verdict, "PASS");
});

test("a planted product failure fails AC-checkout", () => {
  const result = run({ DOGFOOD_FIXTURE_PRODUCT_FAILURE: "1" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = parse(result);
  assert.equal(report.verdict, "FAIL");
  assert.equal(
    report.acceptanceCriteria.find((criterion) => criterion.id === "AC-checkout").verdict,
    "fail",
  );
});

test("latest.json points at the most recent passing run", () => {
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = parse(result);
  const latest = JSON.parse(
    readFileSync(join(fixture, "artifacts", "dogfood", "latest.json"), "utf8"),
  );
  assert.equal(latest.path, report.runId);
});

function run(extraEnv = {}) {
  return spawnSync(process.execPath, [bin, "run", "--cwd", fixture, "--json"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    timeout: 180000,
    maxBuffer: 20 * 1024 * 1024,
  });
}

function parse(result) {
  assert.ok(result.stdout, result.stderr);
  return JSON.parse(result.stdout);
}
