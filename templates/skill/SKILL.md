---
name: dogfood
description: Validate and run the portable Dogfood evidence gate without repairing product code or tests.
---

# Dogfood evidence gate

Use this skill after implementation when the user needs deterministic acceptance evidence.

1. Run `dogfood validate` from the project workspace.
2. If validation passes, run `dogfood run`.
3. Read `artifacts/dogfood/latest.json` and the referenced `summary.md`.
4. Report the verdict, acceptance-criterion matrix, failing commands, and evidence path.

Rules:

- Missing oracle is a failure.
- A process exit code does not substitute for structured Playwright evidence.
- Do not edit product code or tests during the Dogfood run to make it green.
- On `FAIL`, use the report in a separate implementation or specification workflow.
- On `INFRA_ERROR`, recover the environment and start a fresh complete run.
- Advisory browser receipts never override deterministic results.

Useful commands:

```bash
dogfood validate
dogfood run
dogfood run --evidence path/to/advisory-receipt.json
dogfood report
```
