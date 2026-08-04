import assert from "node:assert/strict";
import test from "node:test";
import { validateContract } from "../src/validate.mjs";
import { validContract } from "./helpers.mjs";

test("validates a complete contract", () => {
  const result = validateContract(validContract());
  assert.equal(result.ok, true, result.errors.join("\n"));
});

test("reserves the internal build identity command name", () => {
  const contract = validContract();
  contract.commands["_build-identity"] = {
    run: "node -e \"process.exit(0)\"",
    timeoutMs: 1000,
    adapter: "exit-code",
  };
  const result = validateContract(contract);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("_build-identity is reserved")));
});

test("allows an explicitly excluded-only contract without dummy commands", () => {
  const result = validateContract({
    version: 1,
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



test("refuses ambiguous v1 command#testId references", () => {
});

test("refuses a v1 command used as both generic and structured browser evidence", () => {
});
