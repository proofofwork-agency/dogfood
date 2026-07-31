import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { join } from "node:path";
import { ADAPTER_VERSIONS } from "./adapters.mjs";
import { atomicWriteFile, atomicWriteJson, portableRelative } from "./files.mjs";

export function buildReport({
  contract,
  contractPath,
  cwd,
  runId,
  startedAt,
  finishedAt,
  validation,
  buildIdentity,
  buildSubject = null,
  commandResults,
  acResults,
  advisoryReceipts = [],
  runtimeProblems = [],
  repositoryBefore = null,
  repositoryAfter = null,
  validateOnly = false,
  authoritative = false,
  policyPath = null,
  baseline = null,
  metadata = {},
  digests = {},
}) {
  const hardFails = [
    ...validation.errors.map((message) => ({ kind: "contract", category: "product", message })),
    ...runtimeProblems,
  ];

  if (!validateOnly && validation.ok) {
    hardFails.push(
      ...commandResults
        .filter((result) => result.status !== "pass" && result.blocking !== false)
        .map((result) => ({
          kind: result.status === "infra"
            ? "infra"
            : result.mutationDetected
              ? "mutation"
              : result.definition?.adapter === "playwright-json" && result.code === 0
                ? "evidence"
                : result.name === "_build-identity" ? "build-identity" : "command",
          category: result.status === "infra" ? "infrastructure" : "product",
          message: `command ${result.name}: ${result.detail || result.status}`,
        })),
      ...acResults
        .filter((result) => result.verdict === "fail" || result.verdict === "blocked")
        .map((result) => ({
          kind: result.verdict === "blocked" ? "infra" : "acceptance-criterion",
          category: result.verdict === "blocked" ? "infrastructure" : "product",
          message: `${result.id}: ${result.detail}`,
        })),
    );
  }

  const uniqueHardFails = deduplicateProblems(hardFails);
  const validationVerdict = validation.ok ? "VALID" : "INVALID";
  const proofVerdict = validateOnly || !validation.ok ? "NOT_RUN" : classifyVerdict(uniqueHardFails);
  const verdict = validateOnly ? validationVerdict : validation.ok ? proofVerdict : "FAIL";
  return {
    version: 3,
    runId,
    mode: validateOnly ? "validate" : "run",
    profile: authoritative ? "authoritative" : "standard",
    project: contract?.project || "(invalid contract)",
    contractPath: portableRelative(cwd, contractPath),
    policyPath: policyPath ? portableRelative(cwd, policyPath) : null,
    startedAt,
    finishedAt,
    durationMs: new Date(finishedAt) - new Date(startedAt),
    verdict,
    validationVerdict,
    proofVerdict,
    digests,
    buildIdentity: buildIdentity || null,
    buildSubject,
    repository: { before: repositoryBefore, after: repositoryAfter },
    enforcement: {
      missingOracle: "fail",
      retries: "disabled",
      allowAutoRepair: false,
      advisoryChangesHardVerdict: false,
      severityAffectsVerdict: false,
      deterministicSeveritySemantics: "all deterministic criteria block regardless of severity",
      mutationScope: authoritative ? "Git root, tracked and changed non-ignored untracked files" : "tracked files inside --cwd",
      ignoredFilesCovered: false,
    },
    validation: {
      ok: validation.ok,
      errors: validation.errors,
      warnings: validation.warnings,
    },
    baseline,
    metadata,
    commands: commandResults.map(summarizeCommand),
    acceptanceCriteria: acResults,
    advisoryEvidence: advisoryReceipts,
    hardFails: uniqueHardFails,
    nextSteps: nextSteps(verdict, uniqueHardFails, validateOnly),
  };
}

export function classifyVerdict(problems) {
  if (problems.length === 0) return "PASS";
  return problems.every((problem) => problem.category === "infrastructure") ? "INFRA_ERROR" : "FAIL";
}

export function writeReport(artifactDir, report) {
  atomicWriteJson(join(artifactDir, "summary.json"), report);
  atomicWriteFile(join(artifactDir, "summary.md"), toMarkdown(report), "utf8");
  atomicWriteJson(join(artifactDir, "matrix.json"), {
    version: 3,
    project: report.project,
    runId: report.runId,
    verdict: report.verdict,
    validationVerdict: report.validationVerdict,
    proofVerdict: report.proofVerdict,
    acceptanceCriteria: report.acceptanceCriteria,
  });
  atomicWriteFile(join(artifactDir, "junit.xml"), toJunit(report), "utf8");
}

