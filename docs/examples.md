# Shipped examples

Run these from a repository checkout after `npm ci`. Generated evidence stays under each example's `artifacts/dogfood/` directory.

## Minimal command adapters

[examples/minimal](https://github.com/proofofwork-agency/dogfood/tree/main/examples/minimal) contains architecture and product commands, deterministic command oracles, one judgmental criterion, and one excluded criterion.

```bash
cd examples/minimal
node ../../bin/dogfood.mjs run
```

Observed result: exit 0 and `PASS`; both deterministic criteria pass, the usability criterion is advisory, and the explicitly excluded criterion remains excluded.

## Deliberately broken contract

[examples/minimal-broken](https://github.com/proofofwork-agency/dogfood/tree/main/examples/minimal-broken) plants a deterministic criterion with no oracle.

```bash
cd examples/minimal-broken
node ../../bin/dogfood.mjs run
```

Observed result: exit 1 and `FAIL` during validation. No proof command is executed. This fixture pins the rule that missing oracle is a failure, never a skip.

## Named testcases from JUnit XML

[examples/junit](https://github.com/proofofwork-agency/dogfood/tree/main/examples/junit) binds two criteria to two named testcases. A small Node script stands in for pytest, Vitest or gotestsum, so the example needs no Python, Go or JVM toolchain — JUnit XML is all any of them contributes to a proof.

```bash
cd examples/junit
node ../../bin/dogfood.mjs run
```

Observed result: exit 0 and `PASS`; both criteria are proven by name. Break one test and only its criterion reports the failing testcase:

```bash
DOGFOOD_EXAMPLE_BREAK="applies the bulk discount" node ../../bin/dogfood.mjs run
```

Observed result: exit 1 and `FAIL`. `AC-bulk-discount` names the testcase that broke. Renaming a test in `checks/suite.mjs` without updating the contract also fails — the selector matches nothing, and a selector matching nothing is never a pass.

## Exact Playwright evidence

[examples/playwright](https://github.com/proofofwork-agency/dogfood/tree/main/examples/playwright) combines an architecture command with an exact `@dogfood:AC-checkout` browser tag.

```bash
cd examples/playwright
node ../../bin/dogfood.mjs run
```

Observed result: exit 0 and `PASS`; one tagged checkout execution passes on its first attempt. This example requires `@playwright/test` and an installed Chromium browser. A consuming project must install those separately because Playwright is a development dependency of this repository, not a Dogfood runtime dependency.

From the repository root, the stronger fixture also plants and removes a failure:

```bash
npm run test:playwright-fixture
```

