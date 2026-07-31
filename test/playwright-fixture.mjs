import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "examples", "playwright");
const bin = join(root, "bin", "dogfood.mjs");

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

const passing = run();
assert.equal(passing.status, 0, passing.stdout + passing.stderr);
assert.equal(parse(passing).verdict, "PASS");

const plantedFailure = run({ DOGFOOD_FIXTURE_PRODUCT_FAILURE: "1" });
assert.equal(plantedFailure.status, 1, plantedFailure.stdout + plantedFailure.stderr);
const failureReport = parse(plantedFailure);
assert.equal(failureReport.verdict, "FAIL");
assert.equal(
  failureReport.acceptanceCriteria.find((criterion) => criterion.id === "AC-checkout").verdict,
  "fail",
);

// Leave a genuine PASS as the stable latest report used by CI publication.
const finalPassing = run();
assert.equal(finalPassing.status, 0, finalPassing.stdout + finalPassing.stderr);
const finalReport = parse(finalPassing);
copyFileSync(
  join(finalReport.artifactDir, "junit.xml"),
  join(fixture, "artifacts", "dogfood", "junit.xml"),
);
const latest = JSON.parse(
  readFileSync(join(fixture, "artifacts", "dogfood", "latest.json"), "utf8"),
);
assert.equal(latest.path, finalReport.runId);

console.log("neutral Playwright fixture: PASS, planted FAIL, final PASS");
