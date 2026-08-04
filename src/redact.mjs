const REDACTION = "[REDACTED]";
// Published YAML and JSON documents need a mask that stays a plain scalar in every position.
const DOCUMENT_REDACTION = "REDACTED";

// Redaction is on by default; templates/dogfood.policy.yaml ships this same logs block.
export const DEFAULT_LOG_POLICY = Object.freeze({
  capture: "full-redacted",
  redactEnv: ["GITHUB_TOKEN", "*_TOKEN", "*_SECRET", "*_PASSWORD", "*_KEY", "*_CREDENTIAL*"],
  redactLiterals: [],
});

/** Build one redactor for a log policy; capture "full" and a missing policy both keep raw text. */
export function createRedactor(logs = null, env = process.env) {
  const capture = logs?.capture || "full";
  if (!logs || capture === "full") {
    return { apply: (value) => String(value || ""), capture, redactionApplied: false };
  }
  const literals = collectLiterals(logs, env);
  return { apply: (value) => replaceLiterals(value, literals, REDACTION), capture, redactionApplied: true };
}

/**
 * Redactor for documents published inside the bundle. Only policy-declared literals are
 * masked; an env-derived value would make the recorded contract depend on the environment.
 */
export function createDocumentRedactor(logs = null) {
  const literals = sortLiterals(new Set(logs?.redactLiterals || []));
  return {
    active: literals.length > 0,
    apply: (value) => replaceLiterals(value, literals, DOCUMENT_REDACTION),
  };
}

/** Apply a redactor to every string inside a JSON-safe value. */
export function redactDeep(value, redactor) {
  if (typeof value === "string") return redactor.apply(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, redactor));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, redactor)]));
  }
  return value;
}

function collectLiterals(logs, env) {
  const literals = new Set(logs.redactLiterals || []);
  for (const [name, secret] of Object.entries(env)) {
    if (!secret) continue;
    if (!(logs.redactEnv || []).some((pattern) => wildcard(pattern).test(name))) continue;
    // A CI secret read from a file keeps its padding, but the command prints the trimmed value.
    for (const variant of [String(secret), String(secret).trim()]) {
      if (redactableValue(variant)) literals.add(variant);
    }
  }
  return sortLiterals(literals);
}

function replaceLiterals(value, literals, mask) {
  let output = String(value ?? "");
  for (const literal of literals) output = output.split(literal).join(mask);
  return output;
}

/** A matching name is not enough: tiny, boolean and small numeric values shred unrelated log text. */
function redactableValue(value) {
  const text = String(value);
  if (text.length < 4 || text === "true" || text === "false") return false;
  return !(/^\d+$/.test(text) && text.length < 8);
}

// Longest first so a secret that contains another secret is not partially replaced.
function sortLiterals(literals) { return [...literals].filter(Boolean).sort((a, b) => b.length - a.length); }

function wildcard(pattern) {
  const source = String(pattern).replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${source}$`);
}
