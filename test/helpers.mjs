import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import { tryRealpath } from "../src/files.mjs";

export function validContract(overrides = {}) {
  const contract = {
    version: 2,
    project: "test-project",
    build: { requireIdentity: true },
    commands: {
      proof: {
        run: "node check.mjs",
        timeoutMs: 5000,
        adapter: "exit-code",
      },
    },
    gates: { verification: ["proof"] },
    oracles: {
      proof: { kind: "command", command: "proof" },
    },
    acceptanceCriteria: [
      {
        id: "AC-proof",
        class: "deterministic",
        oracle: "proof",
        severity: "blocker",
      },
    ],
  };
  return deepMerge(contract, overrides);
}

export function authoritativePolicy(overrides = {}) {
  return deepMerge({
    version: 1,
    profile: "authoritative",
    criteria: {
      minimumDeterministic: 1,
      forbidAllExcluded: true,
      requiredGates: ["verification"],
    },
    baseline: {
      blockRemovedDeterministic: true,
      blockClassDowngrade: true,
      blockPlaywrightToCommand: true,
      blockRemovedRequiredGates: true,
    },
    mutation: {
      scope: "git-root",
      mode: "git-visible",
      allowUntracked: ["artifacts/dogfood/**"],
    },
    build: { requireSubject: false },
    logs: {
      capture: "full-redacted",
      redactEnv: ["GITHUB_TOKEN", "*_TOKEN", "*_SECRET", "*_PASSWORD", "*_KEY", "*_CREDENTIAL*"],
      redactLiterals: [],
    },
  }, overrides);
}

export function createProject(contract = validContract(), files = {}) {
  const directory = mkdtempSync(join(tmpdir(), "dogfood-v2-"));
  mkdirSync(join(directory, ".dogfood"), { recursive: true });
  writeFileSync(
    join(directory, ".dogfood", "dogfood.contract.yaml"),
    stringifyYaml(contract, { lineWidth: 0 }),
    "utf8",
  );
  writeFileSync(join(directory, "check.mjs"), "console.log('proof passed');\n", "utf8");
  for (const [name, content] of Object.entries(files)) {
    const path = join(directory, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  git(directory, ["init", "-q"]);
  git(directory, ["config", "user.email", "dogfood@example.test"]);
  git(directory, ["config", "user.name", "Dogfood Tests"]);
  git(directory, ["add", "."]);
  git(directory, ["commit", "-qm", "fixture"]);
  // Expand Windows 8.3 short names so Git long paths and Node paths agree.
  return tryRealpath(directory);
}

export function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

export function playwrightReport(specs) {
  return {
    config: {},
    suites: [
      {
        title: "suite",
        suites: [],
        specs,
      },
    ],
    errors: [],
    stats: {},
  };
}

export function playwrightSpec({
  title = "test",
  tags = ["@dogfood:AC-proof"],
  tests = [playwrightExecution()],
} = {}) {
  return { title, ok: true, tags, tests };
}

export function playwrightExecution({
  projectName = "chromium",
  status = "expected",
  expectedStatus = "passed",
  results = [{ status: "passed", duration: 1 }],
} = {}) {
  return { projectName, status, expectedStatus, results };
}

function deepMerge(base, overrides) {
  const output = structuredClone(base);
  for (const [key, value] of Object.entries(overrides)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      output[key] &&
      typeof output[key] === "object" &&
      !Array.isArray(output[key])
    ) {
      output[key] = deepMerge(output[key], value);
    } else {
      output[key] = structuredClone(value);
    }
  }
  return output;
}
