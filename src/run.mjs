import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify as stringifyYaml } from "yaml";
import { collectAdvisoryEvidence } from "./advisory.mjs";
import { findContractPath, loadContractDocument } from "./load-contract.mjs";
import { buildReport, writeManifest, writeReport } from "./report.mjs";
import { captureRepositoryState, repositoryStateChanged } from "./repository.mjs";
import { runNamedCommands } from "./run-commands.mjs";
import {
  collectCommandsToRun,
  expectedPlaywrightTags,
  scoreAcceptanceCriteria,
} from "./score-ac.mjs";
import { validateContract } from "./validate.mjs";

const moduleDir = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(moduleDir, "..");
const packageInfo = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));

export async function runDogfood(options = {}) {
  const cwd = resolve(options.cwd || process.cwd());
  const startedAt = new Date().toISOString();
  const runId = options.runId ||
    `dogfood-${startedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
    throw new Error(`Invalid run id: ${runId}`);
  }
  const contractPath = findContractPath(cwd, options.contract);
  const { contract, raw: contractRaw } = loadContractDocument(contractPath);
  const validation = validateContract(contract);
  const artifactRoot = resolve(cwd, options.artifactDir || "artifacts/dogfood");
  const artifactDir = join(artifactRoot, runId);
  const validateOnly = Boolean(options.validateOnly);
  const runtimeProblems = [];

  const repositoryBefore = !validateOnly && validation.ok
    ? await captureRepositoryState(cwd)
    : null;
  if (repositoryBefore && !repositoryBefore.available) {
    runtimeProblems.push({
      kind: "infra",
      category: "infrastructure",
      message: `Git repository state is unavailable: ${repositoryBefore.error}`,
    });
  }

  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    join(artifactDir, "contract.snapshot.yaml"),
    stringifyYaml(contract, { lineWidth: 0 }),
    "utf8",
  );

  let buildIdentity = repositoryBefore?.head || null;
  if (!validateOnly && validation.ok && contract?.build?.identityCommand) {
    const buildDefinition = {
      run: contract.build.identityCommand,
      timeoutMs: contract.build.timeoutMs || 30000,
      adapter: "exit-code",
    };
    const [identityResult] = await runNamedCommands(
      ["_build-identity"],
      { "_build-identity": buildDefinition },
      { cwd, artifactDir },
    );
    const output = String(identityResult.stdout || "").trim();
    buildIdentity = output ? output.split("\n").filter(Boolean).at(-1) : null;
    if (identityResult.mutationDetected) {
      runtimeProblems.push({
        kind: "mutation",
        category: "product",
        message: "build identity command changed tracked repository state",
      });
    }
    if (contract.build.requireIdentity && identityResult.status !== "pass") {
      runtimeProblems.push({
        kind: identityResult.status === "infra" ? "infra" : "build-identity",
        category: identityResult.status === "infra" ? "infrastructure" : "product",
        message: `required build identity command did not pass: ${identityResult.detail}`,
      });
    } else if (contract.build.requireIdentity && !buildIdentity) {
      runtimeProblems.push({
        kind: "build-identity",
        category: "product",
        message: "required build identity command produced empty output",
      });
    } else if (!contract.build.requireIdentity && identityResult.status !== "pass") {
      validation.warnings.push(`optional build identity command did not pass: ${identityResult.detail}`);
    }
  } else if (
    !validateOnly &&
    validation.ok &&
    contract?.build?.requireIdentity &&
    !buildIdentity
  ) {
    runtimeProblems.push({
      kind: "build-identity",
      category: "product",
      message: "build identity is required but Git HEAD is unavailable and no identityCommand produced one",
    });
  }

  let advisoryReceipts = [];
  if (validation.ok && (options.evidence || []).length > 0) {
    const advisory = collectAdvisoryEvidence(options.evidence, {
      cwd,
      artifactDir,
      criteria: contract.acceptanceCriteria,
    });
    advisoryReceipts = advisory.receipts;
    runtimeProblems.push(
      ...advisory.errors.map((message) => ({
        kind: "advisory-evidence",
        category: "product",
        message,
      })),
    );
  }

  let commandResults = [];
  if (validation.ok && !validateOnly) {
    commandResults = await runNamedCommands(
      collectCommandsToRun(contract),
      contract.commands,
      {
        cwd,
        artifactDir,
        timeoutMs: options.timeoutMs,
        expectedTagsByCommand: expectedPlaywrightTags(contract),
      },
    );
  }

  const acResults = validation.ok
    ? scoreAcceptanceCriteria(contract, commandResults, {
        validateOnly,
        advisoryReceipts,
      })
    : invalidAcceptanceCriteria(contract);
  const repositoryAfter = !validateOnly && validation.ok
    ? await captureRepositoryState(cwd)
    : null;
  if (repositoryAfter && !repositoryAfter.available) {
    runtimeProblems.push({
      kind: "infra",
      category: "infrastructure",
      message: `Final Git repository state is unavailable: ${repositoryAfter.error}`,
    });
  }
  if (
    repositoryBefore?.available &&
    repositoryAfter?.available &&
    repositoryStateChanged(repositoryBefore, repositoryAfter) &&
    !runtimeProblems.some((problem) => problem.kind === "mutation") &&
    !commandResults.some((command) => command.mutationDetected)
  ) {
    runtimeProblems.push({
      kind: "mutation",
      category: "product",
      message: "tracked repository state changed during verification",
    });
  }

  const finishedAt = new Date().toISOString();
  const report = buildReport({
    contract,
    contractPath,
    cwd,
    runId,
    startedAt,
    finishedAt,
    validation,
    buildIdentity,
    commandResults,
    acResults,
    advisoryReceipts,
    runtimeProblems,
    repositoryBefore: summarizeRepository(repositoryBefore),
    repositoryAfter: summarizeRepository(repositoryAfter),
    validateOnly,
  });
  writeReport(artifactDir, report);
  const manifest = writeManifest(artifactDir, {
    contractDigest: sha256(contractRaw),
    repository: report.repository,
    packageInfo: { name: packageInfo.name, version: packageInfo.version },
    buildDefinition: contract?.build || null,
    commandDefinitions: contract?.commands || {},
    startedAt,
    finishedAt,
  });

  mkdirSync(artifactRoot, { recursive: true });
  writeFileSync(
    join(artifactRoot, "latest.json"),
    JSON.stringify(
      {
        version: 2,
        runId,
        path: runId,
        summary: `${runId}/summary.md`,
        verdict: report.verdict,
      },
      null,
      2,
    ),
    "utf8",
  );

  return { report, manifest, artifactDir, contractPath, cwd };
}

export function exitCodeForVerdict(verdict) {
  if (verdict === "PASS") return 0;
  if (verdict === "INFRA_ERROR") return 2;
  return 1;
}

export async function initProject(cwd, { force = false } = {}) {
  const root = resolve(cwd);
  const dogfoodDir = join(root, ".dogfood");
  const contractPath = join(dogfoodDir, "dogfood.contract.yaml");
  if (existsSync(contractPath) && !force) {
    throw new Error(`Already initialized: ${contractPath} (use --force to overwrite)`);
  }

  mkdirSync(dogfoodDir, { recursive: true });
  mkdirSync(join(root, "artifacts", "dogfood"), { recursive: true });
  copyTemplate(join(PACKAGE_ROOT, "templates", "dogfood.contract.yaml"), contractPath, force);
  writeTemplate(
    join(dogfoodDir, "gitignore.fragment"),
    "artifacts/dogfood/\n",
    force,
  );

  const templateSkill = join(PACKAGE_ROOT, "templates", "skill", "SKILL.md");
  const skillDests = [
    join(root, ".claude", "skills", "dogfood", "SKILL.md"),
    join(root, ".agents", "skills", "dogfood", "SKILL.md"),
  ];
  for (const destination of skillDests) copyTemplate(templateSkill, destination, force);

  copyTemplate(
    join(PACKAGE_ROOT, "templates", "ci", "dogfood.yml"),
    join(dogfoodDir, "github-workflow.dogfood.yml"),
    force,
  );
  writeTemplate(
    join(dogfoodDir, "README.md"),
    [
      "# Dogfood project gate",
      "",
      "This directory contains a portable Dogfood v2 proof contract.",
      "",
      "1. Replace the placeholder command.",
      "2. Declare an oracle for every in-scope acceptance criterion.",
      "3. Run `dogfood validate`, then `dogfood run`.",
      "",
      "The generated contract is intentionally incomplete and cannot pass until it is mapped.",
      "Dogfood does not repair product code or tests during verification.",
      "",
    ].join("\n"),
    force,
  );

  return { contractPath, skillDests, dogfoodDir };
}

function copyTemplate(source, destination, force) {
  if (existsSync(destination) && !force) return false;
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination);
  return true;
}

function writeTemplate(destination, content, force) {
  if (existsSync(destination) && !force) return false;
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content, "utf8");
  return true;
}

function invalidAcceptanceCriteria(contract) {
  if (!Array.isArray(contract?.acceptanceCriteria)) return [];
  return contract.acceptanceCriteria
    .filter((criterion) => criterion && typeof criterion === "object")
    .map((criterion, index) => ({
      id: criterion.id || `acceptanceCriteria[${index}]`,
      issue: criterion.issue || null,
      class: criterion.class || "invalid",
      severity: criterion.severity || null,
      oracle: typeof criterion.oracle === "string" ? criterion.oracle : null,
      advisoryEvidence: [],
      verdict: "invalid",
      detail: "contract validation failed; no proof was executed",
    }));
}

function summarizeRepository(repository) {
  if (!repository) return null;
  return {
    available: repository.available,
    head: repository.head,
    dirty: repository.dirty,
    trackedDirty: repository.trackedDirty,
    dirtyStateDigest: repository.dirtyStateDigest,
    diffDigest: repository.diffDigest,
    error: repository.error,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function portablePath(from, to) {
  return relative(from, to).split(sep).join("/") || ".";
}
