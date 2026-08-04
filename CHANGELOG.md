# Changelog

All notable changes are documented here. Package versions, contract versions, policy versions, and manifest versions evolve independently.

## 0.4.0

The release that makes the core claim true. Before it, the bundle did not fully deliver the
tamper-evidence it advertised and the merge gate could be satisfied without the proof running.

### Added

- **`verify` reports a verification level, not a boolean.** A bundle whose checksums hold is
  `INTACT`; one whose detached signature verifies against an externally supplied key is
  `AUTHENTICATED`. `verificationLevel` is `integrity` or `provenance` accordingly. The two facts
  deserve two words: "the bundle is self-consistent" and "we know who produced it" are not the same
  claim, and collapsing them into one verdict is how a reader ends up trusting the wrong thing.
- **Signing metadata is validated, not just the signature.** `manifest.signing.signatureFile` must
  be exactly `manifest.sig`, and `publicKey` must actually encode an ed25519 key. Verifying a
  signature while trusting the block that describes it left a gap.
- **A JUnit XML adapter (`adapter: junit-xml`, `oracle kind: junit`).** Binds a criterion to a named
  `<testcase>` rather than to a suite's exit code, so any runner emitting JUnit XML — pytest,
  Vitest, Jest, gotestsum, Maven, Gradle, RSpec, PHPUnit — can carry deterministic evidence. A
  selector matching nothing is a FAIL, never a pass: `pytest -k "no_such_test"` exits 0, and that is
  the false green this adapter exists to kill. Outcomes are read from `<failure>`/`<error>`/
  `<skipped>` elements, never from the `<testsuite>` counters, which real emitters get wrong.
  Commands declare `reportPath` (there is no portable env var to inject, unlike Playwright); the
  path is cleared before the command runs, must stay inside the workspace, and is republished into
  the bundle under `evidence/junit-xml/`. The parser is a focused scanner in `src/junit.mjs` with no
  new dependency; it refuses `<!DOCTYPE>` outright, which structurally removes the billion-laughs
  entity-expansion vector rather than trying to count expansions.
- `NOTICE`, `docs/licensing.md`, and a filled-in copyright line in `LICENSE`, which still carried
  Apache's `[yyyy] [name of copyright owner]` placeholder. All seven shipped packages are MIT,
  BSD-3-Clause or ISC; no copyleft appears in the distributed tree.
- **Detached ed25519 manifest signatures.** `dogfood keygen`, `dogfood run --sign <key>`, and
  `dogfood verify <bundle> --key <key>`. The signature lives in `manifest.sig` and covers the exact
  on-disk bytes of `manifest.json`. Implemented with `node:crypto`; no new dependency.
- A source-backed documentation gate (`test/docs.test.mjs`) validating complete YAML examples, CLI
  coverage, schema-field coverage, links, and version references.
- Reference documentation under `docs/` for the CLI, contract, policy, artifacts, signing,
  Playwright evidence, advisory receipts, CI, agents, and examples.
- `action.yml`, a composite GitHub Action. Every input reaches the shell through `env`, never
  through `${{ }}` inside `run:`.
- `scripts/check-package-contents.mjs`, which actually inspects the published file list.

### Changed

- **Every format is numbered 1.** Contract, policy, manifest, report and the `latest.json` pointer
  all start at version 1. Nothing was ever published, so there is no version history to preserve and
  no reason for the first public release to open at v2/v3/v4. Pre-release bundles do not verify
  against this build; regenerate them.
- Default redaction patterns now cover credential-bearing URLs (`DATABASE_URL`, `REDIS_URL`,
  `MONGODB_URI`, `AMQP_URL`, `*_DSN`, `*_CONNECTION_STRING`, `*_URI`), cookies, and auth headers.
  They deliberately do **not** include a blanket `*_URL`: `BASE_URL` and `CI_PROJECT_URL` are
  diagnostics, and scrubbing them makes a FAIL bundle harder to read, which is the one job that
  bundle has.
- Log redaction is on by default instead of only under `--policy`, and reaches metadata command
  strings, adapter details, report bodies, and evaluation JSON rather than stdout and stderr alone.
- `validate` writes `latest-validate.json` instead of overwriting `latest.json`, so `report` shows
  the proof rather than the check.
- The self-gate's package check reads the real file list; it previously asserted only that
  `npm pack --dry-run` exited 0, behind an oracle named `package-contents`.
- `sha256`, `safeSegment`, and `formatAjvError` each collapse to one implementation.
- README drops from ~564 lines to ~150, with reference material moved into `docs/`.

### Fixed

- **Unrecorded files could be planted in a verifying bundle** if their path contained `.tmp-`.
  The exemption is gone; temp files are tracked and swept before the manifest is taken.
- **Symlinks were invisible to both the manifest and the verifier**, because a `readdirSync` Dirent
  for a symlink is neither `isFile()` nor `isDirectory()`. Enumeration is now lstat-based and
  `writeManifest` fails closed on any non-regular entry.
- **A Playwright command could fabricate its own evidence** by printing a JSON blob to stdout. The
  report path is now unlinked before the command runs.
- **The CI gate was ambiguous**: two check runs shared the name `dogfood / prove-it`, and the one
  carrying `fail-on-error: false` could never go red. Its `checks: write` requirement also made
  every fork PR permanently red.
- `--baseline-ref` reached `git show` unsanitized, where `--output=` is an arbitrary-file-write
  primitive. Leading dashes are rejected and the resolved OID is passed instead of the user string.
- **A contract format change could never pass its own baseline check.** A baseline contract that
  does not validate under the current schema was a blocking error, so the commit introducing any
  format change was permanently red — the tool was structurally unable to evolve its own format.
  It is now a stated warning with `baseline.compared: false` and a `notComparedReason`. This cannot
  hide a regression: a baseline is a past commit and immutable, so the only thing that can
  invalidate it is a schema change in the same reviewable change set, and the head contract, the
  criteria floor and the required gates are all still enforced. An *unparseable* baseline still
  blocks, because no format change explains it.
- **A criterion could report "[fail] — 3 matching execution(s) passed."** When a command failed for
  reasons unrelated to a given criterion, that criterion's detail was taken from its own selector,
  which had passed — producing a fail verdict beside a passing message. The detail now explains that
  the command did not pass, so its report cannot prove the criterion.
- `init --authoritative` wrote a policy that `run` then ignored; a warning now fires.
- Ordinary setup failures exit 1 instead of 4.
- `atomicWriteFile` fsyncs before rename and no longer forces mode 0600.
- Repositories with an unborn HEAD can produce a PASS.

### Breaking

- `verify`'s JSON verdict is now `INTACT` / `AUTHENTICATED` / `INVALID` rather than
  `VERIFIED` / `INVALID`. Anything parsing that field must be updated.
- A Playwright command that prints JSON to stdout without writing the configured report now fails.
- Bundles containing non-regular entries no longer verify.
- Leading-dash baseline refs are rejected as CLI usage errors.
- Pre-release manifest formats are not accepted; the first public format is version 1.
- Standard-mode logs now contain `[REDACTED]` where they previously carried raw values.

### Versions

Package 0.4.0 · contract **v1** · policy **v1** · report and manifest **v1**.

### Deferred to 0.5.0

- The generic JUnit-XML adapter. It is a new feature, and 0.4.0 is scoped to making the existing
  claims true.

## Before 0.4.0

Pre-release iteration. Contract, policy, and manifest formats changed several times and were never
published, so 0.4.0 renumbers all three to version 1 rather than advertising a history no user could
observe. There is no upgrade path to write, because there is nothing to upgrade from.
