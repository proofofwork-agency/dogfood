# Changelog

All notable changes are documented here. Package versions, contract versions, policy versions, and manifest versions evolve independently.

## Unreleased

### Added

- A source-backed documentation gate that validates complete YAML examples, CLI coverage, schema-field coverage, links, and current documentation version references.
- Reference documentation for the CLI, contract, policy, artifacts, Playwright evidence, advisory receipts, CI, agents, and examples.

### Changed

- Documentation now states the trust boundaries of unsigned manifests, executable contracts, Git-ignored files, warnings, and deterministic severity.
- `docs/` is included in the package allowlist.

### Fixed

- Bundle verification rejects unrecorded temp-named entries and symbolic-link escapes.
- Playwright stdout can no longer stand in for report-file evidence.
- Baseline refs are resolved safely before Git reads the contract.
- Standard runs redact logs by default, validate no longer replaces the run pointer, and CI exposes one unambiguous final gate.
- Mutation problems use stable codes, advisory-input failures are classified separately, and report repository snapshots share one shape.

### Breaking

- A Playwright command that prints JSON to stdout without writing the configured report now fails.
- Bundles containing non-regular entries no longer verify.
- Leading-dash baseline refs are rejected as CLI usage errors.

The package remains at 0.3.0 until the remediation release is cut. Contract version remains 2, policy version remains 1, and manifest version remains 3.

## 0.3.0

- Added the explicit authoritative policy profile, baseline regression checks, Git-root mutation rules, log controls, and protected CI templates.

## 0.2.0

- Added the version 2 proof contract, exact command and Playwright adapters, portable artifact bundles, migration, reporting, and offline verification.

