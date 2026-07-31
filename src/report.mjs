import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { join, relative, sep } from "node:path";
import { ADAPTER_VERSIONS } from "./adapters.mjs";

export function buildReport({
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
  advisoryReceipts = [],
  runtimeProblems = [],
  repositoryBefore = null,
  repositoryAfter = null,
  validateOnly = false,
}) {
  const hardFails = [
    ...validation.errors.map((message) => ({ kind: "contract", category: "product", message })),
    ...runtimeProblems,
  ];

  if (!validateOnly) {
    hardFails.push(
      ...commandResults
        .filter((result) => result.status !== "pass")
        .map((result) => ({
          kind: result.status === "infra"
            ? "infra"
            : result.mutationDetected
              ? "mutation"
              : result.definition?.adapter === "playwright-json" && result.code === 0
                ? "evidence"
                : "command",
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
  const verdict = classifyVerdict(uniqueHardFails);
  return {
    version: 2,
    runId,
    mode: validateOnly ? "validate" : "run",
    project: contract?.project || "(invalid contract)",
    contractPath: portableRelative(cwd, contractPath),
    startedAt,
    finishedAt,
    durationMs: new Date(finishedAt) - new Date(startedAt),
    verdict,
    buildIdentity: buildIdentity || null,
    repository: {
      before: repositoryBefore,
      after: repositoryAfter,
    },
    policy: {
      missingOracle: "fail",
      retries: "disabled",
      allowAutoRepair: false,
      advisoryChangesHardVerdict: false,
      severityAffectsVerdict: false,
      deterministicSeveritySemantics: "all deterministic criteria block regardless of severity",
    },
    validation: {
      ok: validation.ok,
      errors: validation.errors,
      warnings: validation.warnings,
    },
    commands: commandResults.map(summarizeCommand),
    acceptanceCriteria: acResults,
    advisoryEvidence: advisoryReceipts,
    hardFails: uniqueHardFails,
    nextSteps: nextSteps(verdict, uniqueHardFails, validateOnly),
  };
}

export function classifyVerdict(problems) {
  if (problems.length === 0) return "PASS";
  return problems.every((problem) => problem.category === "infrastructure")
    ? "INFRA_ERROR"
    : "FAIL";
}

export function writeReport(artifactDir, report) {
  writeFileSync(join(artifactDir, "summary.json"), JSON.stringify(report, null, 2), "utf8");
  writeFileSync(join(artifactDir, "summary.md"), toMarkdown(report), "utf8");
  writeFileSync(
    join(artifactDir, "matrix.json"),
    JSON.stringify(
      {
        version: 2,
        project: report.project,
        runId: report.runId,
        verdict: report.verdict,
        acceptanceCriteria: report.acceptanceCriteria,
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(join(artifactDir, "junit.xml"), toJunit(report), "utf8");
}

export function writeManifest(
  artifactDir,
  { contractDigest, repository, packageInfo, buildDefinition, commandDefinitions, startedAt, finishedAt },
) {
  const checksums = {};
  for (const file of listFiles(artifactDir)) {
    const name = portableRelative(artifactDir, file);
    if (name === "manifest.json") continue;
    checksums[name] = sha256(readFileSync(file));
  }
  const manifest = {
    version: 2,
    checksumAlgorithm: "sha256",
    contractDigest,
    repository,
    runtime: {
      node: process.version,
      platform: platform(),
      release: release(),
      arch: arch(),
    },
    package: packageInfo,
    build: buildDefinition,
    commands: commandDefinitions,
    adapters: ADAPTER_VERSIONS,
    startedAt,
    finishedAt,
    checksums,
  };
  writeFileSync(join(artifactDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

function summarizeCommand(result) {
  return {
    name: result.name,
    run: result.definition?.run || result.command,
    adapter: result.definition?.adapter || result.adapter?.adapter || null,
    status: result.status,
    detail: result.detail,
    code: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    timeoutMs: result.timeoutMs,
    durationMs: result.durationMs,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    mutationDetected: result.mutationDetected || false,
    repositoryInspectionFailed: result.repositoryInspectionFailed || false,
    evidence: result.evidence || null,
  };
}

function nextSteps(verdict, hardFails, validateOnly) {
  if (verdict === "PASS" && validateOnly) {
    return ["Contract and mappings are valid. Run `dogfood run` to execute the proof."];
  }
  if (verdict === "PASS") {
    return ["Deterministic proof is green. Preserve this artifact bundle with the candidate build."];
  }
  if (verdict === "INFRA_ERROR") {
    return [
      "Recover the environment or runner.",
      "Start a fresh complete `dogfood run`; this run is not reusable as proof.",
    ];
  }
  const steps = ["Do not treat this run as proof of acceptance."];
  if (hardFails.some((problem) => problem.kind === "contract")) {
    steps.push("Fix the v2 contract or its oracle mappings, then start a fresh run.");
  }
  if (hardFails.some((problem) => problem.kind === "mutation")) {
    steps.push("Remove mutation from verification commands; Dogfood never accepts a self-changing proof.");
  }
  if (hardFails.some((problem) => problem.kind === "command" || problem.kind === "acceptance-criterion")) {
    steps.push("Re-implement against the failing evidence, or re-refine only if the criterion is wrong.");
  }
  if (hardFails.some((problem) => problem.kind === "evidence")) {
    steps.push("Restore exact structured evidence; a successful process without its evidence cannot pass.");
  }
  steps.push("Do not edit product code or tests inside the verification run to force green.");
  return steps;
}

function toMarkdown(report) {
  const lines = [
    `# Dogfood report — ${report.project}`,
    "",
    `**Verdict:** ${report.verdict}`,
    `**Mode:** ${report.mode}`,
    `**Run:** \`${report.runId}\``,
    `**Started:** ${report.startedAt}`,
    `**Finished:** ${report.finishedAt}`,
    `**Duration:** ${report.durationMs}ms`,
    `**Contract:** \`${report.contractPath}\``,
    report.buildIdentity ? `**Build identity:** \`${escapeInline(report.buildIdentity)}\`` : null,
    report.repository.before?.head ? `**Git HEAD:** \`${report.repository.before.head}\`` : null,
    report.repository.before?.dirty === true ? "**Initial workspace state:** dirty" : null,
    report.repository.before?.dirty === false ? "**Initial workspace state:** clean" : null,
    report.repository.before?.trackedDirty === true ? "**Initial tracked state:** dirty" : null,
    report.repository.before?.trackedDirty === false ? "**Initial tracked state:** clean" : null,
    "",
    "## Verdict policy",
    "",
    "- Every deterministic criterion blocks on failure; severity is classification metadata in v2.",
    "- Judgmental criteria and advisory receipts never change the hard verdict.",
    "- Mutation enforcement covers tracked files inside the configured project workspace.",
    "",
    "## Acceptance criteria",
    "",
    "| ID | Class | Severity | Verdict | Detail |",
    "|----|-------|----------|---------|--------|",
  ];

  for (const criterion of report.acceptanceCriteria) {
    lines.push(
      `| ${escapeCell(criterion.id)} | ${criterion.class} | ${criterion.severity} | ${criterion.verdict} | ${escapeCell(criterion.detail)} |`,
    );
  }

  lines.push("", "## Commands", "");
  if (report.commands.length === 0) {
    lines.push("_No commands executed._");
  } else {
    lines.push(
      "| Name | Adapter | Status | Code | Duration | Mutation |",
      "|------|---------|--------|------|----------|----------|",
    );
    for (const command of report.commands) {
      lines.push(
        `| ${escapeCell(command.name)} | ${command.adapter} | ${command.status} | ${command.code ?? ""} | ${command.durationMs}ms | ${command.mutationDetected ? "yes" : "no"} |`,
      );
    }
  }

  lines.push("", "## Advisory evidence", "");
  if (report.advisoryEvidence.length === 0) {
    lines.push("_No advisory receipts supplied. Advisory evidence never changes the hard verdict._");
  } else {
    lines.push("| AC | Actor | Driver | Assessment | Summary |", "|----|-------|--------|------------|---------|");
    for (const receipt of report.advisoryEvidence) {
      lines.push(
        `| ${escapeCell(receipt.acId)} | ${escapeCell(receipt.actor)} | ${escapeCell(receipt.driver)} | ${receipt.assessment} | ${escapeCell(receipt.summary)} |`,
      );
    }
  }

  if (report.validation.errors.length > 0) {
    lines.push("", "## Contract errors", "", ...report.validation.errors.map((error) => `- ${error}`));
  }
  if (report.validation.warnings.length > 0) {
    lines.push("", "## Contract warnings", "", ...report.validation.warnings.map((warning) => `- ${warning}`));
  }
  if (report.hardFails.length > 0) {
    lines.push(
      "",
      "## Blocking problems",
      "",
      ...report.hardFails.map((problem) => `- **${problem.kind}:** ${problem.message}`),
    );
  }

  lines.push("", "## Next steps", "", ...report.nextSteps.map((step) => `- ${step}`), "");
  return lines.filter((line) => line !== null).join("\n");
}

function toJunit(report) {
  const verdictDetail = report.hardFails.map((problem) => problem.message).join("; ");
  const verdictBody = report.verdict === "FAIL"
    ? `<failure message="${xml(verdictDetail || "Dogfood proof failed")}"/>`
    : report.verdict === "INFRA_ERROR"
      ? `<error message="${xml(verdictDetail || "Dogfood infrastructure error")}"/>`
      : "";
  const cases = [
    `<testcase classname="dogfood" name="verdict" time="${(report.durationMs / 1000).toFixed(3)}">${verdictBody}</testcase>`,
  ];
  for (const criterion of report.acceptanceCriteria) {
    let body = "";
    if (criterion.verdict === "fail" || criterion.verdict === "invalid") {
      body = `<failure message="${xml(criterion.detail)}"/>`;
    } else if (criterion.verdict === "blocked") {
      body = `<error message="${xml(criterion.detail)}"/>`;
    } else if (["advisory", "excluded", "not-run"].includes(criterion.verdict)) {
      body = `<skipped message="${xml(criterion.detail)}"/>`;
    }
    cases.push(
      `<testcase classname="acceptance" name="${xml(criterion.id)}" time="0">${body}</testcase>`,
    );
  }
  for (const command of report.commands) {
    let body = "";
    if (command.status === "infra") {
      body = `<error message="${xml(command.detail)}"/>`;
    } else if (command.status === "fail") {
      body = `<failure message="${xml(command.detail)}"/>`;
    }
    cases.push(
      `<testcase classname="command" name="${xml(command.name)}" time="${(command.durationMs / 1000).toFixed(3)}">${body}</testcase>`,
    );
  }
  const failures = (report.verdict === "FAIL" ? 1 : 0) +
    report.acceptanceCriteria.filter((item) => ["fail", "invalid"].includes(item.verdict)).length +
    report.commands.filter((item) => item.status === "fail").length;
  const errors = (report.verdict === "INFRA_ERROR" ? 1 : 0) +
    report.acceptanceCriteria.filter((item) => item.verdict === "blocked").length +
    report.commands.filter((item) => item.status === "infra").length;
  const skipped = report.acceptanceCriteria.filter((item) =>
    ["advisory", "excluded", "not-run"].includes(item.verdict),
  ).length;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="dogfood" tests="${cases.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${(report.durationMs / 1000).toFixed(3)}">`,
    ...cases.map((testCase) => `  ${testCase}`),
    "</testsuite>",
    "",
  ].join("\n");
}

function listFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (entry.isFile() && statSync(path).isFile()) files.push(path);
  }
  return files.sort();
}

function portableRelative(from, to) {
  return relative(from, to).split(sep).join("/") || ".";
}

function sha256(value) {
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

function escapeCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function escapeInline(value) {
  return String(value).replaceAll("`", "\\`");
}

function xml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
