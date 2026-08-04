# JUnit XML example

Binds two acceptance criteria to two **named testcases** rather than to a suite's exit code.

`checks/suite.mjs` stands in for pytest, Vitest, gotestsum or Maven — it runs three assertions and
writes JUnit XML. Every one of those runners contributes exactly that to a proof, so this example
needs no Python, Go or JVM toolchain.

```bash
cd examples/junit
node ../../bin/dogfood.mjs validate
node ../../bin/dogfood.mjs run
```

## What it demonstrates

Run it once and both criteria pass. Then break one test by name:

```bash
DOGFOOD_EXAMPLE_BREAK="applies the bulk discount" node ../../bin/dogfood.mjs run
```

`AC-bulk-discount` fails with the testcase that broke it. The point is the *binding*: the criterion
is tied to one testcase, so the summary names the test that failed instead of reporting that a
suite exited non-zero.

## The failure that matters most

Rename a test in `checks/suite.mjs` without updating the contract, and the criterion **fails** —
the selector matches nothing, and a selector matching nothing is never a pass. That is the false
green this adapter exists to kill: `pytest -k "no_such_test"` matches zero tests and exits 0.

## Wiring a real runner

Only the `run` line and `reportPath` change:

| Runner | `run` |
|---|---|
| pytest | `pytest --junitxml=reports/junit.xml` |
| Vitest | `vitest run --reporter=junit --outputFile=reports/junit.xml` |
| Go | `gotestsum --junitfile=reports/junit.xml ./...` |
| Maven | `mvn test` (writes `target/surefire-reports/*.xml`; point `reportPath` at one file) |

`classname` and `name` must match what the runner emits. Run once and read the generated
`reports/junit.xml` to see the exact strings.
