import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify as stringifyYaml } from "yaml";
import { collectAdvisoryEvidence } from "./advisory.mjs";
import { compareBaseline } from "./baseline.mjs";
import { collectRuntimeMetadata, inspectBuildSubject } from "./build.mjs";
import { atomicWriteFile, atomicWriteJson } from "./files.mjs";
import { findContractPath, loadContractDocument } from "./load-contract.mjs";
import { defaultPolicyPath, loadPolicyDocument, validateAuthoritativePolicy, validateProtectedPaths } from "./policy.mjs";
import { buildReport, writeManifest, writeReport } from "./report.mjs";
import {
  authoritativeInitialProblems,
  authoritativeRepositoryProblems,
  captureRepositoryState,
  repositoryStateChanged,
} from "./repository.mjs";
import { runNamedCommands } from "./run-commands.mjs";
import { collectCommandsToRun, expectedPlaywrightTags, scoreAcceptanceCriteria } from "./score-ac.mjs";
import { validateContract } from "./validate.mjs";

const moduleDir = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(moduleDir, "..");
const packageInfo = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));

export async function runDogfood(options = {}) {
  const cwd = resolve(options.cwd || process.cwd());
  const startedAt = new Date().toISOString();
  const runId = options.runId || `dogfood-${startedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) throw new Error(`Invalid run id: ${runId}`);

  const contractPath = findContractPath(cwd, options.contract);
  const { contract, raw: contractRaw } = loadContractDocument(contractPath);
  const policyDocument = loadPolicyDocument(cwd, options.policy);
  const authoritative = Boolean(policyDocument.path);
  const validateOnly = Boolean(options.validateOnly);
  const artifactRoot = resolve(cwd, options.artifactDir || "artifacts/dogfood");
  const artifactDir = join(artifactRoot, runId);
  mkdirSync(artifactRoot, { recursive: true });
  try {
    mkdirSync(artifactDir);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Run directory already exists; refusing to overwrite: ${artifactDir}`);
    throw error;
  }

  const normalizedContract = stringifyYaml(contract, { lineWidth: 0 });
  atomicWriteFile(join(artifactDir, "contract.original.yaml"), contractRaw, "utf8");
  atomicWriteFile(join(artifactDir, "contract.snapshot.yaml"), normalizedContract, "utf8");
  let normalizedPolicy = null;
  if (authoritative) {
    normalizedPolicy = stringifyYaml(policyDocument.policy, { lineWidth: 0 });
    atomicWriteFile(join(artifactDir, "policy.original.yaml"), policyDocument.raw, "utf8");
    atomicWriteFile(join(artifactDir, "policy.snapshot.yaml"), normalizedPolicy, "utf8");
  }

  const digests = {
    sourceContract: sha256(contractRaw),
    normalizedContract: sha256(normalizedContract),
    sourcePolicy: authoritative ? sha256(policyDocument.raw) : null,
    normalizedPolicy: authoritative ? sha256(normalizedPolicy) : null,
  };
  const validation = validateContract(contract);
  if (!policyDocument.validation.ok) validation.errors.push(...policyDocument.validation.errors);
  if (authoritative && policyDocument.validation.ok) {
    validation.errors.push(...validateProtectedPaths(cwd, { contract: contractPath, policy: policyDocument.path }).errors);
    const policyValidation = validateAuthoritativePolicy(contract, policyDocument.policy);
    validation.errors.push(...policyValidation.errors);
    validation.warnings.push(...policyValidation.warnings);
  }

  let baseline = null;
  if (options.baselineRef) {
    if (!authoritative || !policyDocument.validation.ok) {
      validation.errors.push("--baseline-ref requires a valid authoritative --policy");
    } else if (contract && typeof contract === "object" && contract.version === 2) {
      baseline = compareBaseline({
        cwd,
        contractPath,
        contract,
        ref: options.baselineRef,
        policy: policyDocument.policy,
      });
      validation.errors.push(...baseline.errors);
      validation.warnings.push(...baseline.warnings);
    }
  }
  validation.errors = [...new Set(validation.errors)];
  validation.warnings = [...new Set(validation.warnings)];
  validation.ok = validation.errors.length === 0;

  const runtimeProblems = [];
  const repositoryBefore = !validateOnly && validation.ok
    ? await captureRepositoryState(cwd, { authoritative })
    : null;
  if (repositoryBefore && !repositoryBefore.available) {
    runtimeProblems.push({ kind: "infra", category: "infrastructure", message: `Git repository state is unavailable: ${repositoryBefore.error}` });
  }
  if (authoritative && repositoryBefore?.available) {
    for (const message of authoritativeInitialProblems(repositoryBefore, policyDocument.policy.mutation.allowUntracked)) {
      runtimeProblems.push({ kind: "mutation", category: "product", message });
    }
  }

  const runOptions = {
    cwd,
    artifactDir,
    timeoutMs: options.timeoutMs,
    authoritative,
    allowUntracked: policyDocument.policy?.mutation?.allowUntracked || [],
    logs: policyDocument.policy?.logs || null,
    signal: options.signal,
  };
  let commandResults = [];
  let buildIdentity = repositoryBefore?.head || null;
  if (!validateOnly && validation.ok) {
    const identityDefinition = {
      run: contract?.build?.identityCommand || "git rev-parse HEAD",
      timeoutMs: contract?.build?.timeoutMs || 30_000,
      adapter: "exit-code",
    };
    const [identityResult] = await runNamedCommands(
      ["_build-identity"],
      { "_build-identity": identityDefinition },
      runOptions,
    );
    if (identityResult) {
      const output = String(identityResult.stdout || "").trim();
      buildIdentity = output ? output.split("\n").filter(Boolean).at(-1) : null;
      identityResult.blocking = Boolean(contract?.build?.requireIdentity) || identityResult.mutationDetected;
      commandResults.push(identityResult);
      if (identityResult.mutationDetected) {
        runtimeProblems.push({ kind: "mutation", category: "product", message: "build identity command changed repository state" });
      }
      if (contract?.build?.requireIdentity && identityResult.status !== "pass") {
        runtimeProblems.push({
          kind: identityResult.status === "infra" ? "infra" : "build-identity",
          category: identityResult.status === "infra" ? "infrastructure" : "product",
          message: `required build identity command did not pass: ${identityResult.detail}`,
        });
      } else if (contract?.build?.requireIdentity && !buildIdentity) {
        runtimeProblems.push({ kind: "build-identity", category: "product", message: "required build identity command produced empty output" });
      } else if (!contract?.build?.requireIdentity && identityResult.status !== "pass") {
        validation.warnings.push(`optional build identity command did not pass: ${identityResult.detail}`);
      }
    }
  }

  let advisoryReceipts = [];
  if (validation.ok && (options.evidence || []).length > 0) {
    const advisory = collectAdvisoryEvidence(options.evidence, { cwd, artifactDir, criteria: contract.acceptanceCriteria });
    advisoryReceipts = advisory.receipts;
    runtimeProblems.push(...advisory.errors.map((message) => ({ kind: "advisory-evidence", category: "product", message })));
  }

  if (validation.ok && !validateOnly) {
    const proofResults = await runNamedCommands(
      collectCommandsToRun(contract),
      contract.commands,
      { ...runOptions, expectedTagsByCommand: expectedPlaywrightTags(contract) },
    );
    commandResults.push(...proofResults);
  }
  if (!validateOnly && validation.ok && options.signal?.aborted && !commandResults.some((item) => item.status === "infra")) {
    runtimeProblems.push({ kind: "infra", category: "infrastructure", message: "proof was interrupted before all commands completed" });
  }

  const subjectInspection = !validateOnly && validation.ok
    ? inspectBuildSubject(cwd, contract?.build?.subject)
    : { subject: null, error: null };
  if (subjectInspection.error) {
    runtimeProblems.push({ kind: "build-subject", category: "product", message: subjectInspection.error });
  }

  const acResults = validation.ok
    ? scoreAcceptanceCriteria(contract, commandResults, { validateOnly, advisoryReceipts })
    : invalidAcceptanceCriteria(contract);
  const repositoryAfter = !validateOnly && validation.ok
    ? await captureRepositoryState(cwd, { authoritative })
    : null;
  if (repositoryAfter && !repositoryAfter.available) {
    runtimeProblems.push({ kind: "infra", category: "infrastructure", message: `Final Git repository state is unavailable: ${repositoryAfter.error}` });
  }
  if (repositoryBefore?.available && repositoryAfter?.available) {
    const changes = authoritative
      ? authoritativeRepositoryProblems(repositoryBefore, repositoryAfter, policyDocument.policy.mutation.allowUntracked)
      : repositoryStateChanged(repositoryBefore, repositoryAfter) ? ["tracked repository state changed during verification"] : [];
    for (const message of changes) {
      if (runtimeProblems.some((problem) => problem.kind === "mutation" && problem.message === message)) continue;
      runtimeProblems.push({ kind: "mutation", category: "product", message });
    }
  }

  const metadata = collectRuntimeMetadata(cwd, repositoryBefore?.root || cwd);
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
    buildSubject: subjectInspection.subject,
    commandResults,
    acResults,
    advisoryReceipts,
    runtimeProblems,
    repositoryBefore: summarizeRepository(repositoryBefore),
    repositoryAfter: summarizeRepository(repositoryAfter),
    validateOnly,
    authoritative,
    policyPath: policyDocument.path,
    baseline,
    metadata,
    digests,
  });
  writeReport(artifactDir, report);
  const manifest = writeManifest(artifactDir, {
    runId,
    mode: report.mode,
    profile: report.profile,
    verdict: report.verdict,
    validationVerdict: report.validationVerdict,
    proofVerdict: report.proofVerdict,
    contract: {
      originalFile: "contract.original.yaml",
      snapshotFile: "contract.snapshot.yaml",
      sourceDigest: digests.sourceContract,
      normalizedDigest: digests.normalizedContract,
    },
    policy: authoritative ? {
      originalFile: "policy.original.yaml",
      snapshotFile: "policy.snapshot.yaml",
      sourceDigest: digests.sourcePolicy,
      normalizedDigest: digests.normalizedPolicy,
    } : null,
    repository: report.repository,
    packageInfo: { name: packageInfo.name, version: packageInfo.version },
    build: { definition: contract?.build || null, identity: buildIdentity, subject: subjectInspection.subject },
    commandDefinitions: contract?.commands || {},
    baseline,
    metadata,
    startedAt,
    finishedAt,
  });

  atomicWriteJson(join(artifactRoot, "latest.json"), {
    version: 3,
    runId,
    path: runId,
    summary: `${runId}/summary.md`,
    manifest: `${runId}/manifest.json`,
    verdict: report.verdict,
    validationVerdict: report.validationVerdict,
    proofVerdict: report.proofVerdict,
  });
  return { report, manifest, artifactDir, contractPath, policyPath: policyDocument.path, cwd };
}

