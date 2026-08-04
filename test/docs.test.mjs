import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse as parseYaml } from "yaml";
import { validateContract } from "../src/validate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = join(root, "docs");
const packageInfo = readJson("package.json");
const contractSchema = readJson("schemas/contract.schema.json");
const policySchema = readJson("schemas/policy.schema.json");

test("complete contract examples in the documentation validate", (t) => {
  const examples = yamlExamples();
  const contracts = examples.filter(({ value }) => isContract(value));
  const fragments = contracts.filter(({ fragment }) => fragment);
  t.diagnostic(`${fragments.length} contract example(s) explicitly marked as fragments`);

  for (const example of contracts.filter(({ fragment }) => !fragment)) {
    const result = validateContract(example.value);
    assert.deepEqual(
      result.errors,
      [],
      `${example.location} is presented as a complete contract but is invalid:\n${result.errors.join("\n")}`,
    );
  }
});

test("complete authoritative policy examples in the documentation validate", (t) => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(contractSchema);
  const validatePolicy = ajv.compile(policySchema);
  const policies = yamlExamples().filter(({ value }) => isPolicy(value));
  const fragments = policies.filter(({ fragment }) => fragment);
  t.diagnostic(`${fragments.length} policy example(s) explicitly marked as fragments`);

  for (const example of policies.filter(({ fragment }) => !fragment)) {
    const valid = validatePolicy(example.value);
    assert.equal(
      valid,
      true,
      `${example.location} is presented as a complete policy but is invalid:\n${formatAjvErrors(validatePolicy.errors)}`,
    );
  }
});

test("docs/cli.md names every command and option supported by the CLI", (t) => {
  const target = join(docsDir, "cli.md");
  if (!existsSync(target)) {
    t.diagnostic("docs/cli.md not present yet; CLI coverage check deferred until the reference exists");
    return;
  }

  const source = readFileSync(join(root, "bin", "dogfood.mjs"), "utf8");
  const commandsMatch = source.match(/const COMMANDS = new Set\((\[[\s\S]*?\])\);/);
  const optionsMatch = source.match(/const OPTION_SPECS = \{([\s\S]*?)\n\};/);
  assert.ok(commandsMatch, "could not extract COMMANDS from bin/dogfood.mjs");
  assert.ok(optionsMatch, "could not extract OPTION_SPECS from bin/dogfood.mjs");

  const commands = JSON.parse(commandsMatch[1]);
  const options = [...optionsMatch[1].matchAll(/^\s*("--[^"]+")\s*:/gm)].map((match) => JSON.parse(match[1]));
  const documentation = readFileSync(target, "utf8");
  const missingCommands = commands.filter((command) => !documentation.includes(command));
  const missingOptions = options.filter((option) => !documentation.includes(option));

  assert.deepEqual(
    { missingCommands, missingOptions },
    { missingCommands: [], missingOptions: [] },
    `docs/cli.md is missing commands: ${list(missingCommands)}; options: ${list(missingOptions)}`,
  );
});

for (const [schemaName, documentationName, schema] of [
  ["contract", "contract.md", contractSchema],
  ["policy", "policy.md", policySchema],
]) {
  test(`docs/${documentationName} names every ${schemaName} schema field`, (t) => {
    const target = join(docsDir, documentationName);
    if (!existsSync(target)) {
      t.diagnostic(`docs/${documentationName} not present yet; schema coverage check deferred until the reference exists`);
      return;
    }

    const documentation = readFileSync(target, "utf8");
    const fields = [...schemaPropertyNames(schema)].sort();
    const missing = fields.filter((field) => !documentation.includes(field));
    assert.deepEqual(missing, [], `docs/${documentationName} is missing schema fields: ${list(missing)}`);
  });
}

test("relative links in README.md and docs/ resolve to files", () => {
  const broken = [];
  for (const file of markdownFiles()) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?<!!)\[[^\]]*\]\(([^)]+)\)/g)) {
      const rawTarget = match[1].trim().replace(/^<|>$/g, "");
      if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(rawTarget)) continue;
      const fileTarget = decodeURIComponent(rawTarget.split(/[?#]/, 1)[0]);
      if (!fileTarget) continue;
      const resolved = resolve(dirname(file), fileTarget);
      if (!existsSync(resolved)) broken.push(`${relativeDocPath(file)} -> ${rawTarget}`);
    }
  }
  assert.deepEqual(broken, [], `broken relative documentation links: ${list(broken)}`);
});

test("documentation version references match package.json", () => {
  const current = `v${packageInfo.version.split(".").slice(0, 2).join(".")}`;
  const stale = [];
  for (const file of markdownFiles()) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\bv0\.\d+\b/gi)) {
      if (match[0].toLowerCase() !== current.toLowerCase()) {
        stale.push(`${relativeDocPath(file)}:${lineNumber(source, match.index)} (${match[0]})`);
      }
    }
  }
  assert.deepEqual(stale, [], `stale documentation versions; expected ${current}: ${list(stale)}`);
});

function markdownFiles() {
  const files = [join(root, "README.md")];
  if (existsSync(docsDir)) {
    files.push(...readdirSync(docsDir)
      .filter((name) => extname(name).toLowerCase() === ".md")
      .sort()
      .map((name) => join(docsDir, name)));
  }
  return files;
}

function yamlExamples() {
  const examples = [];
  for (const file of markdownFiles()) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!/^```ya?ml\s*$/i.test(lines[index].trim())) continue;
      const start = index;
      const body = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index].trim())) {
        body.push(lines[index]);
        index += 1;
      }
      assert.ok(index < lines.length, `${relativeDocPath(file)}:${start + 1} has an unterminated YAML fence`);
      let value;
      try {
        value = parseYaml(body.join("\n"));
      } catch (error) {
        assert.fail(`${relativeDocPath(file)}:${start + 1} contains invalid YAML: ${error.message}`);
      }
      examples.push({
        value,
        fragment: /\bfragment\b/i.test(lines[start - 1] || ""),
        location: `${relativeDocPath(file)}:${start + 1}`,
      });
    }
  }
  return examples;
}

function isContract(value) {
  return object(value) && (value.version === 2 || (object(value.commands) && Array.isArray(value.acceptanceCriteria)));
}

function isPolicy(value) {
  return object(value) && (value.profile === "authoritative" || (value.version === 1 && object(value.criteria)));
}

function schemaPropertyNames(schema, names = new Set(), seen = new Set()) {
  if (!object(schema) || seen.has(schema)) return names;
  seen.add(schema);
  if (object(schema.properties)) {
    for (const [name, definition] of Object.entries(schema.properties)) {
      names.add(name);
      schemaPropertyNames(definition, names, seen);
    }
  }
  if (object(schema.items)) schemaPropertyNames(schema.items, names, seen);
  for (const keyword of ["$defs", "allOf", "anyOf", "oneOf", "if", "then", "else", "additionalProperties"]) {
    const value = schema[keyword];
    if (Array.isArray(value)) value.forEach((entry) => schemaPropertyNames(entry, names, seen));
    else if (keyword === "$defs" && object(value)) Object.values(value).forEach((entry) => schemaPropertyNames(entry, names, seen));
    else if (object(value)) schemaPropertyNames(value, names, seen);
  }
  return names;
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatAjvErrors(errors = []) {
  return (errors || []).map((error) => `${error.instancePath || "/"} ${error.message}`).join("\n");
}

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function relativeDocPath(path) {
  return path.slice(root.length + 1);
}

function lineNumber(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function list(values) {
  return values.length > 0 ? values.join(", ") : "(none)";
}
