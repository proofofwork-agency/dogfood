#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ContractInputError, findContractPath } from "../src/load-contract.mjs";
import { defaultPolicyPath } from "../src/policy.mjs";
import { BundleIntegrityError } from "../src/report.mjs";
import { exitCodeForVerdict, initProject, PACKAGE_ROOT, runDogfood, RunSetupError } from "../src/run.mjs";
import { SigningError, writeKeyPair } from "../src/sign.mjs";
import { verifyBundle } from "../src/verify.mjs";

const COMMANDS = new Set(["help", "version", "init", "validate", "run", "verify", "report", "keygen"]);
const OPTION_SPECS = {
  "--cwd": { key: "cwd", value: true, commands: ["init", "validate", "run", "report"] },
  "--contract": { key: "contract", value: true, commands: ["validate", "run"] },
  "--policy": { key: "policy", value: true, commands: ["validate", "run"] },
  "--baseline-ref": { key: "baselineRef", value: true, commands: ["validate", "run"] },
  "--subject": { key: "subject", value: true, commands: ["verify"] },
  "--sign": { key: "sign", value: true, commands: ["run"] },
  "--key": { key: "key", value: true, commands: ["verify"] },
  "--out": { key: "out", value: true, commands: ["keygen"] },
  "--json": { key: "json", value: false, commands: ["validate", "run", "verify"] },
  "--force": { key: "force", value: false, commands: ["init", "keygen"] },
  "--authoritative": { key: "authoritative", value: false, commands: ["init"] },
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
    policy: null,
    baselineRef: null,
    bundleDir: null,
    subject: null,
    json: false,
    force: false,
    authoritative: false,
    write: false,
    timeoutMs: null,
    evidence: [],
    sign: null,
    key: null,
    out: null,
  };
  const seen = new Set();
  while (rest.length > 0) {
    const option = rest.shift();
    if (command === "verify" && !option.startsWith("-") && args.bundleDir === null) {
      args.bundleDir = option;
      continue;
    }
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

  if (command === "verify" && !args.bundleDir) {
    throw new CliUsageError("dogfood verify requires <bundle-dir>");
  }

  args.cwd = resolve(currentDirectory, args.cwd);
  if (args.baselineRef !== null && args.baselineRef.startsWith("-")) {
    throw new CliUsageError("--baseline-ref must not start with '-'");
  }
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
    console.log(packageVersion());
    return 0;
  }

  try {
    if (args.command === "init") {
      const result = await initProject(args.cwd, { force: args.force, authoritative: args.authoritative });
      console.log(`Initialized Dogfood v${packageVersion()} (contract v1) in ${args.cwd}`);
      console.log(`Contract: ${result.contractPath}`);
      if (result.policyPath) console.log(`Authoritative policy: ${result.policyPath}`);
      for (const skill of result.skillDests) console.log(`Agent skill: ${skill}`);
      console.log("The generated contract is intentionally incomplete; map its oracle before running.");
      // A policy is never auto-discovered, so the next command has to carry it explicitly.
      if (result.policyPath) console.log(`Next: dogfood run --policy ${defaultPolicyPath()}`);
      return 0;
    }


    if (args.command === "report") {
      return printLatestReport(args.cwd);
    }

    if (args.command === "keygen") {
      const target = resolve(args.cwd || process.cwd(), args.out || ".");
      const { privatePath, publicPath, keyId } = writeKeyPair(target, { force: args.force });
      console.log(`Private key: ${privatePath} (mode 0600 — never commit this)`);
      console.log(`Public key:  ${publicPath}`);
      console.log(`Key id:      ${keyId}`);
      console.log("Distribute the public key out of band. A key read from inside a bundle proves nothing.");
      return 0;
    }

    if (args.command === "verify") {
      const verification = verifyBundle(args.bundleDir, { subject: args.subject, key: args.key });
      if (args.json) console.log(JSON.stringify(verification, null, 2));
      else printVerification(verification);
      return verification.ok ? 0 : 1;
    }

    const abortController = new AbortController();
    const interrupt = () => abortController.abort();
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    let result;
    try {
      result = await runDogfood({
        cwd: args.cwd,
        contract: args.contract,
        policy: args.policy,
        baselineRef: args.baselineRef,
        validateOnly: args.command === "validate",
        timeoutMs: args.timeoutMs,
        evidence: args.evidence,
        sign: args.sign,
        signal: abortController.signal,
      });
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
    const { report, artifactDir, contractPath } = result;
    if (args.json) {
      console.log(JSON.stringify({ ...report, artifactDir, contractPath }, null, 2));
    } else {
      printResult(report, artifactDir, contractPath);
    }
    return exitCodeForVerdict(report.verdict);
  } catch (error) {
    if (error instanceof ContractInputError) {
      console.error(error.message);
      return 1;
    }
    if (error instanceof SigningError) {
      console.error(error.message);
      return 1;
    }
    if (error instanceof BundleIntegrityError) {
      console.error(error.message);
      return 2;
    }
    if (error instanceof RunSetupError) {
      console.error(error.message);
      if (process.env.DOGFOOD_DEBUG) console.error(error);
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
    const validated = existsSync(join(artifactRoot, "latest-validate.json"))
      ? " The last `dogfood validate` wrote artifacts/dogfood/latest-validate.json, which records no executed proof."
      : "";
    console.error(`No artifacts/dogfood/latest.json — run \`dogfood run\` first.${validated}`);
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
  // A VALID/INVALID verdict is only reachable in validate mode, so a pointer written by an
  // older Dogfood that had no mode field is still recognised and never served as the proof.
  if (latest.mode === "validate" || ["VALID", "INVALID"].includes(latest.verdict)) {
    console.error(`artifacts/dogfood/latest.json points at a validate-only bundle (${latest.runId || latest.path}); no proof was executed. Run \`dogfood run\`.`);
    return 1;
  }
  const runDirectory = resolve(artifactRoot, latest.path);
  const artifactRootReal = realPathOrNull(artifactRoot);
  const runDirectoryReal = realPathOrNull(runDirectory);
  if (!artifactRootReal || !runDirectoryReal) {
    console.error("latest.json run path is missing or unreadable.");
    return 1;
  }
  if (!inside(artifactRootReal, runDirectoryReal)) {
    console.error("latest.json run path escapes artifacts/dogfood.");
    return 1;
  }
  const verification = verifyBundle(runDirectoryReal, { cwd, requireSubject: false });
  if (!verification.ok) {
    console.error("Latest bundle failed integrity verification:");
    for (const error of verification.errors) console.error(`  - ${error}`);
    return 1;
  }
  let report;
  try {
    report = JSON.parse(readFileSync(join(runDirectoryReal, "summary.json"), "utf8"));
  } catch (error) {
    console.error(`Latest summary metadata is unreadable: ${error.message}`);
    return 1;
  }
  if (report.mode !== "run") {
    console.error(`latest.json points at a ${report.mode || "non-run"} bundle; no proof was executed.`);
    return 1;
  }
  if ((latest.runId && latest.runId !== report.runId) ||
      (latest.verdict && latest.verdict !== report.verdict)) {
    console.error("latest.json metadata disagrees with the verified bundle.");
    return 1;
  }
  const summary = join(runDirectoryReal, "summary.md");
  if (!existsSync(summary)) {
    console.error(`Latest summary is missing: ${summary}`);
    return 1;
  }
  console.log(readFileSync(summary, "utf8"));
  console.error(`! Bundle: ${verification.verdict}; signature=${verification.signatureStatus}. ${verification.notice}`);
  for (const warning of [...verification.warnings, ...provenanceWarnings(cwd, runDirectoryReal, report)]) {
    console.error(`! ${warning}`);
  }
  return exitCodeForVerdict(report.verdict);
}

/** The pointer survives a refused or crashed run, so a stale proof has to announce itself. */
function provenanceWarnings(cwd, runDirectory, latest) {
  const warnings = [];
  if (latest.finishedAt) warnings.push(`This proof finished at ${latest.finishedAt}; it is not re-executed by \`dogfood report\`.`);
  const current = gitHead(cwd);
  const proven = provenHead(runDirectory);
  if (current && proven && current !== proven) {
    warnings.push(`Stale: the proof ran at commit ${proven}, but the workspace is now at ${current}. Start a fresh \`dogfood run\`.`);
  }
  return warnings;
}

function gitHead(cwd) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  return result.status === 0 ? String(result.stdout || "").trim() : null;
}

function provenHead(runDirectory) {
  try {
    const summary = JSON.parse(readFileSync(join(runDirectory, "summary.json"), "utf8"));
    return summary.repository?.after?.head || summary.repository?.before?.head || null;
  } catch {
    return null;
  }
}

function printResult(report, artifactDir, contractPath) {
  console.log(`Dogfood ${report.verdict} — ${report.project}`);
  console.log(`Contract: ${contractPath}`);
  console.log(`Artifacts: ${artifactDir}`);
  if (report.validation.errors.length > 0) {
    console.log("\nValidation errors:");
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

function printVerification(verification) {
  console.log(`Dogfood bundle ${verification.verdict}${verification.runId ? ` — ${verification.runId}` : ""}`);
  console.log(`Bundle: ${verification.bundleDir}`);
  console.log(`Verification level: ${verification.verificationLevel}`);
  console.log(`Signature: ${verification.signatureStatus}`);
  for (const error of verification.errors) console.log(`  ✗ ${error}`);
  for (const warning of verification.warnings) console.log(`  ! ${warning}`);
  console.log(`\n${verification.notice}`);
}

function printHelp() {
  console.log(`
dogfood — portable evidence gate

Usage:
  dogfood init [--cwd dir] [--authoritative] [--force]
  dogfood validate [--cwd dir] [--contract path] [--policy path]
                   [--baseline-ref git-ref] [--json]
  dogfood run [--cwd dir] [--contract path] [--policy path]
              [--baseline-ref git-ref] [--json] [--timeout-ms n]
              [--evidence advisory-receipt.json ...] [--sign private-key]
  dogfood verify <bundle-dir> [--subject file] [--key public-key] [--json]
  dogfood keygen [--out dir] [--force]
  dogfood report [--cwd dir]
  dogfood version
  dogfood help

Exit codes:
  0  VALID, PASS, or an INTACT/AUTHENTICATED bundle
  1  INVALID/FAIL (including tampering or incomplete verification)
  2  INFRA_ERROR
  3  Invalid CLI usage
  4  Unexpected internal runner error

Missing oracle = FAIL. Verification never repairs product code or tests.
`);
}

function packageVersion() {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;
}

function inside(root, candidate) {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(prefix);
}

const invokedPath = realPathOrNull(process.argv[1]);
const modulePath = realPathOrNull(fileURLToPath(import.meta.url));
if (invokedPath && invokedPath === modulePath) {
  process.exitCode = await main();
}

function realPathOrNull(value) {
  if (!value) return null;
  try {
    return realpathSync(resolve(value));
  } catch {
    return null;
  }
}
