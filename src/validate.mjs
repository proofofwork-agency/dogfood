import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatAjvError } from "./ajv-errors.mjs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const contractSchema = JSON.parse(
  readFileSync(join(moduleDir, "..", "schemas", "contract.schema.json"), "utf8"),
);
const receiptSchema = JSON.parse(
  readFileSync(join(moduleDir, "..", "schemas", "advisory-receipt.schema.json"), "utf8"),
);

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateContractSchema = ajv.compile(contractSchema);
const validateReceiptSchema = ajv.compile(receiptSchema);

export function validateContract(contract) {
  const errors = [];
  const warnings = [];
  if (!validateContractSchema(contract)) {
    errors.push(...validateContractSchema.errors.map((error) => formatAjvError(error, "contract")));
  }

  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    return { ok: false, errors: unique(errors), warnings };
  }

  const commands = contract.commands && typeof contract.commands === "object"
    ? contract.commands
    : {};
  const oracles = contract.oracles && typeof contract.oracles === "object"
    ? contract.oracles
    : {};
  const criteria = Array.isArray(contract.acceptanceCriteria)
    ? contract.acceptanceCriteria
    : [];

  if (typeof contract.project === "string" && contract.project.trim() === "") {
    errors.push("project must not be blank");
  }
  if (typeof contract.build?.identityCommand === "string" && contract.build.identityCommand.trim() === "") {
    errors.push("build.identityCommand must not be blank");
  }
  if (typeof contract.build?.subject?.path === "string" && contract.build.subject.path.trim() === "") {
    errors.push("build.subject.path must not be blank");
  }

  for (const [name, definition] of Object.entries(commands)) {
    if (typeof definition?.run === "string" && definition.run.trim() === "") {
      errors.push(`commands.${name}.run must not be blank`);
    }
  }

  for (const [gate, names] of Object.entries(contract.gates || {})) {
    if (!Array.isArray(names)) continue;
    for (const name of names) {
      if (!Object.hasOwn(commands, name)) {
        errors.push(`gates.${gate} references unknown command "${name}"`);
      }
    }
  }

  for (const [name, oracle] of Object.entries(oracles)) {
    if (!oracle || typeof oracle !== "object") continue;
    if (oracle.kind === "command" || oracle.kind === "playwright") {
      if (!Object.hasOwn(commands, oracle.command)) {
        errors.push(`oracles.${name} references unknown command "${oracle.command}"`);
        continue;
      }
      const expectedAdapter = oracle.kind === "command" ? "exit-code" : "playwright-json";
      if (commands[oracle.command]?.adapter !== expectedAdapter) {
        errors.push(
          `oracles.${name} kind=${oracle.kind} requires commands.${oracle.command}.adapter=${expectedAdapter}`,
        );
      }
    }
  }

  const ids = new Set();
  const deterministicPlaywrightCommands = new Set();
  const deterministicCommands = new Set();
  for (const [index, criterion] of criteria.entries()) {
    if (!criterion || typeof criterion !== "object") continue;
    const label = criterion.id || `acceptanceCriteria[${index}]`;
    if (criterion.id) {
      if (ids.has(criterion.id)) {
        errors.push(`duplicate acceptance criterion id: ${criterion.id}`);
      }
      ids.add(criterion.id);
    }

    if (criterion.class === "deterministic" || criterion.class === "judgmental") {
      if (!criterion.oracle) {
        errors.push(`${label}: missing oracle (missing oracle = FAIL)`);
      } else if (!Object.hasOwn(oracles, criterion.oracle)) {
        errors.push(`${label}: references unknown oracle "${criterion.oracle}"`);
      } else if (
        criterion.class === "deterministic" &&
        oracles[criterion.oracle]?.kind === "advisory"
      ) {
        errors.push(`${label}: deterministic criteria cannot use an advisory oracle`);
      } else if (
        criterion.class === "judgmental" &&
        oracles[criterion.oracle]?.kind !== "advisory"
      ) {
        errors.push(`${label}: judgmental criteria must use an advisory oracle`);
      }
      if (criterion.class === "deterministic" && oracles[criterion.oracle]?.command) {
        deterministicCommands.add(oracles[criterion.oracle].command);
      }
      if (
        criterion.class === "deterministic" &&
        oracles[criterion.oracle]?.kind === "playwright"
      ) {
        const playwrightOracle = oracles[criterion.oracle];
        deterministicPlaywrightCommands.add(playwrightOracle.command);
        if (playwrightOracle.tag !== `@dogfood:${criterion.id}`) {
          errors.push(
            `${label}: Playwright oracle tag must be exactly @dogfood:${criterion.id}`,
          );
        }
      }
    }

    if (criterion.class === "excluded" && String(criterion.reason || "").trim() === "") {
      errors.push(`${label}: excluded criteria require reason`);
    }
  }

  const gatedCommands = new Set(Object.values(contract.gates || {}).flatMap((names) =>
    Array.isArray(names) ? names : [],
  ));
  for (const name of gatedCommands) {
    if (
      commands[name]?.adapter === "playwright-json" &&
      !deterministicPlaywrightCommands.has(name)
    ) {
      errors.push(
        `commands.${name} uses playwright-json in a gate but has no deterministic Playwright oracle tag`,
      );
    }
    if (Object.hasOwn(commands, name) && !deterministicCommands.has(name)) {
      warnings.push(
        `gated command "${name}" has no deterministic acceptance-criterion mapping; it remains a hard project-level check`,
      );
    }
  }

  if (gatedCommands.size === 0 && deterministicCommands.size > 0) {
    warnings.push(
      "gates is empty; commands referenced by deterministic oracles will still run",
    );
  }

  for (const name of Object.keys(commands)) {
    if (!gatedCommands.has(name) && !deterministicCommands.has(name)) {
      warnings.push(`commands.${name} is not used by a gate or deterministic oracle`);
    }
  }

  const referencedOracles = new Set(criteria.map((criterion) => criterion?.oracle).filter(Boolean));
  for (const name of Object.keys(oracles)) {
    if (!referencedOracles.has(name)) {
      warnings.push(`oracles.${name} is not referenced by an acceptance criterion`);
    }
  }

  return { ok: errors.length === 0, errors: unique(errors), warnings: unique(warnings) };
}

export function validateAdvisoryReceipt(receipt) {
  const ok = validateReceiptSchema(receipt);
  return {
    ok,
    errors: ok
      ? []
      : unique(validateReceiptSchema.errors.map((error) => formatAjvError(error, "receipt"))),
  };
}


function unique(values) {
  return [...new Set(values)];
}
