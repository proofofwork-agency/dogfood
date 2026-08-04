# Contributing

Dogfood is a Node 20+ ESM CLI. Tests use the built-in `node:test` runner; there is no Jest or Vitest layer.

## Setup

```bash
npm ci
npx playwright install --with-deps chromium
```

Runtime dependencies are intentionally limited to `ajv`, `ajv-formats`, and `yaml`. Discuss new runtime dependencies before adding them. This is why the Playwright and JUnit report readers are hand-written rather than delegated to a parser library; see `docs/licensing.md` for what ships and under which licence.

Contributions are accepted under the Apache License 2.0. Adding a dependency under a copyleft licence needs explicit sign-off — everything shipped today is MIT, BSD-3-Clause or ISC.

## Repository layout

- `bin/` — CLI parsing and presentation
- `src/` — runner, adapters, validation, policy, reports, and verification
- `schemas/` — closed JSON schemas
- `templates/` — files installed by `dogfood init`
- `examples/` — runnable fixtures
- `test/` — `node:test` unit and integration coverage
- `.dogfood/` — the repository's own contract and authoritative policy

## Verification

```bash
npm test
npm run test:self
npm run test:playwright-fixture
```

`package.json` enumerates every `test/*.test.mjs` file because Node 20 and Windows shell behavior make implicit globs unreliable. When adding a test file, add it to `scripts.test`; `test/meta.test.mjs` enforces exact synchronization.

Before release from a clean checkout, run the repository's own authoritative gate:

```bash
node bin/dogfood.mjs validate --policy .dogfood/dogfood.policy.yaml
node bin/dogfood.mjs run --policy .dogfood/dogfood.policy.yaml
node bin/dogfood.mjs verify artifacts/dogfood/<run-id>
```

Authoritative mode intentionally rejects a repository that starts with tracked changes. The `criteria.minimumDeterministic` value in `.dogfood/dogfood.policy.yaml` must stay synchronized with the contract's deterministic criterion count.

Do not publish from an unreviewed working tree. Package contents are checked by `scripts/check-package-contents.mjs` and the self-gate.

