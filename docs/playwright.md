# Playwright evidence

The `playwright-json` adapter binds a deterministic acceptance criterion to an exact Playwright tag. It exists to close the false-green case where a browser command exits 0 even though a grep or filter matched no relevant test.

## Contract

The command uses `adapter: playwright-json`. Its oracle uses `kind: playwright`, names that command, and declares a tag exactly equal to `@dogfood:<criterion id>`.

Before the command starts, Dogfood removes any pre-existing report at the evidence path and injects `PLAYWRIGHT_JSON_OUTPUT_FILE`. This variable is a file path, not a directory. Configure Playwright so its JSON reporter honors that path; the shipped [configuration](https://github.com/proofofwork-agency/dogfood/blob/main/examples/playwright/playwright.config.mjs) also derives a nearby test-results directory.

```js
import { defineConfig } from "@playwright/test";
import { dirname, join } from "node:path";

const reportFile = process.env.PLAYWRIGHT_JSON_OUTPUT_FILE;

export default defineConfig({
  reporter: reportFile ? [["json", { outputFile: reportFile }]] : "list",
  outputDir: reportFile ? join(dirname(reportFile), "test-results") : "test-results",
  retries: 0,
});
```

The current fixture instead selects `--reporter=json` on its command line; Playwright's JSON reporter reads `PLAYWRIGHT_JSON_OUTPUT_FILE`.

## Strict evaluation

For each configured tag:

- at least one matching spec must exist;
- every matching project execution must exist;
- each execution must contain exactly one attempt;
- the first attempt must be `passed`;
- `expectedStatus` must be `passed`; and
- the aggregate status must be expected or passed.

Missing, skipped, interrupted, failed, expected-failure, retried, and flaky executions fail the criterion. There are no automatic retries inside Dogfood.

The command's own stdout is never accepted as evidence, even when it parses as a plausible Playwright report. Only the report file written during that command is accepted and republished through the configured redactor.

The report file is limited to 50 MiB and is refused before parsing when larger, so a malformed or runaway reporter cannot make the gate read an unbounded document into memory.

Run the fixture from the repository root:

```bash
npm run test:playwright-fixture
```

It proves a clean PASS, rejects a planted product failure, restores the fixture, and proves a final PASS.
