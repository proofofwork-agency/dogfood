import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
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
  assert.throws(() => parseArgs(["verify"]), /requires <bundle-dir>/);
  assert.throws(() => parseArgs(["run", "--subject", "x"]), /not supported/);
  assert.equal(parseArgs(["init", "--authoritative"]).authoritative, true);
  assert.equal(parseArgs(["verify", "bundle", "--json"]).bundleDir, "bundle");
  assert.equal(parseArgs(["validate", "--policy", "policy.yaml", "--baseline-ref", "main"]).baselineRef, "main");
});

test("CLI uses exit code 3 for invalid usage", () => {
  const result = spawnSync(process.execPath, [bin, "run", "--timeout-ms", "nope"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /timeout-ms/);
});

test("version reports 0.3.0", () => {
  const result = spawnSync(process.execPath, [bin, "version"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "0.3.0");
});

test("version runs through an installed-style bin symlink", { skip: process.platform === "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "dogfood-cli-"));
  const shim = join(directory, "dogfood");
  try {
    symlinkSync(bin, shim);
    const result = spawnSync(process.execPath, [shim, "version"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "0.3.0");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
