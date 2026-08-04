import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { formatAjvError } from "./ajv-errors.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import { isPathInside, normalizeGitPath, tryRealpath } from "./files.mjs";
import { ContractInputError } from "./load-contract.mjs";
import { matchesAny } from "./repository.mjs";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const contractSchema = JSON.parse(readFileSync(join(moduleDir, "..", "schemas", "contract.schema.json"), "utf8"));
const policySchema = JSON.parse(readFileSync(join(moduleDir, "..", "schemas", "policy.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(contractSchema);
const validateSchema = ajv.compile(policySchema);

export function loadPolicyDocument(cwd, explicitPath) {
  if (!explicitPath) return { policy: null, raw: null, path: null, validation: { ok: true, errors: [] } };
  const path = resolve(cwd, explicitPath);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new ContractInputError(`Could not read policy ${path}: ${error.message}`, { cause: error });
  }
  let policy;
  try {
    policy = parseYaml(raw);
  } catch (error) {
    throw new ContractInputError(`Could not parse policy ${path}: ${error.message}`, { cause: error });
  }
  const ok = validateSchema(policy);
  const errors = ok ? [] : validateSchema.errors.map((error) => formatAjvError(error, "policy"));
  return { policy, raw, path, validation: { ok, errors: [...new Set(errors)] } };
}

export function validateAuthoritativePolicy(contract, policy) {
  if (!policy) return { ok: true, errors: [], warnings: [] };
  const errors = [];
  const warnings = [];
  const deterministic = (contract?.acceptanceCriteria || []).filter((item) => item?.class === "deterministic");
  const criteria = contract?.acceptanceCriteria || [];
  if (deterministic.length < policy.criteria.minimumDeterministic) {
    errors.push(`authoritative policy requires at least ${policy.criteria.minimumDeterministic} deterministic acceptance criterion(s); found ${deterministic.length}`);
  }
  if (policy.criteria.forbidAllExcluded && criteria.length > 0 && criteria.every((item) => item?.class === "excluded")) {
    errors.push("authoritative policy forbids an excluded-only contract");
  }
  for (const gate of policy.criteria.requiredGates) {
    if (!Array.isArray(contract?.gates?.[gate]) || contract.gates[gate].length === 0) {
      errors.push(`authoritative policy requires non-empty gate "${gate}"`);
    }
  }
  if (policy.build.requireSubject && !contract?.build?.subject) {
    errors.push("authoritative policy requires build.subject");
  }
  // A junit-xml command writes its report into the working tree, which authoritative mode reads as
  // an untracked mutation unless the path is allowlisted. Warn rather than widen the allowlist from
  // the contract: what a verification run may write to is the policy's decision, not the contract's.
  const allowUntracked = policy.mutation?.allowUntracked || [];
  for (const [name, definition] of Object.entries(contract?.commands || {})) {
    if (definition?.adapter !== "junit-xml" || typeof definition.reportPath !== "string") continue;
    if (!matchesAny(definition.reportPath, allowUntracked)) {
      warnings.push(`commands.${name}.reportPath "${definition.reportPath}" is not covered by mutation.allowUntracked; writing the JUnit report will be reported as a mutation`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function defaultPolicyPath() {
  return ".dogfood/dogfood.policy.yaml";
}

export function validateProtectedPaths(cwd, paths) {
  const rootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  });
  if (rootResult.status !== 0) return { ok: false, errors: ["authoritative policy requires a Git working tree"] };
  let root;
  try {
    root = tryRealpath(normalizeGitPath(rootResult.stdout.trim()));
  } catch (error) {
    return { ok: false, errors: [`could not resolve Git root (${rootResult.stdout.trim()}): ${error.message}`] };
  }
  const errors = [];
  for (const [label, path] of Object.entries(paths)) {
    try {
      if (!lstatSync(path).isFile()) {
        errors.push(`authoritative ${label} must be a regular file inside the Git repository`);
        continue;
      }
      if (!isPathInside(root, path)) {
        errors.push(`authoritative ${label} must be inside the Git repository`);
      }
    } catch (error) {
      errors.push(`could not inspect authoritative ${label}: ${error.message}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

