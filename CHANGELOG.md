# Changelog

All notable changes are documented here. Package versions, contract versions, policy versions, and manifest versions evolve independently.

## 0.4.0

The release that makes the core claim true. Before it, the bundle did not fully deliver the
tamper-evidence it advertised and the merge gate could be satisfied without the proof running.

### Added

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

- **Manifest and report go to version 4.** Signing needs a field the closed v3 manifest schema had
  no room for, and the package was still unpublished, so the format break was free exactly once.
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
- `init --authoritative` wrote a policy that `run` then ignored; a warning now fires.
- Ordinary setup failures exit 1 instead of 4.
- `atomicWriteFile` fsyncs before rename and no longer forces mode 0600.
- Repositories with an unborn HEAD can produce a PASS.

### Breaking

- A Playwright command that prints JSON to stdout without writing the configured report now fails.
- Bundles containing non-regular entries no longer verify.
- Leading-dash baseline refs are rejected as CLI usage errors.
- **v2 and v3 bundles no longer verify** and report rerun guidance. They predate the signed format.
- Standard-mode logs now contain `[REDACTED]` where they previously carried raw values.

### Versions

Package 0.4.0 · contract **v2, unchanged** · policy **v1, unchanged** (`logs.capture: "full"` and
`signing.required` are additive) · report and manifest **3 → 4**.

### Deferred to 0.5.0

- The generic JUnit-XML adapter. It is a new feature, and 0.4.0 is scoped to making the existing
  claims true.

## Before 0.4.0

Pre-release iteration. Contract, policy, and manifest formats changed several times and were never
published, so 0.4.0 renumbers all three to version 1 rather than advertising a history no user could
observe. There is no upgrade path to write, because there is nothing to upgrade from.
