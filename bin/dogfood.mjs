#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ContractInputError, findContractPath } from "../src/load-contract.mjs";
import { migrateContractFile, MigrationError } from "../src/migrate.mjs";
import { exitCodeForVerdict, initProject, PACKAGE_ROOT, runDogfood } from "../src/run.mjs";

const COMMANDS = new Set(["help", "version", "init", "validate", "run", "report", "migrate"]);
const OPTION_SPECS = {
  "--cwd": { key: "cwd", value: true, commands: ["init", "validate", "run", "report", "migrate"] },
  "--contract": { key: "contract", value: true, commands: ["validate", "run", "migrate"] },
  "--json": { key: "json", value: false, commands: ["validate", "run"] },
  "--force": { key: "force", value: false, commands: ["init"] },
  "--write": { key: "write", value: false, commands: ["migrate"] },
  "--timeout-ms": { key: "timeoutMs", value: true, commands: ["run"] },
  "--evidence": { key: "evidence", value: true, repeat: true, commands: ["run"] },
};

export class CliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliUsageError";
  }
}

export function parseArgs(argv, currentDirectory = process.cwd()) {
  const rest = [...argv];
  let command = rest.shift() || "help";
  if (command === "--help" || command === "-h") command = "help";
  if (command === "--version") command = "version";
  if (!COMMANDS.has(command)) throw new CliUsageError(`Unsupported command: ${command}`);

  const args = {
    command,
    cwd: resolve(currentDirectory),
    contract: null,
    json: false,
    force: false,
    write: false,
    timeoutMs: null,
    evidence: [],
  };
  const seen = new Set();
  while (rest.length > 0) {
    const option = rest.shift();
    if (option === "--help" || option === "-h") {
      if (rest.length > 0) throw new CliUsageError("--help does not accept trailing arguments");
      return { ...args, command: "help" };
    }
    if (!Object.hasOwn(OPTION_SPECS, option)) {
      throw new CliUsageError(`Unknown argument: ${option}`);
    }
    const spec = OPTION_SPECS[option];
    if (!spec.commands.includes(command)) {
      throw new CliUsageError(`${option} is not supported by dogfood ${command}`);
    }
    if (!spec.repeat && seen.has(option)) {
      throw new CliUsageError(`Argument may only be supplied once: ${option}`);
    }
    seen.add(option);
    if (!spec.value) {
      args[spec.key] = true;
      continue;
    }
    const value = rest.shift();
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(`Missing value for ${option}`);
    }
    if (value.length === 0) throw new CliUsageError(`Missing value for ${option}`);
    if (spec.repeat) args[spec.key].push(value);
    else args[spec.key] = value;
  }

  args.cwd = resolve(currentDirectory, args.cwd);
  if (args.timeoutMs !== null) {
    const value = Number(args.timeoutMs);
    if (!Number.isSafeInteger(value) || value < 1 || value > 3600000) {
      throw new CliUsageError("--timeout-ms must be an integer from 1 to 3600000");
    }
    args.timeoutMs = value;
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      console.error(error.message);
      console.error("Run `dogfood help` for usage.");
      return 3;
    }
    throw error;
  }

  if (args.command === "help") {
    printHelp();
    return 0;
  }
  if (args.command === "version") {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
    console.log(pkg.version);
    return 0;
  }

  try {
    if (args.command === "init") {
      const result = await initProject(args.cwd, { force: args.force });
      console.log(`Initialized Dogfood v2 in ${args.cwd}`);
      console.log(`Contract: ${result.contractPath}`);
      for (const skill of result.skillDests) console.log(`Agent skill: ${skill}`);
      console.log("The generated contract is intentionally incomplete; map its oracle before running.");
      return 0;
    }

    if (args.command === "migrate") {
      const contractPath = findContractPath(args.cwd, args.contract);
      const result = migrateContractFile(contractPath, { write: args.write });
      if (args.write) {
        console.log(`Migrated contract in place: ${contractPath}`);
        console.log(`Backup: ${result.backupPath}`);
      } else {
        process.stdout.write(result.yaml);
      }
      return 0;
    }

    if (args.command === "report") {
      return printLatestReport(args.cwd);
    }

    const { report, artifactDir, contractPath } = await runDogfood({
      cwd: args.cwd,
      contract: args.contract,
      validateOnly: args.command === "validate",
      timeoutMs: args.timeoutMs,
      evidence: args.evidence,
    });
    if (args.json) {
      console.log(JSON.stringify({ ...report, artifactDir, contractPath }, null, 2));
    } else {
      printResult(report, artifactDir, contractPath);
    }
    return exitCodeForVerdict(report.verdict);
  } catch (error) {
    if (error instanceof ContractInputError || error instanceof MigrationError) {
      console.error(error.message);
      return 1;
    }
    if (args.command === "init" && error instanceof Error) {
      console.error(error.message);
      return 1;
    }
    console.error(`Unexpected Dogfood runner error: ${error.message || error}`);
    if (process.env.DOGFOOD_DEBUG) console.error(error);
    return 4;
  }
}