export function writeManifest(artifactDir, details) {
  const checksums = {};
  for (const file of listFiles(artifactDir)) {
    const name = portableRelative(artifactDir, file);
    if (name === "manifest.json") continue;
    checksums[name] = sha256(readFileSync(file));
  }
  const manifest = {
    version: 3,
    checksumAlgorithm: "sha256",
    runId: details.runId,
    mode: details.mode,
    profile: details.profile,
    verdict: details.verdict,
    validationVerdict: details.validationVerdict,
    proofVerdict: details.proofVerdict,
    contract: details.contract,
    policy: details.policy,
    repository: details.repository,
    runtime: {
      node: process.version,
      platform: platform(),
      release: release(),
      arch: arch(),
    },
    package: details.packageInfo,
    build: details.build,
    commands: details.commandDefinitions,
    adapters: ADAPTER_VERSIONS,
    baseline: details.baseline,
    metadata: details.metadata,
    startedAt: details.startedAt,
    finishedAt: details.finishedAt,
    checksums,
    integrityNotice: "Checksums prove internal consistency, not provenance. A malicious actor can regenerate this unsigned manifest; signing is deferred.",
  };
  atomicWriteJson(join(artifactDir, "manifest.json"), manifest);
  return manifest;
}

function summarizeCommand(result) {
  return {
    name: result.name,
    run: result.definition?.run || result.command,
    adapter: result.definition?.adapter || result.adapter?.adapter || null,
    blocking: result.blocking !== false,
    status: result.status,
    detail: result.detail,
    code: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    interrupted: result.interrupted || false,
    timeoutMs: result.timeoutMs,
    durationMs: result.durationMs,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    mutationDetected: result.mutationDetected || false,
    mutationProblems: result.mutationProblems || [],
    repositoryInspectionFailed: result.repositoryInspectionFailed || false,
    evidence: result.evidence || null,
  };
}

function nextSteps(verdict, hardFails, validateOnly) {
  if (verdict === "VALID" && validateOnly) return ["Contract and policy are valid. Run `dogfood run` to execute the proof."];
  if (verdict === "PASS") return ["Deterministic proof is green. Verify and preserve this artifact bundle with the candidate build."];
  if (verdict === "INFRA_ERROR") {
    return ["Recover the environment or runner.", "Start a fresh complete `dogfood run`; this run is not reusable as proof."];
  }
  const steps = ["Do not treat this run as proof of acceptance."];
  if (hardFails.some((problem) => problem.kind === "contract")) steps.push("Fix the v2 contract, policy, baseline regression, or oracle mappings, then start a fresh run.");
  if (hardFails.some((problem) => problem.kind === "mutation")) steps.push("Remove mutation from verification commands; Dogfood never accepts a self-changing proof.");
  if (hardFails.some((problem) => problem.kind === "command" || problem.kind === "acceptance-criterion")) steps.push("Re-implement against the failing evidence, or re-refine only if the criterion is wrong.");
  if (hardFails.some((problem) => problem.kind === "evidence")) steps.push("Restore exact structured evidence; a successful process without its evidence cannot pass.");
  steps.push("Do not edit product code or tests inside the verification run to force green.");
  return steps;
}

function toMarkdown(report) {
  const lines = [
    `# Dogfood report — ${report.project}`,
    "",
    `**Verdict:** ${report.verdict}`,
    `**Validation:** ${report.validationVerdict}`,
    `**Proof:** ${report.proofVerdict}`,
    `**Profile:** ${report.profile}`,
    `**Mode:** ${report.mode}`,
    `**Run:** \`${report.runId}\``,
    `**Started:** ${report.startedAt}`,
    `**Finished:** ${report.finishedAt}`,
    `**Duration:** ${report.durationMs}ms`,
    `**Contract:** \`${report.contractPath}\``,
    report.policyPath ? `**Policy:** \`${report.policyPath}\`` : null,
    report.buildIdentity ? `**Build identity:** \`${escapeInline(report.buildIdentity)}\`` : null,
    report.buildSubject ? `**Build subject:** \`${report.buildSubject.path}\` (${report.buildSubject.algorithm}:${report.buildSubject.digest}, ${report.buildSubject.size} bytes)` : null,
    report.repository.before?.head ? `**Git HEAD:** \`${report.repository.before.head}\`` : null,
    report.repository.before?.dirty === true ? "**Initial workspace state:** dirty" : null,
    report.repository.before?.dirty === false ? "**Initial workspace state:** clean" : null,
    "",
    "## Verdict policy",
    "",
    "- Every deterministic criterion blocks on failure; severity is classification metadata.",
    "- Judgmental criteria and advisory receipts never change the hard verdict.",
    `- Mutation enforcement: ${report.enforcement.mutationScope}.`,
    "- Git-ignored files are explicitly outside the mutation guarantee.",
    "",
    "## Acceptance criteria",
    "",
    "| ID | Class | Severity | Verdict | Detail |",
    "|----|-------|----------|---------|--------|",
  ];
  for (const criterion of report.acceptanceCriteria) {
    lines.push(`| ${escapeCell(criterion.id)} | ${criterion.class} | ${criterion.severity} | ${criterion.verdict} | ${escapeCell(criterion.detail)} |`);
  }
  lines.push("", "## Commands", "");
  if (report.commands.length === 0) lines.push("_No commands executed._");
  else {
    lines.push("| Name | Adapter | Blocking | Status | Code | Duration | Mutation |", "|------|---------|----------|--------|------|----------|----------|");
    for (const command of report.commands) {
      lines.push(`| ${escapeCell(command.name)} | ${command.adapter} | ${command.blocking ? "yes" : "no"} | ${command.status} | ${command.code ?? ""} | ${command.durationMs}ms | ${command.mutationDetected ? "yes" : "no"} |`);
    }
  }
  if (report.baseline) {
    lines.push("", "## Baseline comparison", "", `Baseline: \`${report.baseline.ref}\``);
    if (!report.baseline.found) lines.push("", "_No baseline contract was found; this is recorded as first adoption._");
    for (const item of report.baseline.changes || []) lines.push(`- ${item.field}${item.criterionId ? ` for ${item.criterionId}` : ""}${item.reviewRequired ? " — code-owner review required" : ""}`);
  }
  lines.push("", "## Advisory evidence", "");
  if (report.advisoryEvidence.length === 0) lines.push("_No advisory receipts supplied. Advisory evidence never changes the hard verdict._");
  else {
    lines.push("| AC | Actor | Driver | Assessment | Summary |", "|----|-------|--------|------------|---------|");
    for (const receipt of report.advisoryEvidence) lines.push(`| ${escapeCell(receipt.acId)} | ${escapeCell(receipt.actor)} | ${escapeCell(receipt.driver)} | ${receipt.assessment} | ${escapeCell(receipt.summary)} |`);
  }
  if (report.validation.errors.length > 0) lines.push("", "## Validation errors", "", ...report.validation.errors.map((error) => `- ${error}`));
  if (report.validation.warnings.length > 0) lines.push("", "## Warnings", "", ...report.validation.warnings.map((warning) => `- ${warning}`));
  if (report.hardFails.length > 0) lines.push("", "## Blocking problems", "", ...report.hardFails.map((problem) => `- **${problem.kind}:** ${problem.message}`));
  lines.push("", "## Next steps", "", ...report.nextSteps.map((step) => `- ${step}`), "");
  return lines.filter((line) => line !== null).join("\n");
}