export function exitCodeForVerdict(verdict) {
  if (verdict === "PASS" || verdict === "VALID") return 0;
  if (verdict === "INFRA_ERROR") return 2;
  return 1;
}

export async function initProject(cwd, { force = false, authoritative = false } = {}) {
  const root = resolve(cwd);
  const dogfoodDir = join(root, ".dogfood");
  const contractPath = join(dogfoodDir, "dogfood.contract.yaml");
  if (existsSync(contractPath) && !force) throw new Error(`Already initialized: ${contractPath} (use --force to overwrite)`);
  mkdirSync(dogfoodDir, { recursive: true });
  mkdirSync(join(root, "artifacts", "dogfood"), { recursive: true });
  copyTemplate(join(PACKAGE_ROOT, "templates", "dogfood.contract.yaml"), contractPath, force);
  const policyPath = join(dogfoodDir, "dogfood.policy.yaml");
  if (authoritative) copyTemplate(join(PACKAGE_ROOT, "templates", "dogfood.policy.yaml"), policyPath, force);
  writeTemplate(join(dogfoodDir, "gitignore.fragment"), "artifacts/dogfood/\n", force);

  const templateSkill = join(PACKAGE_ROOT, "templates", "skill", "SKILL.md");
  const skillDests = [join(root, ".claude", "skills", "dogfood", "SKILL.md"), join(root, ".agents", "skills", "dogfood", "SKILL.md")];
  for (const destination of skillDests) copyTemplate(templateSkill, destination, force);
  copyTemplate(join(PACKAGE_ROOT, "templates", "ci", "dogfood.yml"), join(dogfoodDir, "github-workflow.dogfood.yml"), force);
  copyTemplate(join(PACKAGE_ROOT, "templates", "CODEOWNERS.fragment"), join(dogfoodDir, "CODEOWNERS.fragment"), force);
  writeTemplate(join(dogfoodDir, "README.md"), [
    "# Dogfood project gate",
    "",
    "This directory contains a portable Dogfood v2 proof contract.",
    authoritative ? "The explicit policy enables the authoritative v0.3 profile." : "No policy is installed, so standard compatibility mode is active.",
    "",
    "1. Replace the placeholder command.",
    "2. Declare an oracle for every in-scope acceptance criterion.",
    "3. Run `dogfood validate`, then `dogfood run`.",
    "",
    "The generated contract is intentionally incomplete and cannot pass until it is mapped.",
    "Dogfood does not repair product code or tests during verification.",
    "",
  ].join("\n"), force);
  return { contractPath, policyPath: authoritative ? policyPath : null, skillDests, dogfoodDir };
}

