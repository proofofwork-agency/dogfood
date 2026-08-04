import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const GATE_JOB = "prove-it";
const WORKFLOWS = [".github/workflows/dogfood.yml", "templates/ci/dogfood.yml"];

// The workflow is the merge gate, so its regressions are silent: a duplicate
// check name, a fork-hostile permission, or an ungated job all look green in a
// local run and only fail open on a protected branch.
for (const file of WORKFLOWS) {
  const workflow = parse(readFileSync(join(root, file), "utf8"));
  const jobs = Object.entries(workflow.jobs ?? {});
  const nodes = walk(workflow);

  test(`${file}: every Chromium install is cached, so a browser download is not paid per leg`, () => {
    for (const [id, job] of jobs) {
      const steps = job.steps ?? [];
      const installs = steps.filter((step) => typeof step.run === "string" && step.run.includes("playwright install"));
      if (installs.length === 0) continue;
      const cached = steps.some((step) => typeof step.uses === "string" && step.uses.startsWith("actions/cache@"));
      assert.ok(cached, `${id} downloads Chromium on every run with no actions/cache step`);
    }
  });

  test(`${file}: uploaded artifacts declare a retention window`, () => {
    for (const [id, job] of jobs) {
      for (const step of job.steps ?? []) {
        if (typeof step.uses !== "string" || !step.uses.startsWith("actions/upload-artifact@")) continue;
        assert.ok(
          step.with && step.with["retention-days"] !== undefined,
          `${id} uploads an artifact with no retention-days, so every run is kept for the 90-day default`,
        );
      }
    }
  });

  test(`${file}: job names are unique and no step publishes a check under a job name`, () => {
    const named = jobs.filter(([, job]) => typeof job.name === "string");
    const owners = new Map();
    for (const [id, job] of named) owners.set(job.name, [...(owners.get(job.name) ?? []), id]);
    const duplicated = [...owners].filter(([, ids]) => ids.length > 1).map(([name, ids]) => `"${name}" claimed by ${ids.join(" and ")}`);
    assert.deepEqual(duplicated, [], `two jobs publish the same check name, so branch protection cannot tell the real gate from its twin: ${list(duplicated)}`);

    const stepNames = nodes.filter((node) => /\.with\.name$/.test(node.path) && typeof node.value === "string");
    const shadowed = named.flatMap(([id, job]) => stepNames.filter((step) => step.value === job.name).map((step) => `job "${id}" name "${job.name}" is also published by ${step.path}`));
    assert.deepEqual(shadowed, [], `a step publishes a check run under a job's name, so the required status check is ambiguous: ${list(shadowed)}`);
  });

  test(`${file}: no job requests the checks permission`, () => {
    const offenders = [["<workflow>", workflow], ...jobs].flatMap(([id, holder]) => describeChecks(id, holder.permissions));
    assert.deepEqual(offenders, [], `a fork pull request gets a read-only GITHUB_TOKEN, so any job needing checks:write can never pass for an outside contributor: ${list(offenders)}`);
  });

  test(`${file}: every job sets a numeric timeout-minutes`, () => {
    const missing = jobs.filter(([, job]) => typeof job["timeout-minutes"] !== "number").map(([id]) => id);
    assert.deepEqual(missing, [], `without timeout-minutes a hung job burns the 6-hour runner default and blocks the merge queue: ${list(missing)}`);
  });

  test(`${file}: declares a top-level concurrency group that spares the merge gate`, () => {
    assert.ok(isObject(workflow.concurrency), `${file} has no top-level concurrency block, so superseded pull-request pushes keep billing runners`);
    assert.equal(typeof workflow.concurrency.group, "string", `${file} concurrency.group must be a string key`);
    assert.notEqual(workflow.concurrency["cancel-in-progress"], true, `${file} cancels unconditionally, which would abort merge_group and push:main runs that are the merge gate itself`);
  });

  test(`${file}: no run step interpolates a workflow expression`, () => {
    const offenders = nodes.filter((node) => node.key === "run" && typeof node.value === "string" && node.value.includes("${{")).map((node) => node.path);
    assert.deepEqual(offenders, [], `\${{ }} is spliced into the shell before the shell parses it; pass the value through env: and quote it as "$VAR" instead: ${list(offenders)}`);
  });

  test(`${file}: the ${GATE_JOB} gate depends on every other job`, () => {
    const gate = workflow.jobs?.[GATE_JOB];
    assert.ok(isObject(gate), `${file} has no "${GATE_JOB}" job, but README documents it as the required status check`);
    const needs = Array.isArray(gate.needs) ? gate.needs : typeof gate.needs === "string" ? [gate.needs] : [];
    const escaped = jobs.map(([id]) => id).filter((id) => id !== GATE_JOB && !needs.includes(id));
    assert.deepEqual(escaped, [], `these jobs can fail while the required check stays green: ${list(escaped)}`);
  });
}

function describeChecks(id, permissions) {
  if (permissions === "write-all") return [`${id} (permissions: write-all implies checks: write)`];
  if (isObject(permissions) && "checks" in permissions) return [`${id} (permissions.checks: ${permissions.checks})`];
  return [];
}

function walk(node, path = "") {
  if (Array.isArray(node)) return node.flatMap((item, index) => walk(item, `${path}[${index}]`));
  if (!isObject(node)) return [];
  return Object.entries(node).flatMap(([key, value]) => {
    const next = path ? `${path}.${key}` : key;
    return [{ path: next, key, value }, ...walk(value, next)];
  });
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function list(items) {
  return items.length > 0 ? items.join("; ") : "(none)";
}