function toJunit(report) {
  const verdictDetail = report.hardFails.map((problem) => problem.message).join("; ");
  const isFailure = report.verdict === "FAIL" || report.verdict === "INVALID";
  const verdictBody = isFailure
    ? `<failure message="${xml(verdictDetail || "Dogfood validation or proof failed")}"/>`
    : report.verdict === "INFRA_ERROR" ? `<error message="${xml(verdictDetail || "Dogfood infrastructure error")}"/>` : "";
  const cases = [`<testcase classname="dogfood" name="verdict" time="${(report.durationMs / 1000).toFixed(3)}">${verdictBody}</testcase>`];
  for (const criterion of report.acceptanceCriteria) {
    let body = "";
    if (criterion.verdict === "fail" || criterion.verdict === "invalid") body = `<failure message="${xml(criterion.detail)}"/>`;
    else if (criterion.verdict === "blocked") body = `<error message="${xml(criterion.detail)}"/>`;
    else if (["advisory", "excluded", "not-run"].includes(criterion.verdict)) body = `<skipped message="${xml(criterion.detail)}"/>`;
    cases.push(`<testcase classname="acceptance" name="${xml(criterion.id)}" time="0">${body}</testcase>`);
  }
  for (const command of report.commands) {
    let body = "";
    if (command.status === "infra") body = `<error message="${xml(command.detail)}"/>`;
    else if (command.status === "fail") body = `<failure message="${xml(command.detail)}"/>`;
    cases.push(`<testcase classname="command" name="${xml(command.name)}" time="${(command.durationMs / 1000).toFixed(3)}">${body}</testcase>`);
  }
  const failures = (isFailure ? 1 : 0) + report.acceptanceCriteria.filter((item) => ["fail", "invalid"].includes(item.verdict)).length + report.commands.filter((item) => item.status === "fail").length;
  const errors = (report.verdict === "INFRA_ERROR" ? 1 : 0) + report.acceptanceCriteria.filter((item) => item.verdict === "blocked").length + report.commands.filter((item) => item.status === "infra").length;
  const skipped = report.acceptanceCriteria.filter((item) => ["advisory", "excluded", "not-run"].includes(item.verdict)).length;
  return ['<?xml version="1.0" encoding="UTF-8"?>', `<testsuite name="dogfood" tests="${cases.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${(report.durationMs / 1000).toFixed(3)}">`, ...cases.map((testCase) => `  ${testCase}`), "</testsuite>", ""].join("\n");
}

export function listFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (entry.isFile() && statSync(path).isFile()) files.push(path);
  }
  return files.sort();
}

export { portableRelative };

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deduplicateProblems(problems) {
  const seen = new Set();
  return problems.filter((problem) => {
    const key = `${problem.kind}\0${problem.category}\0${problem.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeCell(value) { return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " "); }
function escapeInline(value) { return String(value).replaceAll("`", "\\`"); }
function xml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
