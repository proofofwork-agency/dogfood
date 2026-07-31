import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("rejects v2 bundles with rerun guidance", () => {
  const cwd = createProject();
  const bundle = join(cwd, "v2-bundle");
  mkdirSync(bundle);
  writeFileSync(join(bundle, "manifest.json"), JSON.stringify({ version: 2 }));
  const result = verifyBundle(bundle);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /rerun with Dogfood v0\.3/);
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
