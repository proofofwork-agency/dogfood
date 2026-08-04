import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CliUsageError, parseArgs } from "../bin/dogfood.mjs";
import { runDogfood } from "../src/run.mjs";
import { createProject, git, validContract } from "./helpers.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "bin", "dogfood.mjs");
const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

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

test("--baseline-ref cannot smuggle a leading-dash Git option", () => {
  assert.throws(() => parseArgs(["run", "--baseline-ref", "-x"]), CliUsageError);
  assert.throws(() => parseArgs(["run", "--baseline-ref", "--output=/tmp/pwn"]), CliUsageError);
  assert.equal(parseArgs(["run", "--baseline-ref", "main"]).baselineRef, "main");
});

test("CLI uses exit code 3 for invalid usage", () => {
  const result = spawnSync(process.execPath, [bin, "run", "--timeout-ms", "nope"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /timeout-ms/);
});

test("CLI help exposes every command and security-sensitive signing option", () => {
  const result = spawnSync(process.execPath, [bin, "help"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  for (const command of ["init", "validate", "run", "verify", "keygen", "report", "version", "help"]) {
    assert.match(result.stdout, new RegExp(`\\bdogfood ${command}\\b`), command);
  }
  for (const option of ["--sign", "--key", "--out", "--force"]) {
    assert.ok(result.stdout.includes(option), option);
  }
});

test("version reports the packaged version", () => {
  const result = spawnSync(process.execPath, [bin, "version"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), packageVersion);
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
    assert.equal(result.stdout.trim(), packageVersion);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("report refuses a validate-only pointer and carries the verdict in its exit code", async () => {
  const cwd = createProject(validContract());
  const report = () => spawnSync(process.execPath, [bin, "report", "--cwd", cwd], { encoding: "utf8" });

  await runDogfood({ cwd, validateOnly: true });
  const noProof = report();
  assert.equal(noProof.status, 1, noProof.stdout);
  assert.match(noProof.stderr, /latest-validate\.json/);

  // A pre-fix pointer has no mode field, so provenance has to come from the verdict itself.
  const { report: proof } = await runDogfood({ cwd });
  assert.equal(proof.verdict, "PASS");
  const latestPath = join(cwd, "artifacts", "dogfood", "latest.json");
  const latest = JSON.parse(readFileSync(latestPath, "utf8"));
  const passing = report();
  assert.equal(passing.status, 0, passing.stderr);
  assert.match(passing.stdout, /\*\*Verdict:\*\* PASS/);

  writeFileSync(latestPath, JSON.stringify({ ...latest, mode: undefined, verdict: "VALID" }));
  const disguised = report();
  assert.equal(disguised.status, 1, disguised.stdout);
  assert.match(disguised.stderr, /validate-only bundle/);

  writeFileSync(latestPath, JSON.stringify({ ...latest, verdict: "FAIL" }));
  const pointerMismatch = report();
  assert.equal(pointerMismatch.status, 1);
  assert.match(pointerMismatch.stderr, /metadata disagrees/);

  writeFileSync(latestPath, JSON.stringify(latest));
  writeFileSync(join(cwd, "artifacts", "dogfood", latest.path, "summary.md"), "tampered\n");
  const tampered = report();
  assert.equal(tampered.status, 1);
  assert.match(tampered.stderr, /integrity verification/);
});

test("report resolves the pointer target through real paths", { skip: process.platform === "win32" }, async () => {
  const cwd = createProject(validContract());
  await runDogfood({ cwd });
  const outside = mkdtempSync(join(tmpdir(), "dogfood-report-outside-"));
  try {
    const root = join(cwd, "artifacts", "dogfood");
    symlinkSync(outside, join(root, "escape"));
    writeFileSync(join(root, "latest.json"), JSON.stringify({
      path: "escape",
      runId: "escape",
      mode: "run",
      verdict: "PASS",
    }));
    const result = spawnSync(process.execPath, [bin, "report", "--cwd", cwd], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /escapes artifacts\/dogfood/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("report warns when the proven commit is no longer the workspace commit", async () => {
  const cwd = createProject(validContract());
  await runDogfood({ cwd });
  const fresh = spawnSync(process.execPath, [bin, "report", "--cwd", cwd], { encoding: "utf8" });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(/Stale:/.test(fresh.stderr), false, fresh.stderr);

  writeFileSync(join(cwd, "moved.txt"), "moved\n");
  git(cwd, ["add", "moved.txt"]);
  git(cwd, ["commit", "-qm", "move the workspace on"]);
  const stale = spawnSync(process.execPath, [bin, "report", "--cwd", cwd], { encoding: "utf8" });
  assert.match(stale.stderr, /Stale: the proof ran at commit [0-9a-f]+, but the workspace is now at [0-9a-f]+/);
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
