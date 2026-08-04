import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// package.json hardcodes its test file list, so an unregistered test file is a
// test that silently never runs in CI.
test("the npm test script runs every test file in test/", () => {
  const script = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts.test;
  const registered = new Set(script.split(/\s+/).filter((token) => /^test\/[^/]+\.test\.mjs$/.test(token)));
  const present = new Set(
    readdirSync(join(root, "test"))
      .filter((file) => file.endsWith(".test.mjs"))
      .map((file) => `test/${file}`),
  );
  const unregistered = [...present].filter((file) => !registered.has(file)).sort();
  const stale = [...registered].filter((file) => !present.has(file)).sort();
  assert.deepEqual(
    { unregistered, stale },
    { unregistered: [], stale: [] },
    `package.json scripts.test is out of sync with test/: missing from the script: ${list(unregistered)}; listed but absent from test/: ${list(stale)}`,
  );
});

function list(files) {
  return files.length > 0 ? files.join(", ") : "(none)";
}
