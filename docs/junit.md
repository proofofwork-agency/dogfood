# JUnit XML adapter

Binds an acceptance criterion to **a named testcase** in a JUnit XML report, rather than to a
suite's exit code. It works with anything that emits JUnit XML: pytest, Vitest, Jest, Go via
gotestsum, Maven/Gradle, JUnit itself, RSpec, PHPUnit.

## Why it exists

The `exit-code` adapter proves only that a command exited 0. That is a real gap:

```bash
pytest -k "checkout_expired"    # matches zero tests, exits 0, looks like a pass
```

A JUnit oracle closes it. **A selector matching nothing is a FAIL, never a pass.**

## Contract shape

```yaml
commands:
  suite:
    run: pytest --junitxml=reports/junit.xml
    timeoutMs: 600000
    adapter: junit-xml
    reportPath: reports/junit.xml

oracles:
  expired-card:
    kind: junit
    command: suite
    testcase:
      classname: tests.test_checkout
      name: test_rejects_expired_card
```

### Why `reportPath` and not an environment variable

The Playwright adapter injects `PLAYWRIGHT_JSON_OUTPUT_FILE`, so the contract never names a path.
There is no equivalent for JUnit — the flag is per-runner:

| Runner | Command |
|---|---|
| pytest | `pytest --junitxml=reports/junit.xml` |
| Vitest | `vitest run --reporter=junit --outputFile=reports/junit.xml` |
| Jest | `jest --reporters=jest-junit` (path via `JEST_JUNIT_OUTPUT_FILE`) |
| Go | `gotestsum --junitfile=reports/junit.xml ./...` |
| Maven | `mvn test` → `target/surefire-reports/TEST-*.xml` |
| Gradle | `gradle test` → `build/test-results/test/TEST-*.xml` |
| RSpec | `rspec --format RspecJunitFormatter --out reports/junit.xml` |
| PHPUnit | `phpunit --log-junit reports/junit.xml` |

So the contract declares the path instead, and Dogfood enforces what the missing injection would
otherwise have guaranteed:

- **The path is cleared before the command runs.** A report present afterwards was written by this
  command — an earlier command cannot pre-plant it, and a stale report from yesterday cannot pass.
- **The path must stay inside the working directory.** Absolute paths, drive letters and `..`
  segments are refused by the schema. Containment is re-checked against the real path *after* the
  command runs, so a command that turns the report directory into a symlink is caught too.
- **The report is republished into the bundle** at `evidence/junit-xml/<command>.report.xml`, where
  the manifest checksums it. The evidence you can verify is the evidence that was read.

## What passes

A testcase proves its criterion when **all** of these hold:

- at least one testcase matches the selector;
- every match has no `<failure>` and no `<error>` child;
- no match is `<skipped>`;
- the command itself exited 0.

`classname` is optional. Omitting it matches on `name` alone, which is *stricter* — every match must
pass, so a selector hitting three tests requires all three.

### Outcomes come from elements, not counters

A `<testsuite>` header claiming `failures="0"` over a body containing `<failure>` is something real
emitters produce. Dogfood reads the child elements. The counters are recorded in the evaluation for
diagnostics and are never trusted for the verdict.

### A failing command fails every criterion bound to it

If the suite exits non-zero, criteria bound to testcases that *passed* still fail, with a detail
saying so explicitly. This is deliberate: a runner that exits non-zero may have written a partial
report, and no adapter can distinguish "one test failed" (report complete) from "the runner crashed
at import time" (report truncated) without runner-specific knowledge it does not have. Failing
closed is the doctrine.

## What this adapter does *not* give you

**No tag-to-criterion binding.** A Playwright oracle must use the tag `@dogfood:<criterion-id>`, so
the test itself names the criterion it proves and the two cannot drift apart silently. A JUnit
selector names a foreign runner's own testcase, which Dogfood cannot rename or constrain.

Renaming a test therefore unbinds its criterion — but that **fails** (the selector matches nothing);
it never silently passes. The failure direction is safe; the maintenance burden is real. If you
control the test names, encoding the criterion id in them is worth doing.

## The parser

There is no XML dependency — runtime deps stay `ajv`, `ajv-formats`, `yaml`. `src/junit.mjs` is a
focused scanner over the elements an oracle needs.

Two of its refusals are security rather than pedantry:

- **A `<!DOCTYPE>` is rejected outright.** Entity expansion ("billion laughs") is the classic XML
  denial of service, and the structural defence is to have no entity table at all: with no DOCTYPE
  accepted, no entity can be declared, so decoding is a single non-recursive pass over the five
  predefined names plus numeric character references. JUnit XML has no legitimate DOCTYPE.
- **Attribute values are read to their closing quote by index**, never by scanning ahead for `>`, so
  a `>` inside a test name cannot terminate the tag early and smuggle markup into the document.

It also handles what real emitters produce: nested `<testsuite>` elements, namespace prefixes,
CDATA and comments containing testcase-like text, self-closing tags, and UTF-8 / UTF-16 byte order
marks. Reading a UTF-16 file as UTF-8 would yield "no testcases", which is a silently wrong answer,
so the BOM is honoured rather than ignored.

Reports are capped at 50 MiB, checked before the file is read into memory. Nesting is capped at 100
levels. Anything malformed is a parse error, and a parse error is a FAIL.

**Note on licensing:** the format is not JUnit the library. Dogfood ships no JUnit code and takes on
no JUnit licence obligation — it reads a file format, the same way a CSV parser does not distribute
a spreadsheet. See [licensing.md](licensing.md).

## Authoritative mode

A `junit-xml` command writes into the working tree, which authoritative mode reads as an untracked
mutation. Allowlist the report path in your policy:

```yaml
mutation:
  allowUntracked:
    - "reports/**"
```

Dogfood emits a validation warning when a declared `reportPath` is not covered. It does not widen
the allowlist for you: what a verification run may write to is the policy's decision, not the
contract's.

## Try it

`examples/junit/` runs the whole loop with no Python, Go or JVM toolchain — a small Node script
stands in for the runner, because JUnit XML is all any of them contributes to a proof.

```bash
cd examples/junit
node ../../bin/dogfood.mjs run

# watch one criterion go red while the other stays green
DOGFOOD_EXAMPLE_BREAK="applies the bulk discount" node ../../bin/dogfood.mjs run
```
