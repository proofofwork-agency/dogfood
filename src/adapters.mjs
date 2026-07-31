import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "./files.mjs";

export const ADAPTER_VERSIONS = Object.freeze({
  "exit-code": "1",
  "playwright-json": "1",
});

export function prepareAdapter(name, definition, artifactDir) {
  const safeName = safeSegment(name);
  const evidenceDir = join(artifactDir, "evidence", definition.adapter);
  mkdirSync(evidenceDir, { recursive: true });

  if (definition.adapter === "playwright-json") {
    const reportFile = join("evidence", definition.adapter, `${safeName}.report.json`);
    const evaluationFile = join("evidence", definition.adapter, `${safeName}.evaluation.json`);
    const reportPath = join(artifactDir, reportFile);
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

export function evaluateAdapter(definition, processResult, prepared, expectedTags = []) {
  let evaluation;
  if (definition.adapter === "exit-code") {
    evaluation = evaluateExitCode(processResult);
  } else if (definition.adapter === "playwright-json") {
    evaluation = evaluatePlaywrightJson(
      processResult,
      prepared.reportPath,
      expectedTags,
      prepared.reportFile,
    );
  } else {
    evaluation = {
      adapter: definition.adapter,
      version: null,
      status: "fail",
      detail: `unsupported adapter: ${definition.adapter}`,
      tags: {},
    };
  }

  atomicWriteJson(prepared.evaluationPath, evaluation);
  return evaluation;
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
) {
  const base = {
    adapter: "playwright-json",
    version: ADAPTER_VERSIONS["playwright-json"],
    reportFile,
    reportSource: null,
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
    try {
      report = parsePlaywrightReport(readFileSync(reportPath, "utf8"));
      // Replace the reporter's completed output through our atomic writer before publication.
      atomicWriteJson(reportPath, report);
      base.reportSource = "file";
    } catch (error) {
      return {
        ...base,
        status: "fail",
        detail: `Playwright JSON report is invalid: ${error.message}`,
      };
    }
  } else {
    try {
      report = parsePlaywrightReport(processResult.stdout);
      if (!reportPath) throw new Error("Dogfood did not allocate a report destination");
      atomicWriteJson(reportPath, report);
      base.reportSource = "stdout-fallback";
    } catch (error) {
      return {
        ...base,
        status: "fail",
        detail:
          `Playwright JSON report is missing at ${reportFile || "the configured evidence path"}. ` +
          "Enable the JSON reporter so PLAYWRIGHT_JSON_OUTPUT_FILE is honored; " +
          `captured stdout was not a standalone Playwright JSON report (${error.message}).`,
      };
    }
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

function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, "_");
}
