import assert from "node:assert/strict";
import test from "node:test";
import { migrateContractV1, MigrationError } from "../src/migrate.mjs";
import { validateContract } from "../src/validate.mjs";
import { validContract } from "./helpers.mjs";

test("validates a complete v2 contract", () => {
  const result = validateContract(validContract());
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("allows an explicitly excluded-only contract without dummy commands", () => {
  const result = validateContract({
    version: 2,
    project: "excluded-only",
    commands: {},
    gates: {},
    oracles: {},
    acceptanceCriteria: [
      {
        id: "AC-out-of-scope",
        class: "excluded",
        severity: "minor",
        reason: "Owned by another independently verified component",
      },
    ],
  });
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("rejects unknown fields, invalid severities, and unsupported oracle kinds", () => {
  const contract = validContract({ surprise: true });
  contract.acceptanceCriteria[0].severity = "critical";
  contract.oracles.proof = { kind: "shell", command: "proof" };
  const result = validateContract(contract);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('unknown field "surprise"')));
  assert.ok(result.errors.some((error) => error.includes("blocker") && error.includes("major")));
  assert.ok(result.errors.some((error) => error.includes("oracles.proof")));
});

test("rejects duplicate ids, broken references, missing oracles, and excluded criteria without reasons", () => {
  const contract = validContract();
  contract.gates.verification.push("missing-command");
  contract.acceptanceCriteria.push(
    { ...contract.acceptanceCriteria[0] },
    { id: "AC-missing", class: "deterministic", severity: "major" },
    { id: "AC-excluded", class: "excluded", severity: "minor" },
  );
  contract.oracles.proof.command = "missing-command";
  const result = validateContract(contract);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("duplicate acceptance criterion id")));
  assert.ok(result.errors.some((error) => error.includes("unknown command")));
  assert.ok(result.errors.some((error) => error.includes("missing oracle")));
  assert.ok(result.errors.some((error) => error.includes("excluded criteria require reason")));
});

test("requires oracle adapter kinds to match command adapters", () => {
  const contract = validContract();
  contract.oracles.proof = {
    kind: "playwright",
    command: "proof",
    tag: "@dogfood:AC-proof",
  };
  const result = validateContract(contract);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("adapter=playwright-json")));
});

test("does not allow a gated Playwright command with no deterministic tag", () => {
  const contract = validContract();
  contract.commands.proof.adapter = "playwright-json";
  contract.oracles.proof = { kind: "advisory" };
  contract.acceptanceCriteria[0].class = "judgmental";
  const result = validateContract(contract);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("no deterministic Playwright oracle tag")));
});

test("requires judgmental criteria to use advisory oracles", () => {
  const contract = validContract();
  contract.acceptanceCriteria[0].class = "judgmental";
  const result = validateContract(contract);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("must use an advisory oracle")));
});

test("warns about empty gates, unmapped gated commands, and unused commands", () => {
  const emptyGates = validContract();
  emptyGates.gates = {};
  const emptyResult = validateContract(emptyGates);
  assert.equal(emptyResult.ok, true, emptyResult.errors.join("\n"));
  assert.ok(emptyResult.warnings.some((warning) => warning.includes("gates is empty")));

  const contract = validContract();
  contract.commands.projectCheck = {
    run: "node check.mjs",
    timeoutMs: 1000,
    adapter: "exit-code",
  };
  contract.commands.unused = {
    run: "node check.mjs",
    timeoutMs: 1000,
    adapter: "exit-code",
  };
  contract.gates.verification.push("projectCheck");
  const result = validateContract(contract);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.ok(result.warnings.some((warning) => warning.includes('gated command "projectCheck"')));
  assert.ok(result.warnings.some((warning) => warning.includes("commands.unused")));
});

test("binds deterministic Playwright tags to their acceptance criterion ids", () => {
  const contract = validContract();
  contract.commands.proof.adapter = "playwright-json";
  contract.oracles.proof = {
    kind: "playwright",
    command: "proof",
    tag: "@dogfood:AC-something-else",
  };
  const result = validateContract(contract);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("exactly @dogfood:AC-proof")));
});

test("returns a clear migration error for v1", () => {
  const result = validateContract({ version: 1, project: "old" });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /dogfood migrate/);
});

test("migrates unambiguous v1 commands and advisory oracles", () => {
  const migrated = migrateContractV1({
    version: 1,
    project: "old",
    build: { requireIdentity: true },
    commands: { check: "node check.mjs" },
    gates: { verification: ["check"] },
    acceptanceCriteria: [
      {
        id: "AC-check",
        class: "deterministic",
        severity: "major",
        oracle: { kind: "command", ref: "check" },
      },
      {
        id: "AC-review",
        class: "judgmental",
        severity: "minor",
        oracle: { kind: "manual", ref: "review.md" },
      },
    ],
  });
  assert.equal(migrated.version, 2);
  assert.equal(migrated.commands.check.adapter, "exit-code");
  assert.equal(migrated.oracles["oracle-AC-review"].kind, "advisory");
  assert.equal(validateContract(migrated).ok, true);
});

test("refuses ambiguous v1 command#testId references", () => {
  assert.throws(
    () =>
      migrateContractV1({
        version: 1,
        project: "old",
        commands: { browser: "npx playwright test" },
        gates: { browser: ["browser"] },
        acceptanceCriteria: [
          {
            id: "AC-checkout",
            class: "deterministic",
            oracle: { kind: "command", ref: "browser#checkout" },
          },
        ],
      }),
    (error) => error instanceof MigrationError && /@dogfood:AC-checkout/.test(error.message),
  );
});

test("refuses a v1 command used as both generic and structured browser evidence", () => {
  assert.throws(
    () =>
      migrateContractV1({
        version: 1,
        project: "old",
        commands: { browser: "npx playwright test" },
        gates: { browser: ["browser"] },
        acceptanceCriteria: [
          {
            id: "AC-suite",
            class: "deterministic",
            oracle: { kind: "command", ref: "browser" },
          },
          {
            id: "AC-checkout",
            class: "deterministic",
            oracle: { kind: "journey", ref: "browser" },
          },
        ],
      }),
    /both generic exit-code and structured Playwright evidence/,
  );
});

test("migrates v1 judgmental command mappings to honest advisory oracles", () => {
  const migrated = migrateContractV1({
    version: 1,
    project: "old",
    commands: { review: "node review.mjs" },
    gates: {},
    acceptanceCriteria: [
      {
        id: "AC-review",
        class: "judgmental",
        severity: "minor",
        oracle: { kind: "command", ref: "review" },
      },
    ],
  });
  assert.equal(migrated.oracles["oracle-AC-review"].kind, "advisory");
  assert.equal(validateContract(migrated).ok, true);
});
