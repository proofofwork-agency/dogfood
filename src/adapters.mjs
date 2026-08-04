import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWriteFile, atomicWriteJson, isPathInside, safeSegment } from "./files.mjs";
import {
  decodeJunitBuffer,
  evaluateJunitCase,
  junitSelectorKey,
  parseJunitXml,
} from "./junit.mjs";
import { createDocumentRedactor, createRedactor, DEFAULT_LOG_POLICY, redactDeep } from "./redact.mjs";

export const ADAPTER_VERSIONS = Object.freeze({
  "exit-code": "1",
  "playwright-json": "1",
  "junit-xml": "1",
});
export const MAX_EVIDENCE_REPORT_BYTES = 50 * 1024 * 1024;

export function prepareAdapter(name, definition, artifactDir, { cwd = process.cwd() } = {}) {
  const safeName = safeSegment(name);
  const evidenceDir = join(artifactDir, "evidence", definition.adapter);
  mkdirSync(evidenceDir, { recursive: true });

  if (definition.adapter === "junit-xml") {
    const reportFile = join("evidence", definition.adapter, `${safeName}.report.xml`);
    const evaluationFile = join("evidence", definition.adapter, `${safeName}.evaluation.json`);
    // The report is written by a foreign runner into the workspace, so unlike Playwright there is
    // no path to inject; the contract declares where it lands and that path must stay in the tree.
    const sourcePath = resolve(cwd, definition.reportPath || "");
    const escapes = !definition.reportPath || !isPathInside(cwd, dirname(sourcePath));
    // Same interlock as Playwright: clearing first is what makes "a report exists" mean
    // "this command wrote it". A path that escapes the workspace is never touched.
    if (!escapes) rmSync(sourcePath, { force: true });
    return {
      env: {},
      reportPath: join(artifactDir, reportFile),
      reportFile: reportFile.replaceAll("\\", "/"),
      sourcePath: escapes ? null : sourcePath,
      sourceFile: definition.reportPath || null,
      sourceEscapes: escapes,
      cwd,
      evaluationPath: join(artifactDir, evaluationFile),
      evaluationFile: evaluationFile.replaceAll("\\", "/"),
    };
  }

  if (definition.adapter === "playwright-json") {
    const reportFile = join("evidence", definition.adapter, `${safeName}.report.json`);
    const evaluationFile = join("evidence", definition.adapter, `${safeName}.evaluation.json`);
    const reportPath = join(artifactDir, reportFile);
    // Clearing the path is the interlock that makes "a report exists" mean "this command wrote it";
    // without it any earlier command in the same run can pre-plant the evidence.
    rmSync(reportPath, { force: true });
    return {
      env: { PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath },
      reportPath,
      reportFile: reportFile.replaceAll("\\", "/"),
      evaluationPath: join(artifactDir, evaluationFile),
      evaluationFile: evaluationFile.replaceAll("\\", "/"),
    };
  }

  const evaluationFile = join("evidence", definition.adapter, `${safeName}.evaluation.json`);
  return {
    env: {},
    reportPath: null,
    reportFile: null,
    evaluationPath: join(artifactDir, evaluationFile),
    evaluationFile: evaluationFile.replaceAll("\\", "/"),
  };
}

export function evaluateAdapter(definition, processResult, prepared, expectedTags = [], logs = null, expectedCases = []) {
  const redactor = bundleRedactor(logs);
  let evaluation;
  if (definition.adapter === "exit-code") {
    evaluation = evaluateExitCode(processResult);
  } else if (definition.adapter === "playwright-json") {
    evaluation = evaluatePlaywrightJson(
      processResult,
      prepared.reportPath,
      expectedTags,
      prepared.reportFile,
      redactor,
    );
  } else if (definition.adapter === "junit-xml") {
    evaluation = evaluateJunitXml(processResult, prepared, expectedCases, redactor);
  } else {
    evaluation = {
      adapter: definition.adapter,
      version: null,
      status: "fail",
      detail: `unsupported adapter: ${definition.adapter}`,
      tags: {},
    };
  }

  // Report-derived titles and details flow on into summary.json, junit.xml and the console.
  const redacted = redactDeep(evaluation, redactor);
  atomicWriteJson(prepared.evaluationPath, redacted);
  return redacted;
}

