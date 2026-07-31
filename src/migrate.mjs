import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { stringify as stringifyYaml } from "yaml";
import { loadContract } from "./load-contract.mjs";
import { validateContract } from "./validate.mjs";

export class MigrationError extends Error {
  constructor(message) {
    super(message);
    this.name = "MigrationError";
  }
}

export function migrateContractV1(contract) {
  if (contract?.version === 2) {
    throw new MigrationError("Contract is already version 2; no migration is needed.");
  }
  if (contract?.version !== 1) {
    throw new MigrationError(`Expected a version 1 contract (got ${JSON.stringify(contract?.version)}).`);
  }
  if (typeof contract.project !== "string" || contract.project.trim() === "") {
    throw new MigrationError("Cannot migrate a v1 contract without a project name.");
  }
  if (!Array.isArray(contract.acceptanceCriteria) || contract.acceptanceCriteria.length === 0) {
    throw new MigrationError("Cannot migrate: acceptanceCriteria must be a non-empty array.");
  }

  const v1Commands = contract.commands &&
      typeof contract.commands === "object" &&
      !Array.isArray(contract.commands)
    ? contract.commands
    : {};
  const commandAdapters = new Map(Object.keys(v1Commands).map((name) => [name, "exit-code"]));
  const oracleKindsByCommand = new Map();
  const ids = new Set();
  for (const criterion of contract.acceptanceCriteria || []) {
    if (!criterion || typeof criterion !== "object" || Array.isArray(criterion)) {
      throw new MigrationError("Cannot migrate an invalid acceptance criterion entry.");
    }
    if (criterion?.id && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(criterion.id)) {
      throw new MigrationError(
        `Acceptance criterion id "${criterion.id}" is not valid in v2; rename it to a stable id using letters, numbers, dots, underscores, or hyphens.`,
      );
    }
    if (criterion?.id && ids.has(criterion.id)) {
      throw new MigrationError(`Cannot migrate duplicate acceptance criterion id: ${criterion.id}`);
    }
    if (criterion?.id) ids.add(criterion.id);
    if (!["deterministic", "judgmental", "excluded"].includes(criterion.class)) {
      throw new MigrationError(
        `Cannot migrate ${criterion.id || "acceptance criterion"}: unsupported class "${criterion.class}".`,
      );
    }
    if (criterion.class === "excluded" && !String(criterion.reason || "").trim()) {
      throw new MigrationError(
        `Cannot migrate excluded criterion ${criterion.id || "(missing id)"} without a reason.`,
      );
    }
    if (criterion.class !== "excluded" && (!criterion.oracle?.kind || !criterion.oracle?.ref)) {
      throw new MigrationError(
        `Cannot migrate ${criterion.id || "acceptance criterion"}: missing oracle mapping.`,
      );
    }
    const ref = criterion?.oracle?.ref;
    if (typeof ref === "string" && ref.includes("#")) {
      throw new MigrationError(
        `Cannot migrate ambiguous oracle reference "${ref}" for ${criterion.id || "an acceptance criterion"}. ` +
          "Remove the # reference, configure the command with adapter=playwright-json, and add an exact " +
          `Playwright tag such as @dogfood:${criterion.id || "AC-ID"}.`,
      );
    }
    if (
      criterion.class === "deterministic" &&
      ["command", "arch", "journey"].includes(criterion?.oracle?.kind)
    ) {
      if (!Object.hasOwn(v1Commands, ref)) {
        throw new MigrationError(
          `Cannot migrate ${criterion.id || "acceptance criterion"}: oracle references unknown command "${ref}".`,
        );
      }
      const family = criterion.oracle.kind === "journey" ? "playwright-json" : "exit-code";
      const families = oracleKindsByCommand.get(ref) || new Set();
      families.add(family);
      oracleKindsByCommand.set(ref, families);
      if (families.size > 1) {
        throw new MigrationError(
          `Cannot migrate command "${ref}" as both generic exit-code and structured Playwright evidence. ` +
            "Split the v1 command into two named v2 commands and migrate again.",
        );
      }
      commandAdapters.set(ref, family);
    }
  }

  const commands = {};
  for (const [name, definition] of Object.entries(v1Commands)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      throw new MigrationError(`Command name "${name}" is not valid in v2; rename it before migrating.`);
    }
    const run = typeof definition === "string" ? definition : definition?.run;
    if (!run) throw new MigrationError(`Command "${name}" has no runnable command string.`);
    commands[name] = {
      run,
      timeoutMs: Number.isInteger(definition?.timeoutMs) ? definition.timeoutMs : 120000,
      adapter: commandAdapters.get(name) || "exit-code",
    };
  }

  const oracles = {};
  const acceptanceCriteria = [];
  const usedOracleNames = new Set();
  for (const [index, criterion] of (contract.acceptanceCriteria || []).entries()) {
    const converted = {
      id: criterion.id || `AC-${index + 1}`,
      ...(criterion.issue ? { issue: criterion.issue } : {}),
      ...(criterion.text ? { text: criterion.text } : {}),
      class: criterion.class,
      severity: criterion.severity || "major",
    };
    if (criterion.class === "excluded") {
      converted.reason = criterion.reason;
      acceptanceCriteria.push(converted);
      continue;
    }

    const oldOracle = criterion.oracle;
    if (oldOracle?.kind && oldOracle?.ref) {
      const name = uniqueOracleName(`oracle-${safeName(converted.id)}`, usedOracleNames);
      if (criterion.class === "judgmental") {
        oracles[name] = { kind: "advisory" };
      } else if (["command", "arch"].includes(oldOracle.kind)) {
        oracles[name] = { kind: "command", command: oldOracle.ref };
      } else if (oldOracle.kind === "journey") {
        oracles[name] = {
          kind: "playwright",
          command: oldOracle.ref,
          tag: `@dogfood:${converted.id}`,
        };
      } else if (["manual", "file"].includes(oldOracle.kind)) {
        oracles[name] = { kind: "advisory" };
      } else {
        throw new MigrationError(
          `Cannot migrate unsupported v1 oracle kind "${oldOracle.kind}" for ${converted.id}.`,
        );
      }
      converted.oracle = name;
    }
    acceptanceCriteria.push(converted);
  }

  const gates = {};
  for (const [name, values] of Object.entries(contract.gates || {})) {
    if (Array.isArray(values) && values.length > 0) gates[name] = values;
  }
  if (Object.keys(gates).length === 0 && Object.keys(commands).length > 0) {
    gates.verification = Object.keys(commands);
  }

  const migrated = {
    version: 2,
    project: contract.project,
    ...(contract.description ? { description: contract.description } : {}),
    build: {
      requireIdentity: Boolean(contract.build?.requireIdentity),
      ...(contract.build?.identityCommand
        ? { identityCommand: contract.build.identityCommand }
        : {}),
    },
    commands,
    gates,
    oracles,
    acceptanceCriteria,
  };
  const validation = validateContract(migrated);
  if (!validation.ok) {
    throw new MigrationError(
      `Migrated contract would not be valid v2: ${validation.errors.join("; ")}`,
    );
  }
  return migrated;
}

export function migrateContractFile(contractPath, { write = false } = {}) {
  const contract = loadContract(contractPath);
  const migrated = migrateContractV1(contract);
  const yaml = stringifyYaml(migrated, { lineWidth: 0 });
  if (!write) return { yaml, backupPath: null };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${contractPath}.v1-backup-${stamp}`;
  copyFileSync(contractPath, backupPath);
  try {
    writeFileSync(contractPath, yaml, "utf8");
  } catch (error) {
    writeFileSync(contractPath, readFileSync(backupPath), "utf8");
    throw error;
  }
  return { yaml, backupPath };
}

function safeName(value) {
  const safe = String(value).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+/, "");
  return safe || "criterion";
}

function uniqueOracleName(base, used) {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base}-${suffix++}`;
  used.add(candidate);
  return candidate;
}
