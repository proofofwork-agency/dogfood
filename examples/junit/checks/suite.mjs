#!/usr/bin/env node
/**
 * A stand-in for pytest / Vitest / gotestsum. It runs three assertions and writes the result as
 * JUnit XML, which is all any of those runners contributes to a proof — so this example needs no
 * Python, Go or JVM toolchain to demonstrate the adapter end to end.
 *
 * Set DOGFOOD_EXAMPLE_BREAK to the name of a testcase to make it fail, and watch the criterion
 * bound to that testcase turn red while the others stay green.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const reportPath = resolve(process.argv[2] || "reports/junit.xml");
const broken = process.env.DOGFOOD_EXAMPLE_BREAK || "";

const cases = [
  { classname: "checkout", name: "rejects an expired card", assertion: () => expiry("2020-01") === "expired" },
  { classname: "checkout", name: "accepts a valid card", assertion: () => expiry("2999-01") === "valid" },
  { classname: "pricing", name: "applies the bulk discount", assertion: () => price(10) === 90 },
];

const results = cases.map((testcase) => {
  if (testcase.name === broken) return { ...testcase, failure: "forced failure via DOGFOOD_EXAMPLE_BREAK" };
  try {
    return testcase.assertion() ? { ...testcase } : { ...testcase, failure: "assertion returned false" };
  } catch (error) {
    return { ...testcase, failure: error.message };
  }
});

const failures = results.filter((result) => result.failure).length;
const body = results
  .map((result) => {
    const open = `  <testcase classname="${xml(result.classname)}" name="${xml(result.name)}" time="0.001"`;
    return result.failure
      ? `${open}>\n    <failure message="${xml(result.failure)}"/>\n  </testcase>`
      : `${open}/>`;
  })
  .join("\n");

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(
  reportPath,
  `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="example" tests="${results.length}" failures="${failures}" errors="0" skipped="0" time="0.003">\n${body}\n</testsuite>\n`,
  "utf8",
);

for (const result of results) {
  process.stdout.write(`${result.failure ? "FAIL" : "ok  "} ${result.classname} :: ${result.name}\n`);
}
process.stdout.write(`wrote ${reportPath}\n`);
process.exit(failures > 0 ? 1 : 0);

function expiry(value) {
  return new Date(`${value}-01T00:00:00Z`).getTime() < Date.parse("2026-01-01T00:00:00Z") ? "expired" : "valid";
}

function price(units) {
  return units >= 10 ? units * 10 * 0.9 : units * 10;
}

function xml(value) {
  return String(value).replace(/[<>&"']/g, (character) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character]);
}