export function evaluateExitCode(processResult) {
  if (processResult.status === "infra") {
    return {
      adapter: "exit-code",
      version: ADAPTER_VERSIONS["exit-code"],
      status: "infra",
      detail: processResult.timedOut
        ? "command timed out before producing a result"
        : "command could not complete because of infrastructure trouble",
      tags: {},
    };
  }
  if (processResult.code !== 0) {
    return {
      adapter: "exit-code",
      version: ADAPTER_VERSIONS["exit-code"],
      status: "fail",
      detail: `complete command failed (code=${processResult.code})`,
      tags: {},
    };
  }
  return {
    adapter: "exit-code",
    version: ADAPTER_VERSIONS["exit-code"],
    status: "pass",
    detail: "complete named command exited with code 0",
    tags: {},
  };
}

export function evaluatePlaywrightJson(
  processResult,
  reportPath,
  expectedTags = [],
  reportFile = reportPath,
  redactor = createRedactor(),
) {
  const base = {
    adapter: "playwright-json",
    version: ADAPTER_VERSIONS["playwright-json"],
    reportFile,
    reportSource: null,
    accepted: null,
    tags: {},
  };

  if (processResult.status === "infra") {
    return {
      ...base,
      status: "infra",
      detail: processResult.timedOut
        ? "Playwright command timed out"
        : "Playwright command could not complete because of infrastructure trouble",
    };
  }

  let report;
  if (reportPath && existsSync(reportPath)) {
    let reportSize;
    try {
      const stat = statSync(reportPath);
      if (!stat.isFile()) throw new Error("report path is not a regular file");
      reportSize = stat.size;
    } catch (error) {
      return {
        ...base,
        accepted: false,
        status: "fail",
        detail: `Playwright JSON report is unreadable: ${error.message}.`,
      };
    }
    if (reportSize > MAX_EVIDENCE_REPORT_BYTES) {
      return {
        ...base,
        accepted: false,
        status: "fail",
        detail: `Playwright JSON report exceeds the ${MAX_EVIDENCE_REPORT_BYTES / 1024 / 1024} MiB evidence limit.`,
      };
    }
    // Only the parse belongs in the try; a failed republish is not an invalid report.
    try {
      report = parsePlaywrightReport(readFileSync(reportPath, "utf8"));
    } catch (error) {
      return {
        ...base,
        accepted: false,
        status: "fail",
        detail: `Playwright JSON report is invalid: ${describeParseFailure(error)}.`,
      };
    }
    // Republish through our atomic writer, redacted: titles and errors are attacker- and secret-bearing.
    atomicWriteFile(reportPath, redactor.apply(`${JSON.stringify(report, null, 2)}\n`), "utf8");
    base.reportSource = "file";
    base.accepted = true;
  } else {
    // Stdout is the command's own output, so it can never be the evidence this adapter exists to demand,
    // and it is never copied into the bundle: commands/<name>/stdout.log already holds it under the log policy.
    base.reportSource = "missing";
    base.accepted = false;
    const missing = `Playwright JSON report is missing at ${reportFile || "the configured evidence path"}.`;
    const guidance = "configure the JSON reporter so PLAYWRIGHT_JSON_OUTPUT_FILE is honored";
    let stdoutShape;
    try {
      parsePlaywrightReport(processResult.stdout);
      stdoutShape = "Stdout parsed as a Playwright report, but stdout is not acceptable evidence";
    } catch (error) {
      stdoutShape = `Stdout is not acceptable evidence either; captured stdout was ${describeParseFailure(error)}`;
    }
    return {
      ...base,
      status: "fail",
      detail: `${missing} ${stdoutShape} — ${guidance}.`,
    };
  }

  for (const tag of [...new Set(expectedTags)]) {
    base.tags[tag] = evaluatePlaywrightTag(report, tag);
  }

  if (processResult.code !== 0) {
    return {
      ...base,
      status: "fail",
      detail: `Playwright command failed (code=${processResult.code})`,
    };
  }

  const failingTag = Object.values(base.tags).find((result) => result.status !== "pass");
  if (failingTag) {
    return {
      ...base,
      status: "fail",
      detail: failingTag.detail,
    };
  }

  return {
    ...base,
    status: "pass",
    detail: expectedTags.length
      ? `Playwright report proved ${Object.keys(base.tags).length} configured tag(s)`
      : "Playwright command passed and produced a valid JSON report",
  };
}