function copyTemplate(source, destination, force) {
  if (existsSync(destination) && !force) return false;
  atomicWriteFile(destination, readFileSync(source));
  return true;
}

function writeTemplate(destination, content, force) {
  if (existsSync(destination) && !force) return false;
  atomicWriteFile(destination, content, "utf8");
  return true;
}

function invalidAcceptanceCriteria(contract) {
  if (!Array.isArray(contract?.acceptanceCriteria)) return [];
  return contract.acceptanceCriteria.filter((criterion) => criterion && typeof criterion === "object").map((criterion, index) => ({
    id: criterion.id || `acceptanceCriteria[${index}]`,
    issue: criterion.issue || null,
    class: criterion.class || "invalid",
    severity: criterion.severity || null,
    oracle: typeof criterion.oracle === "string" ? criterion.oracle : null,
    advisoryEvidence: [],
    verdict: "invalid",
    detail: "contract or policy validation failed; no proof was executed",
  }));
}

function summarizeRepository(repository) {
  if (!repository) return null;
  return {
    available: repository.available,
    root: repository.root ? portablePath(repository.root, repository.root) : null,
    scope: repository.scope,
    authoritative: repository.authoritative,
    head: repository.head,
    dirty: repository.dirty,
    trackedDirty: repository.trackedDirty,
    dirtyStateDigest: repository.dirtyStateDigest,
    trackedStateDigest: repository.trackedStateDigest,
    diffDigest: repository.diffDigest,
    untracked: repository.untracked,
    ignoredFilesCovered: false,
    error: repository.error,
  };
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
export function portablePath(from, to) { return relative(from, to).split(sep).join("/") || "."; }
export { defaultPolicyPath };
