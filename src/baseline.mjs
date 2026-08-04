import { spawnSync } from "node:child_process";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { isPathInside, normalizeGitPath, portableRelative, tryRealpath } from "./files.mjs";
import { validateContract } from "./validate.mjs";

export function compareBaseline({ cwd, contractPath, contract, ref, policy }) {
  if (!ref) return null;
  const result = {
    ref,
    resolvedRef: null,
    found: false,
    errors: [],
    warnings: [],
    changes: [],
  };
  // A control character cannot be part of a ref name; it only reaches spawnSync as a raw
  // TypeError and injects newlines into the Markdown evidence, so it is refused unquoted.
  if (hasControlCharacter(String(ref))) {
    result.errors.push("baseline ref contains control characters");
    return result;
  }
  const rootResult = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (rootResult.status !== 0) {
    result.errors.push(`could not locate Git root for baseline ${ref}: ${clean(rootResult.stderr)}`);
    return result;
  }
  const root = tryRealpath(normalizeGitPath(rootResult.stdout.trim()));
  if (!isPathInside(root, contractPath)) {
    result.errors.push("authoritative contract must be inside the Git repository");
    return result;
  }
  const rel = portableRelative(root, contractPath);
  const commitResult = git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  const resolvedRef = String(commitResult.stdout || "").trim();
  // Only the resolved object id is ever handed to `git show`; a user string could be read as an option.
  // Both object formats are accepted, so a SHA-256 repository is not rejected as unresolvable.
  if (commitResult.status !== 0 || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(resolvedRef)) {
    result.errors.push(`baseline ref does not resolve to a commit: ${ref}`);
    return result;
  }
  result.resolvedRef = resolvedRef;
  const source = git(root, ["show", `${resolvedRef}:${rel}`], 10 * 1024 * 1024);
  if (source.status !== 0) {
    result.warnings.push(`baseline contract is absent at ${ref}:${rel}; treating this as first adoption`);
    return result;
  }
  result.found = true;
  let baseline;
  try {
    baseline = extname(contractPath).toLowerCase() === ".json"
      ? JSON.parse(source.stdout)
      : parseYaml(source.stdout);
  } catch (error) {
    result.errors.push(`baseline contract at ${ref}:${rel} could not be parsed: ${error.message}`);
    return result;
  }
  const baselineValidation = validateContract(baseline);
  if (!baselineValidation.ok) {
    result.errors.push(`baseline contract at ${ref}:${rel} is invalid: ${baselineValidation.errors.join("; ")}`);
    return result;
  }

  const beforeCriteria = new Map((baseline.acceptanceCriteria || []).map((item) => [item.id, item]));
  const afterCriteria = new Map((contract?.acceptanceCriteria || []).map((item) => [item.id, item]));
  for (const [id, before] of beforeCriteria) {
    const after = afterCriteria.get(id);
    if (!after) {
      result.changes.push(change("criterion-removed", id, "criterion", before, null));
      if (before.class === "deterministic" && policy.baseline.blockRemovedDeterministic) {
        result.errors.push(`baseline regression: removed deterministic criterion ${id}`);
      }
      continue;
    }
    compareField(result.changes, id, "class", before.class, after.class);
    compareField(result.changes, id, "severity", before.severity, after.severity);
    compareField(result.changes, id, "text", before.text ?? null, after.text ?? null);
    compareField(result.changes, id, "issue", before.issue ?? null, after.issue ?? null);
    compareField(result.changes, id, "oracle", before.oracle ?? null, after.oracle ?? null);
    if (before.class === "deterministic" && after.class !== "deterministic" && policy.baseline.blockClassDowngrade) {
      result.errors.push(`baseline regression: criterion ${id} changed from deterministic to ${after.class}`);
    }
    const beforeOracle = before.oracle ? baseline.oracles?.[before.oracle] : null;
    const afterOracle = after.oracle ? contract.oracles?.[after.oracle] : null;
    compareField(result.changes, id, "oracle.kind", beforeOracle?.kind ?? null, afterOracle?.kind ?? null);
    compareField(result.changes, id, "oracle.command", beforeOracle?.command ?? null, afterOracle?.command ?? null);
    compareField(result.changes, id, "oracle.tag", beforeOracle?.tag ?? null, afterOracle?.tag ?? null, true);
    const beforeCommand = beforeOracle?.command ? baseline.commands?.[beforeOracle.command] : null;
    const afterCommand = afterOracle?.command ? contract.commands?.[afterOracle.command] : null;
    compareField(result.changes, id, "command.run", beforeCommand?.run ?? null, afterCommand?.run ?? null, true);
    compareField(result.changes, id, "command.adapter", beforeCommand?.adapter ?? null, afterCommand?.adapter ?? null);
    if (beforeOracle?.kind === "playwright" && afterOracle?.kind === "command" && policy.baseline.blockPlaywrightToCommand) {
      result.errors.push(`baseline regression: criterion ${id} downgraded from Playwright evidence to a generic command`);
    }
  }
  for (const [id, after] of afterCriteria) {
    if (!beforeCriteria.has(id)) result.changes.push(change("criterion-added", id, "criterion", null, after));
  }

  compareNamedDefinitions(result.changes, "oracles", baseline.oracles || {}, contract?.oracles || {}, [
    ["kind", false],
    ["command", false],
    ["tag", true],
  ]);
  compareNamedDefinitions(result.changes, "commands", baseline.commands || {}, contract?.commands || {}, [
    ["run", true],
    ["adapter", false],
    ["timeoutMs", false],
  ]);

  const gateNames = new Set([...Object.keys(baseline.gates || {}), ...Object.keys(contract?.gates || {})]);
  for (const gate of gateNames) {
    const before = baseline.gates?.[gate] || null;
    const after = contract?.gates?.[gate] || null;
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      result.changes.push(change("gate-changed", null, `gates.${gate}`, before, after));
    }
  }
  if (policy.baseline.blockRemovedRequiredGates) {
    for (const gate of policy.criteria.requiredGates) {
      if ((baseline.gates?.[gate]?.length || 0) > 0 && (contract?.gates?.[gate]?.length || 0) === 0) {
        result.errors.push(`baseline regression: removed required gate ${gate}`);
      }
    }
  }
  return result;
}

function compareNamedDefinitions(changes, collection, beforeValues, afterValues, fields) {
  const names = new Set([...Object.keys(beforeValues), ...Object.keys(afterValues)]);
  for (const name of names) {
    const before = beforeValues[name];
    const after = afterValues[name];
    if (before === undefined || after === undefined) {
      changes.push(change(before === undefined ? `${collection}-added` : `${collection}-removed`, null, `${collection}.${name}`, before ?? null, after ?? null));
      continue;
    }
    for (const [field, reviewRequired] of fields) {
      compareField(changes, null, `${collection}.${name}.${field}`, before?.[field] ?? null, after?.[field] ?? null, reviewRequired);
    }
  }
}

function compareField(changes, id, field, before, after, reviewRequired = false) {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    changes.push(change("field-changed", id, field, before, after, reviewRequired));
  }
}

function change(type, criterionId, field, before, after, reviewRequired = false) {
  return { type, criterionId, field, before, after, reviewRequired };
}

function git(cwd, args, maxBuffer = 1024 * 1024) {
  return spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer });
}

function hasControlCharacter(value) { return [...value].some((character) => character.codePointAt(0) < 0x20 || character.codePointAt(0) === 0x7f); }

function clean(value) {
  return String(value || "").trim().split("\n").filter(Boolean).at(-1) || "Git command failed";
}