export function evaluatePlaywrightTag(report, tag) {
  const matchingSpecs = collectSpecs(report)
    .filter((spec) =>
      Array.isArray(spec.tags) &&
      spec.tags.some((reportedTag) =>
        reportedTag === tag || (tag.startsWith("@") && reportedTag === tag.slice(1)),
      ),
    );

  if (matchingSpecs.length === 0) {
    return {
      status: "fail",
      tag,
      detail: `Playwright report contains no test with exact tag ${tag}`,
      executions: [],
    };
  }

  const executions = [];
  for (const spec of matchingSpecs) {
    const tests = Array.isArray(spec.tests) ? spec.tests : [];
    if (tests.length === 0) {
      executions.push({
        title: spec.title || "(untitled)",
        projectName: null,
        status: "missing",
        attempts: 0,
        passedFirstAttempt: false,
      });
      continue;
    }
    for (const test of tests) {
      const attempts = Array.isArray(test.results) ? test.results : [];
      const first = attempts[0];
      const aggregateStatus = test.status || null;
      const expectedStatus = test.expectedStatus || "passed";
      const passedFirstAttempt = Boolean(
        attempts.length === 1 &&
          first?.status === "passed" &&
          expectedStatus === "passed" &&
          (aggregateStatus === null || aggregateStatus === "expected" || aggregateStatus === "passed"),
      );
      executions.push({
        title: spec.title || "(untitled)",
        projectName: test.projectName || test.projectId || null,
        status: aggregateStatus || first?.status || "missing",
        firstAttemptStatus: first?.status || "missing",
        attempts: attempts.length,
        passedFirstAttempt,
      });
    }
  }

  const failed = executions.filter((execution) => !execution.passedFirstAttempt);
  if (failed.length > 0) {
    const summary = failed
      .map((execution) => `${execution.title} (${execution.status}, attempts=${execution.attempts})`)
      .join(", ");
    return {
      status: "fail",
      tag,
      detail: `Not every ${tag} execution ran and passed on its first attempt: ${summary}`,
      executions,
    };
  }

  return {
    status: "pass",
    tag,
    detail: `${executions.length} matching execution(s) passed on the first attempt`,
    executions,
  };
}

/**
 * Read a JUnit XML report a foreign runner wrote into the workspace and bind criteria to named
 * testcases. Unlike Playwright there is no output path to inject — pytest, Vitest, gotestsum and
 * Maven each spell the flag differently — so the contract declares reportPath and this adapter
 * enforces the guarantees the missing injection would otherwise have given: the file is cleared
 * before the command runs, must stay inside the workspace, and is republished into the bundle so
 * the evidence that is checksummed is the evidence that was read.
 */
