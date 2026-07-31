import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CliUsageError, parseArgs } from "../bin/dogfood.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "bin", "dogfood.mjs");

test("strict CLI parsing rejects unsupported commands and arguments", () => {
  assert.throws(() => parseArgs(["unknown"]), CliUsageError);
  assert.throws(() => parseArgs(["run", "--wat"]), CliUsageError);
  assert.throws(() => parseArgs(["run", "--cwd"]), /Missing value/);
  assert.throws(() => parseArgs(["run", "--timeout-ms", "0"]), /1 to 3600000/);
  assert.throws(() => parseArgs(["validate", "--evidence", "x.json"]), /not supported/);
});

test("CLI uses exit code 3 for invalid usage", () => {
  const result = spawnSync(process.execPath, [bin, "run", "--timeout-ms", "nope"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /timeout-ms/);
});

test("version reports 0.2.0", () => {
  const result = spawnSync(process.execPath, [bin, "version"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "0.2.0");
});

test("the planted missing-oracle fixture exits 1", () => {
  const result = spawnSync(
    process.execPath,
    [bin, "validate", "--cwd", join(root, "examples", "minimal-broken"), "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.validation.errors.some((error) => /missing oracle/i.test(error)));
});
