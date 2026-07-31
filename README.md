# @proofofwork-agency/dogfood

Dogfood v2 is a portable evidence gate. It proves named commands and exact Playwright-tagged acceptance criteria, records repository identity and mutation safety, and emits an auditable artifact bundle.

The package is intentionally private and unpublished on npm while v2 is validated. Install an exact public Git revision:

```bash
npm install --save-dev github:proofofwork-agency/dogfood#<full-commit-sha>
npx dogfood version
```

For local development, `npm install --save-dev /absolute/path/to/dogfood` also works. `private: true` prevents accidental npm publication; it does not prevent local-path or Git dependency installation.

## Requirements

- Node.js 20 or newer
- Git for repository identity and tracked-mutation protection
- Playwright only when a contract uses the `playwright-json` adapter

## CLI

```bash
dogfood init
dogfood validate
dogfood run
dogfood run --evidence reviews/usability.json
dogfood migrate                 # print converted v2 YAML
dogfood migrate --write         # back up and replace a v1 contract
dogfood report
```

Exit codes are stable:

| Code | Meaning |
|---:|---|
| 0 | PASS |
| 1 | FAIL: invalid contract, failed proof, missing evidence, or mutation |
| 2 | INFRA_ERROR |
| 3 | Invalid CLI usage |
| 4 | Unexpected runner error |

## Contract v2

```yaml
version: 2
project: example-project

build:
  requireIdentity: true

commands:
  architecture:
    run: npm run test:architecture
    timeoutMs: 120000
    adapter: exit-code
  browser:
    run: npx playwright test --reporter=json
    timeoutMs: 600000
    adapter: playwright-json

gates:
  architecture: [architecture]
  browser: [browser]

oracles:
  architecture-boundaries:
    kind: command
    command: architecture
  checkout-completes:
    kind: playwright
    command: browser
    tag: "@dogfood:AC-checkout"

acceptanceCriteria:
  - id: AC-architecture
    class: deterministic
    oracle: architecture-boundaries
    severity: major
  - id: AC-checkout
    class: deterministic
    oracle: checkout-completes
    severity: blocker
```

Unknown fields, duplicate criterion IDs, unsupported kinds, broken references, invalid severities, missing oracles, and excluded criteria without reasons all fail validation. `validate` reports deterministic criteria as `not-run`; it never pretends tests executed.

Severity is classification metadata in v2. Every deterministic criterion fails closed regardless of whether its severity is `blocker`, `major`, or `minor`. Judgmental criteria must use an `advisory` oracle and never affect the hard verdict.

`gates` are explicit must-run command sets, not the only source of execution. Commands referenced by deterministic oracles run even when `gates` is empty. Conversely, a gated command without an AC mapping remains a hard project-level check; validation warns about both shapes.

An `exit-code` adapter proves only that its complete named command exited successfully.

### Playwright evidence contract

A `playwright-json` command must enable Playwright's JSON reporter. Dogfood sets `PLAYWRIGHT_JSON_OUTPUT_FILE` to the run's evidence directory, so the recommended command is:

```yaml
run: npx playwright test --reporter=json
adapter: playwright-json
```

Or pin it in `playwright.config`:

```js
import { defineConfig } from "@playwright/test";

export default defineConfig({
  reporter: [["json", { outputFile: process.env.PLAYWRIGHT_JSON_OUTPUT_FILE }]],
});
```

The report file is authoritative. If it is absent, Dogfood accepts captured stdout only when the entire stdout value is a structurally valid standalone Playwright JSON report, then persists that report into the evidence directory. Mixed reporter/log output is rejected with configuration guidance.

The adapter requires the configured exact `@dogfood:AC-ID` tag and rejects missing, skipped, interrupted, failed, expected-failure, retry-passed, or flaky executions. It uses Playwright's supported [test tags](https://playwright.dev/docs/api/class-test) and [JSON reporter](https://playwright.dev/docs/test-reporters).

## Advisory browser evidence

Advisory receipts are copied into the run but never satisfy deterministic criteria or change the hard verdict:

```json
{
  "version": 1,
  "acId": "AC-usability",
  "actor": "reviewer identity",
  "driver": "browser-review",
  "assessment": "satisfied",
  "summary": "The critical interaction was clear.",
  "artifacts": ["reviews/usability.png"]
}
```

Receipt and artifact paths must resolve inside the project workspace. Assessments are `satisfied`, `concern`, or `inconclusive`.

## Artifacts

```text
artifacts/dogfood/<run-id>/
  summary.json
  summary.md
  matrix.json
  junit.xml
  manifest.json
  contract.snapshot.yaml
  commands/<name>/metadata.json
  commands/<name>/stdout.log
  commands/<name>/stderr.log
  evidence/<adapter>/*
artifacts/dogfood/latest.json
```

The manifest includes SHA-256 checksums, contract digest, Git HEAD and dirty-state digest, runtime and package versions, command definitions, timestamps, and adapter versions. `latest.json` contains only relative pointers.

Dogfood has no retries and no repair loop. Infrastructure trouble blocks affected criteria and yields `INFRA_ERROR` only when every blocking problem is infrastructure-related; mixed product and infrastructure problems yield `FAIL`.

## Trust and mutation boundary

The contract is trusted executable project code. Commands run through the system shell so projects can use ordinary shell syntax; do not run contracts obtained from an untrusted source.

Mutation enforcement compares Git HEAD and a streamed SHA-256 digest of `git diff HEAD -- .` before and after each command. It covers tracked files inside the configured `--cwd` workspace. Untracked writes and tracked sibling paths outside `--cwd` are recorded in repository metadata where visible, but do not fail the run. This boundary intentionally permits test caches and generated evidence; projects requiring a pollution-free workspace should run Dogfood in a clean disposable checkout.

`--timeout-ms` is a global hard ceiling: each command uses the smaller of this value and its contract `timeoutMs`.

The CLI is the supported public interface in v2. Direct imports from `src/` are internal and may change before publication.

## Development

From the package root:

```bash
npm test
npm run test:playwright-fixture
npm run test:self
```

The neutral Playwright fixture includes a genuine pass and a planted product failure. The GitHub Actions example in `templates/ci/dogfood.yml` uses the stable `dogfood / prove-it` check, supports merge queues, publishes JUnit, and uploads evidence unconditionally.