export function evaluateJunitXml(processResult, prepared, expectedCases = [], redactor = createRedactor()) {
  const base = {
    adapter: "junit-xml",
    version: ADAPTER_VERSIONS["junit-xml"],
    reportFile: prepared.reportFile,
    sourceFile: prepared.sourceFile ?? null,
    reportSource: null,
    accepted: null,
    suites: [],
    testcases: {},
    tags: {},
  };

  if (processResult.status === "infra") {
    return {
      ...base,
      status: "infra",
      detail: processResult.timedOut
        ? "JUnit command timed out"
        : "JUnit command could not complete because of infrastructure trouble",
    };
  }

  if (prepared.sourceEscapes || !prepared.sourcePath) {
    return {
      ...base,
      reportSource: "rejected",
      accepted: false,
      status: "fail",
      detail: `Declared reportPath ${prepared.sourceFile || "(none)"} does not resolve inside the workspace.`,
    };
  }

  if (!existsSync(prepared.sourcePath)) {
    base.reportSource = "missing";
    base.accepted = false;
    return {
      ...base,
      status: "fail",
      detail: `JUnit XML report is missing at ${prepared.sourceFile}. Configure the runner to write its JUnit report there — dogfood clears the path before the command runs, so a report present afterwards is the one this command produced.`,
    };
  }

  // Re-check containment now the file exists: a command can turn a report directory into a symlink
  // while it runs, and the pre-run check could only see the path it was going to become.
  if (!isPathInside(prepared.cwd, prepared.sourcePath)) {
    return {
      ...base,
      reportSource: "rejected",
      accepted: false,
      status: "fail",
      detail: `JUnit XML report at ${prepared.sourceFile} resolves outside the workspace.`,
    };
  }

  let bytes;
  try {
    const stat = lstatSync(prepared.sourcePath);
    if (!stat.isFile()) throw new Error("report path is not a regular file");
    if (stat.size > MAX_EVIDENCE_REPORT_BYTES) {
      return {
        ...base,
        reportSource: "rejected",
        accepted: false,
        status: "fail",
        detail: `JUnit XML report exceeds the ${MAX_EVIDENCE_REPORT_BYTES / 1024 / 1024} MiB evidence limit.`,
      };
    }
    bytes = readFileSync(prepared.sourcePath);
  } catch (error) {
    return {
      ...base,
      reportSource: "rejected",
      accepted: false,
      status: "fail",
      detail: `JUnit XML report is unreadable: ${capDetail(error.message)}.`,
    };
  }

  let report;
  let text;
  try {
    text = decodeJunitBuffer(bytes);
    report = parseJunitXml(text);
  } catch (error) {
    return {
      ...base,
      reportSource: "file",
      accepted: false,
      status: "fail",
      detail: `JUnit XML report is invalid: ${describeJunitFailure(error)}.`,
    };
  }

  // Republish the original bytes rather than a re-serialization: re-emitting XML would change the
  // evidence, and the checksum in the manifest has to cover what was actually read.
  atomicWriteFile(prepared.reportPath, redactor.apply(text), "utf8");
  base.reportSource = "file";
  base.accepted = true;
  base.suites = report.suites;

  for (const selector of dedupeSelectors(expectedCases)) {
    base.testcases[junitSelectorKey(selector)] = evaluateJunitCase(report, selector);
  }

  if (processResult.code !== 0) {
    return { ...base, status: "fail", detail: `JUnit command failed (code=${processResult.code})` };
  }

  const failing = Object.values(base.testcases).find((result) => result.status !== "pass");
  if (failing) return { ...base, status: "fail", detail: failing.detail };

  return {
    ...base,
    status: "pass",
    detail: expectedCases.length
      ? `JUnit report proved ${Object.keys(base.testcases).length} configured testcase(s)`
      : `JUnit command passed and produced a valid report with ${report.testcases.length} testcase(s)`,
  };
}

function dedupeSelectors(selectors) {
  const byKey = new Map();
  for (const selector of selectors || []) byKey.set(junitSelectorKey(selector), selector);
  return [...byKey.values()];
}

// Parse messages quote the offending markup, so details carry a classification only.
function describeJunitFailure(error) {
  const classification = error?.name === "JunitParseError" ? error.message : "not shaped like a JUnit XML report";
  return capDetail(createRedactor(DEFAULT_LOG_POLICY).apply(classification));
}

/**
 * One redactor for everything this adapter publishes. A declared literal is a secret in every
 * capture mode, so the document mask always runs; the log policy adds the environment values.
 */
function bundleRedactor(logs) {
  const documentRedactor = createDocumentRedactor(logs);
  const logRedactor = createRedactor(logs);
  if (!documentRedactor.active) return logRedactor;
  return { apply: (value) => logRedactor.apply(documentRedactor.apply(value)) };
}

function collectSpecs(report) {
  const specs = [];
  const visitSuite = (suite) => {
    if (Array.isArray(suite?.specs)) specs.push(...suite.specs);
    for (const child of suite?.suites || []) visitSuite(child);
  };
  for (const suite of report?.suites || []) visitSuite(suite);
  return specs;
}

function parsePlaywrightReport(value) {
  const report = JSON.parse(String(value || "").trim());
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("report root is not an object");
  }
  if (!Array.isArray(report.suites)) {
    throw new Error("report has no suites array");
  }
  if (!report.stats || typeof report.stats !== "object" || Array.isArray(report.stats)) {
    throw new Error("report has no stats object");
  }
  return report;
}

// JSON.parse embeds a slice of its input in the message, so details carry a classification only.
function describeParseFailure(error) {
  const classification = error?.name === "SyntaxError"
    ? "not valid JSON"
    : "not shaped like a Playwright JSON report";
  return capDetail(createRedactor(DEFAULT_LOG_POLICY).apply(`${classification} (${error?.name || "Error"})`));
}

function capDetail(value) {
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}
