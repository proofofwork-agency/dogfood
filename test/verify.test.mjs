import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runDogfood } from "../src/run.mjs";
import { verifyBundle } from "../src/verify.mjs";
import { stringify as stringifyYaml } from "yaml";
import { authoritativePolicy, createProject, git, validContract } from "./helpers.mjs";

test("verifies a complete v3 bundle and requires its declared subject", async () => {
  const contract = validContract({ build: { requireIdentity: true, subject: { path: "dist/app.bin", algorithm: "sha256" } } });
  const cwd = createProject(contract, { "dist/app.bin": "build-subject\n" });
  const { artifactDir } = await runDogfood({ cwd });
  assert.equal(verifyBundle(artifactDir).ok, false);
  const verified = verifyBundle(artifactDir, { subject: "dist/app.bin", cwd });
  assert.equal(verified.ok, true, verified.errors.join("\n"));
  writeFileSync(join(cwd, "dist", "wrong.bin"), "wrong\n");
  assert.equal(verifyBundle(artifactDir, { subject: "dist/wrong.bin", cwd }).ok, false);
});

test("detects altered, missing, and unrecorded bundle files", async () => {
  const cwd = createProject();
  const first = await runDogfood({ cwd });
  writeFileSync(join(first.artifactDir, "summary.md"), "tampered\n");
  assert.ok(verifyBundle(first.artifactDir).errors.some((error) => error.includes("checksum mismatch")));

  const second = await runDogfood({ cwd });
  rmSync(join(second.artifactDir, "matrix.json"));
  assert.ok(verifyBundle(second.artifactDir).errors.some((error) => error.includes("missing")));

  const third = await runDogfood({ cwd });
  writeFileSync(join(third.artifactDir, "extra.txt"), "extra\n");
  assert.ok(verifyBundle(third.artifactDir).errors.some((error) => error.includes("unrecorded")));
});

test("temp-named files are never exempt from the unrecorded-file check", async () => {
  const cwd = createProject();
  const { artifactDir } = await runDogfood({ cwd });
  assert.equal(verifyBundle(artifactDir).ok, true);
  mkdirSync(join(artifactDir, "evidence", ".tmp-x"), { recursive: true });
  writeFileSync(join(artifactDir, "evidence", ".tmp-x", "payload.json"), "{}\n");
  writeFileSync(join(artifactDir, "summary.json.tmp-1-abc"), "{}\n");
  const { errors } = verifyBundle(artifactDir);
  assert.ok(errors.includes("unrecorded file is present in bundle: evidence/.tmp-x/payload.json"), errors.join("\n"));
  assert.ok(errors.includes("unrecorded file is present in bundle: summary.json.tmp-1-abc"), errors.join("\n"));
});

test("names that collapse onto a recorded file under realpath are still unrecorded", { skip: process.platform === "win32" }, async () => {
  const cwd = createProject();
  const { artifactDir } = await runDogfood({ cwd });
  assert.equal(verifyBundle(artifactDir).ok, true);
  // Each of these re-derived to an already-recorded name, so the sweep stayed silent.
  const planted = ["\\summary.json", ".\\junit.xml", "summary.json ", "matrix.json\t"];
  for (const name of planted) writeFileSync(join(artifactDir, name), "PAYLOAD\n");
  writeFileSync(join(artifactDir, "commands", "proof", "stdout.log\\"), "PAYLOAD\n");
  const { ok, errors } = verifyBundle(artifactDir);
  assert.equal(ok, false);
  for (const name of [...planted, "commands/proof/stdout.log\\"]) {
    assert.ok(errors.includes(`unrecorded file is present in bundle: ${name}`), `${name}: ${errors.join("\n")}`);
  }
});

test("an empty directory planted in a bundle is not invisible", async () => {
  const cwd = createProject();
  const { artifactDir } = await runDogfood({ cwd });
  assert.equal(verifyBundle(artifactDir).ok, true);
  mkdirSync(join(artifactDir, "ghost-dir", "nested-empty"), { recursive: true });
  const { ok, errors } = verifyBundle(artifactDir);
  assert.equal(ok, false);
  assert.ok(errors.includes("unrecorded directory is present in bundle: ghost-dir/nested-empty"), errors.join("\n"));
});

