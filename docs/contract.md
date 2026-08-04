# Contract version 1

A Dogfood contract is trusted executable configuration. The `commands.*.run` values execute through the host shell with no sandbox. Review the file before running it.

The top-level fields are `version`, `project`, optional `description`, optional `build`, `commands`, `gates`, `oracles`, and `acceptanceCriteria`. Unknown fields are rejected.

Names used for commands, gates, oracles, and criterion `id` values must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`.

## Build identity and subject

| Field | Meaning |
|---|---|
| `build.requireIdentity` | When true, the identity command must pass and emit a non-empty value. |
| `build.identityCommand` | Shell command used for identity. The default is `git rev-parse HEAD`. |
| `build.timeoutMs` | Identity-command timeout from 1 to 3,600,000 ms. The default is 30,000 ms. |
| `build.subject.path` | Workspace-relative regular file recorded as the build subject. |
| `build.subject.algorithm` | Must be `sha256`. |

The `build` object is optional, but when present `requireIdentity` is required. A `subject` requires both `path` and `algorithm`.

## Commands and gates

Each `commands.<name>` object requires:

| Field | Meaning |
|---|---|
| `run` | Non-empty shell command. |
| `timeoutMs` | Integer from 1 to 3,600,000. |
| `adapter` | `exit-code`, `playwright-json`, or `junit-xml`. |
| `reportPath` | **Required for `junit-xml`, rejected for every other adapter.** Where the runner writes its JUnit report, relative to the working directory. Absolute paths, drive letters, and `..` segments are refused. |

Each `gates.<name>` value is a non-empty, unique list of command names. A gated command is a hard project-level check even when no criterion maps to it.

## Oracles

| `kind` | Required fields | Rule |
|---|---|---|
| `command` | `command` | The referenced command must use the `exit-code` adapter. |
| `playwright` | `command`, `tag` | The command must use `playwright-json`; `tag` must match `^@dogfood:[A-Za-z0-9][A-Za-z0-9._-]*$`. |
| `junit` | `command`, `testcase` | The command must use `junit-xml`. `testcase` takes a required `name` and an optional `classname`. |
| `advisory` | none | May be used only by a judgmental criterion. It never changes the hard verdict. |

An exit-code oracle proves only that the complete named command exited 0. Do not use it for a claim that depends on one specific browser journey. A Playwright oracle proves the exact tag exists and that every matching execution passed on its first attempt. A JUnit oracle proves the named testcase exists in the report, has no `<failure>` or `<error>` child, and was not skipped.

Omitting `classname` matches on `name` alone. That is a *stricter* claim, not a weaker one: every matching testcase must pass, so a selector that matches three tests requires all three to be green.

## Acceptance criteria

Each item requires `id`, `class`, and `severity`.

| Field | Meaning |
|---|---|
| `id` | Stable name used by reports and exact Playwright tags. |
| `issue` | Optional non-empty external issue identifier. |
| `text` | Optional non-empty statement of the criterion. |
| `class` | `deterministic`, `judgmental`, or `excluded`. |
| `oracle` | Required for deterministic and judgmental criteria. |
| `reason` | Required for excluded criteria. |
| `severity` | `blocker`, `major`, or `minor`. It is metadata; every deterministic failure blocks. |

A deterministic criterion with no oracle is a failure, never a skip. It cannot use an advisory oracle. A judgmental criterion must use an advisory oracle. An excluded criterion has no proof and must explain why through `reason`.

The standard profile intentionally has no deterministic-criteria floor for compatibility. A contract containing only judgmental or excluded criteria can therefore execute no proof commands and still have no hard failure. Do not treat that PASS as release evidence; use an authoritative policy with `criteria.minimumDeterministic` and `criteria.requiredGates` for a protected gate.

For a deterministic Playwright criterion, the oracle tag must be exactly `@dogfood:<criterion id>`.

## Complete Playwright example

```yaml
version: 1
project: checkout-ui
description: Prove that a customer can finish checkout.

build:
  requireIdentity: true
  identityCommand: git rev-parse HEAD
  timeoutMs: 30000

commands:
  browser:
    run: npx playwright test --reporter=json
    timeoutMs: 600000
    adapter: playwright-json

gates:
  verification: [browser]

oracles:
  checkout-completes:
    kind: playwright
    command: browser
    tag: "@dogfood:AC-checkout"

acceptanceCriteria:
  - id: AC-checkout
    issue: SHOP-142
    text: A customer can complete checkout and see confirmation.
    class: deterministic
    oracle: checkout-completes
    severity: blocker
```

The Playwright configuration must write its JSON report to the file path in `PLAYWRIGHT_JSON_OUTPUT_FILE`; see the adapter documentation in the source template at `examples/playwright/playwright.config.mjs`.

## Complete architecture example

```yaml
version: 1
project: service-boundaries

commands:
  architecture:
    run: npm run test:architecture
    timeoutMs: 120000
    adapter: exit-code

gates:
  verification: [architecture]

oracles:
  architecture-boundaries:
    kind: command
    command: architecture
  design-review:
    kind: advisory

acceptanceCriteria:
  - id: AC-boundaries
    text: UI code does not import server-only modules.
    class: deterministic
    oracle: architecture-boundaries
    severity: major
  - id: AC-design-review
    text: The dependency layout is understandable to maintainers.
    class: judgmental
    oracle: design-review
    severity: minor
```

## Complete JUnit example

```yaml
version: 1
project: checkout-service
description: Prove specific tests, not a suite exit code.

commands:
  suite:
    run: pytest --junitxml=reports/junit.xml
    timeoutMs: 600000
    adapter: junit-xml
    reportPath: reports/junit.xml

gates:
  verification: [suite]

oracles:
  expired-card:
    kind: junit
    command: suite
    testcase:
      classname: tests.test_checkout
      name: test_rejects_expired_card

acceptanceCriteria:
  - id: AC-expired-card
    text: An expired card is refused at checkout.
    class: deterministic
    oracle: expired-card
    severity: blocker
```

`classname` and `name` must match what your runner emits. Run the suite once and read the generated
report to copy the exact strings. See [junit.md](junit.md) for runner flags and the guarantees this
adapter does and does not give you.

## Validation warnings

Warnings never affect the verdict. Dogfood records warnings when:

- a gated command has no deterministic criterion mapping;
- gates are empty while deterministic oracles still select commands;
- a command is unused by every gate and deterministic oracle;
- an oracle is unreferenced;
- a default policy exists but `--policy` was omitted;
- the optional build identity command does not pass; or
- a requested baseline has no contract yet and is treated as first adoption.