function printLatestReport(cwd) {
  const artifactRoot = resolve(cwd, "artifacts", "dogfood");
  const latestPath = join(artifactRoot, "latest.json");
  if (!existsSync(latestPath)) {
    console.error("No artifacts/dogfood/latest.json — run `dogfood run` first.");
    return 1;
  }
  let latest;
  try {
    latest = JSON.parse(readFileSync(latestPath, "utf8"));
  } catch (error) {
    console.error(`Could not read latest report pointer: ${error.message}`);
    return 1;
  }
  if (!latest.path || isAbsolute(latest.path)) {
    console.error("latest.json does not contain a portable relative run path.");
    return 1;
  }
  const runDirectory = resolve(artifactRoot, latest.path);
  if (!inside(artifactRoot, runDirectory)) {
    console.error("latest.json run path escapes artifacts/dogfood.");
    return 1;
  }
  const summary = join(runDirectory, "summary.md");
  if (!existsSync(summary)) {
    console.error(`Latest summary is missing: ${summary}`);
    return 1;
  }
  console.log(readFileSync(summary, "utf8"));
  return 0;
}

function printResult(report, artifactDir, contractPath) {
  console.log(`Dogfood ${report.verdict} — ${report.project}`);
  console.log(`Contract: ${contractPath}`);
  console.log(`Artifacts: ${artifactDir}`);
  if (report.validation.errors.length > 0) {
    console.log("\nContract errors:");
    for (const error of report.validation.errors) console.log(`  ✗ ${error}`);
  }
  if (report.validation.warnings.length > 0) {
    console.log("\nWarnings:");
    for (const warning of report.validation.warnings) console.log(`  ! ${warning}`);
  }
  console.log("\nAcceptance criteria:");
  for (const criterion of report.acceptanceCriteria) {
    const mark = criterion.verdict === "pass"
      ? "✓"
      : ["advisory", "excluded", "not-run"].includes(criterion.verdict)
        ? "·"
        : "✗";
    console.log(`  ${mark} [${criterion.verdict}] ${criterion.id} — ${criterion.detail}`);
  }
  if (report.commands.length > 0) {
    console.log("\nCommands:");
    for (const command of report.commands) {
      const mark = command.status === "pass" ? "✓" : "✗";
      console.log(`  ${mark} ${command.name} (${command.status}, ${command.durationMs}ms)`);
    }
  }
  console.log("\nNext steps:");
  for (const step of report.nextSteps) console.log(`  → ${step}`);
  console.log(`\nSummary: ${join(artifactDir, "summary.md")}`);
}

function printHelp() {
  console.log(`
dogfood — portable evidence gate

Usage:
  dogfood init [--cwd dir] [--force]
  dogfood validate [--cwd dir] [--contract path] [--json]
  dogfood run [--cwd dir] [--contract path] [--json] [--timeout-ms n]
              [--evidence advisory-receipt.json ...]
  dogfood migrate [--cwd dir] [--contract path] [--write]
  dogfood report [--cwd dir]
  dogfood version
  dogfood help

Exit codes:
  0  PASS
  1  FAIL (invalid contract, failed proof, missing evidence, or mutation)
  2  INFRA_ERROR
  3  Invalid CLI usage
  4  Unexpected internal runner error

Missing oracle = FAIL. Verification never repairs product code or tests.
`);
}

function inside(root, candidate) {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(prefix);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  process.exitCode = await main();
}
