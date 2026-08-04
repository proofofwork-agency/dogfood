import assert from "node:assert/strict";
import test from "node:test";
import { checkPackFiles, FORBIDDEN_PREFIXES, REQUIRED_PREFIXES } from "../scripts/check-package-contents.mjs";

const CLEAN_PAYLOAD = [
  "LICENSE",
  "NOTICE",
  "README.md",
  "bin/dogfood.mjs",
  "docs/cli.md",
  "docs/licensing.md",
  "examples/minimal/.dogfood/dogfood.contract.yaml",
  "package.json",
  "schemas/contract.schema.json",
  "src/run.mjs",
  "src/verify.mjs",
  "templates/dogfood.contract.yaml",
  "templates/skill/SKILL.md",
];

const PREFIXES = { required: REQUIRED_PREFIXES, forbidden: FORBIDDEN_PREFIXES };

test("a payload that dropped the runtime source reports a violation naming src/", () => {
  const files = CLEAN_PAYLOAD.filter((file) => !file.startsWith("src/"));
  const { ok, violations } = checkPackFiles(files, PREFIXES);
  assert.equal(ok, false);
  assert.equal(violations.length, 1);
  assert.ok(violations[0].includes("src/"));
});

test("a payload leaking live credentials reports a violation naming the offending path", () => {
  const files = [...CLEAN_PAYLOAD, ".contextrelay/state/token"];
  const { ok, violations } = checkPackFiles(files, PREFIXES);
  assert.equal(ok, false);
  assert.equal(violations.length, 1);
  assert.ok(violations[0].includes(".contextrelay/"));
  assert.ok(violations[0].includes(".contextrelay/state/token"));
});

test("a complete clean payload passes with no violations", () => {
  const { ok, violations } = checkPackFiles(CLEAN_PAYLOAD, PREFIXES);
  assert.equal(ok, true);
  assert.deepEqual(violations, []);
});

test("the shipped prefix sets apply by default and normalize separators", () => {
  assert.deepEqual(checkPackFiles(CLEAN_PAYLOAD), { ok: true, violations: [] });
  const windowsPaths = ["bin\\dogfood.mjs", "test\\verify.test.mjs"];
  const { ok, violations } = checkPackFiles([...CLEAN_PAYLOAD, ...windowsPaths]);
  assert.equal(ok, false);
  assert.equal(violations.length, 1);
  assert.ok(violations[0].includes("test/verify.test.mjs"));
});