test("a hardlinked bundle file warns without failing a legitimately archived bundle", async () => {
  const cwd = createProject();
  const { artifactDir } = await runDogfood({ cwd });
  // Hardlink-based copy and backup tools produce this on untouched bundles, so it cannot be an error.
  const twin = join(cwd, "twin.json");
  linkSync(join(artifactDir, "summary.json"), twin);
  const result = verifyBundle(artifactDir);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.ok(result.warnings.some((warning) => warning.includes("second hard link") && warning.includes("summary.json")), result.warnings.join("\n"));
  rmSync(twin);
});

test("an unreadable bundle subdirectory returns a verdict instead of crashing", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const cwd = createProject();
  const { artifactDir } = await runDogfood({ cwd });
  const locked = join(artifactDir, "locked");
  mkdirSync(locked);
  writeFileSync(join(locked, "x.txt"), "x\n");
  chmodSync(locked, 0o000);
  try {
    const result = verifyBundle(artifactDir);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.startsWith("bundle contents could not be enumerated:")), result.errors.join("\n"));
  } finally {
    chmodSync(locked, 0o700);
  }
});

test("detects a symlink planted inside a bundle", { skip: process.platform === "win32" }, async () => {
  const cwd = createProject();
  const { artifactDir } = await runDogfood({ cwd });
  assert.equal(verifyBundle(artifactDir).ok, true);
  mkdirSync(join(artifactDir, "evidence"), { recursive: true });
  symlinkSync(join(cwd, "check.mjs"), join(artifactDir, "evidence", "leak.mjs"));
  const result = verifyBundle(artifactDir);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.startsWith("bundle contains a non-regular file:")), result.errors.join("\n"));
});

test("detects source, normalized snapshot, policy, and report cross-check tampering", async () => {
  for (const file of ["contract.original.yaml", "contract.snapshot.yaml", "summary.json"]) {
    const cwd = createProject();
    const { artifactDir } = await runDogfood({ cwd });
    writeFileSync(join(artifactDir, file), `${readFileSync(join(artifactDir, file), "utf8")}\n# tamper\n`);
    assert.equal(verifyBundle(artifactDir).ok, false, file);
  }

  const authoritative = createProject();
  writeFileSync(join(authoritative, ".dogfood", "policy.yaml"), stringifyYaml(authoritativePolicy()));
  git(authoritative, ["add", ".dogfood/policy.yaml"]);
  git(authoritative, ["commit", "-qm", "policy"]);
  const policyRun = await runDogfood({ cwd: authoritative, policy: ".dogfood/policy.yaml" });
  writeFileSync(join(policyRun.artifactDir, "policy.original.yaml"), `${readFileSync(join(policyRun.artifactDir, "policy.original.yaml"), "utf8")}\n# tamper\n`);
  assert.equal(verifyBundle(policyRun.artifactDir).ok, false);
});

test("rejects pre-v4 bundles with rerun guidance", () => {
  const cwd = createProject();
  // v3 predates detached signing, so it is rejected exactly like v2 rather than silently accepted.
  for (const version of [2, 3]) {
    const bundle = join(cwd, `v${version}-bundle`);
    mkdirSync(bundle);
    writeFileSync(join(bundle, "manifest.json"), JSON.stringify({ version }));
    const result = verifyBundle(bundle);
    assert.equal(result.ok, false, `v${version} must not verify`);
    assert.match(result.errors[0], /rerun with Dogfood v0\.4 or newer/);
  }
});

test("exclusive run ids prevent overwrite and concurrent reuse", async () => {
  const cwd = createProject();
  await runDogfood({ cwd, runId: "exclusive" });
  await assert.rejects(runDogfood({ cwd, runId: "exclusive" }), /refusing to overwrite/);
  const concurrent = await Promise.allSettled([
    runDogfood({ cwd, runId: "concurrent" }),
    runDogfood({ cwd, runId: "concurrent" }),
  ]);
  assert.equal(concurrent.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter((item) => item.status === "rejected").length, 1);
});
