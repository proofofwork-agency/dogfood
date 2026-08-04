# Dogfood project audit report

**Product:** `@proofofwork-agency/dogfood` 0.4.0  
**Date:** 2026-08-04  
**Scope:** Full repository review — `src/`, `bin/`, `schemas/`, `test/`, `docs/`, `templates/`, `examples/`, `action.yml`, website source, CI templates, package layout  
**Method:** Source review, security/trust-model walkthrough, docs↔code cross-check, dependency audit, full unit test run  
**Test result:** `npm test` — **133/133 pass** (≈25s)  
**Runtime deps audit:** `npm audit --omit=dev` — **0 vulnerabilities**

---

## Executive summary

Dogfood is a mature, carefully designed evidence-gate CLI. The **trust model for signing is honest and well implemented**: detached ed25519 signatures, exact-byte coverage of `manifest.json`, and an explicit rule that the public key *inside* a manifest is never a trust anchor. Mutation detection, Playwright first-attempt rules, policy non-auto-discovery, and bundle checksum hygiene are strong.

No silent “false green” of the form “missing oracle → skip” or “embedded key → trusted” was found in the runner.

The main issues fall into three buckets:

1. **UX / API wording that invites over-trust** — bare `verify` returns `verdict: "VERIFIED"` and exit 0 for unsigned or signature-unchecked bundles (integrity only).
2. **0.4.0 documentation and branding drift** — still talking about manifest v3, authoritative “v0.3”, missing help for `keygen`/`--sign`/`--key`, and a CHANGELOG claim about a non-existent policy field.
3. **Containment gaps** (mostly documented, but easy to misuse) — shell contracts, default redaction pattern gaps, unredacted files a command can drop into the run tree, and `report` trusting `latest.json` without re-verifying the bundle.

**Overall health score: 78/100** — production-usable core, with high-priority wording/docs fixes and a few integrity edge cases before calling the 0.4.0 surface fully tight.

| Area | Critical | High | Medium | Low / Info |
|------|----------|------|--------|------------|
| Trust / verify / signing | 0 | 1 | 3 | 4 |
| Security / redaction / execution | 0 | 1 | 4 | 3 |
| Correctness / race / reliability | 0 | 0 | 4 | 3 |
| Docs / CLI / branding | 0 | 2 | 6 | 5 |
| Tests / CI / packaging | 0 | 0 | 4 | 4 |
| Website / examples | 0 | 0 | 2 | 3 |

---

## Strengths (keep these)

1. **Signing trust model** — comments in `src/sign.mjs` / `src/verify.mjs` match behavior; `unverified` never upgrades trust; tests cover attacker re-sign.
2. **Bundle integrity** — unrecorded files/dirs fail verify; path-escape checks; symlink not traversed; report↔manifest cross-checks; normalized YAML digest checks.
3. **Policy never auto-loaded** — prevents silent profile flips; warning when default policy path exists without `--policy`.
4. **Mutation model** — coded problem kinds; shared initial-dirty literal; authoritative untracked allowlist; ignored files explicitly out of scope in the report.
5. **Playwright adapter** — clears report path before run; refuses stdout-as-evidence; first-attempt-only pass; redacted republish.
6. **Atomic writes + fsync**; private key mode `0600`.
7. **Baseline git safety** — control characters rejected; `--end-of-options`; only resolved OIDs passed to `git show`.
8. **Composite Action shell hygiene** — inputs via env, no `${{ }}` inside `run:` bodies.
9. **Small dependency surface** — ajv, ajv-formats, yaml only; signing via `node:crypto`.
10. **Docs tests** — contract/policy examples in docs must validate; CLI option names must appear in `docs/cli.md`.

---

## Critical findings

*None.* No trust-model inversion (self-signed-as-provenance), no missing-oracle skip, no sandbox claim that is false relative to `SECURITY.md`.

---

## High findings

### H1. `verify` exit code and `verdict: "VERIFIED"` conflate integrity with provenance

| | |
|---|---|
| **Where** | `src/verify.mjs` (`result()`), `bin/dogfood.mjs` verify path |
| **Issue** | Any checksum-consistent bundle returns `ok: true`, `verdict: "VERIFIED"`, exit **0**, whether `signatureStatus` is `absent`, `unverified`, or `verified`. Notices explain the limit; the top-level API does not. |
| **Why it matters** | CI that only checks exit code will treat unsigned or unchecked-signature bundles as fully “verified.” That is exactly the automation failure mode the trust-model comments warn against. |
| **Fix** | Prefer distinct verdicts (e.g. `INTACT` vs `AUTHENTICATED`), and/or `--require-signature` / policy for exit 0 only when `signatureStatus === "verified"`. At minimum print `signatureStatus` prominently in human output and document that exit 0 ≠ provenance in the help text. |

### H2. Default redaction misses common secret-bearing env names

| | |
|---|---|
| **Where** | `src/redact.mjs` `DEFAULT_LOG_POLICY`, `templates/dogfood.policy.yaml` |
| **Issue** | Patterns: `GITHUB_TOKEN`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_KEY`, `*_CREDENTIAL*`. Misses e.g. `AWS_ACCESS_KEY_ID`, `DATABASE_URL` / `*_URL`, `CONNECTION_STRING`, many cloud IDs. |
| **Why it matters** | Standard runs use these defaults. Stdout/stderr and Playwright reports can land cloud creds and DB URLs in uploaded bundles. |
| **Fix** | Extend defaults (`*_KEY_ID`, `*_URL`, connection/DSN patterns, common cloud names); keep documenting redaction as best-effort containment, not secret management. |

### H3. Manifest / security docs still describe v3; runtime is v4 with signing

| | |
|---|---|
| **Where** | `docs/artifacts.md` (“Manifest version 3”, “Manifest v3 is unsigned”), `SECURITY.md` (“manifest v3 bundle”) |
| **Issue** | Writer and verifier use **manifest version 4** only; v2/v3 are rejected. Layout docs omit `manifest.sig` and `signing`. |
| **Why it matters** | Security-sensitive operators and integrators get the wrong format story for 0.4.0. |
| **Fix** | Retitle to v4; document `signing`, detached `manifest.sig`, and that bare verify is integrity-only; point provenance to `verify --key`. |

### H4. Product self-branding still says v0.3

| | |
|---|---|
| **Where** | `.dogfood/dogfood.contract.yaml` description; `src/run.mjs` init README (“authoritative v0.3 profile”) |
| **Issue** | Package is **0.4.0**; self-contract and generated project README still say v0.3. |
| **Why it matters** | Confuses release audit and consumers who read the project’s own gate contract. |
| **Fix** | Update self-contract description; drop or update version in init README (“authoritative profile” / “Dogfood v0.4+”). |

---

## Medium findings

### M1. Commands can write unredacted secrets into the bundle tree

Log redaction covers `commands/*/stdout|stderr`, metadata, and adapter-republished reports. Any other file a command creates under the run directory is checksummed and published **without** redaction. Authoritative allowlists commonly include `artifacts/dogfood/**`, so mutation detection will not block those writes.

**Fix:** Document clearly; optionally refuse unexpected files under the run dir before manifest write; or require evidence only through Dogfood APIs.

### M2. `dogfood report` trusts `latest.json` without integrity re-check

Exit code comes from the pointer’s `verdict`, not from re-reading/verifying `summary.json` or the bundle. Path containment uses string prefix, not `realpath` — a symlink under `artifacts/dogfood/<path>` can escape. No `verifyBundle` call.

**Fix:** Realpath the run directory under the artifact root; derive exit from `summary.json` (or verified manifest); optionally verify before printing.

### M3. Hardlinks: produce-time refuse vs verify-time warning only

Writer throws on hardlinked entries; verifier **warns** and can still return VERIFIED. After a green verify, content can change via another hard link without re-running verify (point-in-time check).

**Fix:** Document as point-in-time; optional `--strict-hardlinks`; surface warnings more visibly in CLI.

### M4. Timeout path can hang if the process never emits `close`

On timeout: SIGTERM → 500ms → SIGKILL on the process group, then wait for `close`. If `close` never fires (stuck D-state / broken process group), the Promise never settles.

**Fix:** After SIGKILL, hard-resolve with `status: "infra"` after a short grace (e.g. 2–5s).

### M5. Unbounded memory for Playwright reports and advisory artifacts

Logs are capped at 5 MiB; Playwright reports and advisory artifacts are fully read into memory with no size cap.

**Fix:** Max sizes; stream hashing on large verify paths where needed.

### M6. `latest.json` pointer race

Read–compare–write on `startedAt` is not atomic. Concurrent runs sharing a workspace can lose updates.

**Fix:** File lock or compare-and-swap rename; document single-writer expectation for CI.

### M7. Contract command name `_build-identity` can collide

Synthetic identity command always uses `_build-identity`. Schema allows that name. Results share one Map key (last wins).

**Fix:** Reserve `_build-identity` / `_*` in validation, or use an internal id that cannot appear in contracts.

### M8. Built-in `dogfood help` omits signing / keygen

Help lists init/validate/run/verify/migrate/report but not `keygen`, `--sign`, `--key`, `--out`. `docs/cli.md` is complete; offline help is not.

**Fix:** Align help with CLI docs; add a test that help mentions every command.

### M9. `docs/cli.md`: `--force` listed only for `init`

Code allows `--force` on `init` **and** `keygen`.

### M10. CI template mentions non-existent `junit-xml` adapter

`templates/ci/dogfood.yml` comment: “exit-code or **junit-xml**”. Only `exit-code` and `playwright-json` exist; JUnit-XML is deferred to 0.5.0 in CHANGELOG.

### M11. CHANGELOG invents policy `signing.required`

`CHANGELOG.md` claims `signing.required` is additive on the policy. Schema and code have no such field (strict schema would reject it).

### M12. Composite Action: no public-key verify path; uploads whole tree

`action.yml` can sign (`sign-key`) but verify step never takes `--key`. Upload path is entire `artifacts/dogfood/` (all historical runs), not only the current bundle.

### M13. Docs claim repo workflow ≈ template; they diverge

`docs/ci.md` describes the repository gate (matrix + fixture job + prove-it). Starter template is thinner. Consumers may think they have the same gate.

### M14. Playwright example config incomplete vs docs

Docs show JSON reporter config; shipped example relies on CLI `--reporter=json` + env. Dropping the CLI flag → missing-report FAIL.

### M15. Test coverage gaps on marketed rules

- No explicit test that deterministic `severity: minor` failure still FAIL.
- No nested-suite Playwright tag test.
- No test that CLI help lists all commands.
- `verify.test.mjs` names a “v3” bundle but asserts **v4**.
- Concurrent pointer test uses a fixed short delay (flake risk under load).

### M16. `docs.test.mjs` soft-skips missing docs

If `docs/cli.md` (or schema docs) are missing, tests return with a diagnostic instead of failing — risky now that docs ship in the package.

### M17. Large untracked files: content changes with same size not detected

Untracked files **> 8 MiB** store only size (`digestSkipped: true`). Same-size content rewrite is invisible to authoritative mutation detection.

### M18. Website ProofChain tabs always reset to scenario 0

`onClick={() => dispatch("reset")}` never selects scenario index 1; dots look interactive but are not.

---

## Low findings

| ID | Issue |
|----|--------|
| L1 | Human `verify` output does not print `signatureStatus` explicitly. |
| L2 | `manifest.signing.keyId` / `signatureFile` not cross-checked on verify. |
| L3 | Signing block shape barely validated in `validateManifest`. |
| L4 | Untracked digest cache is process-global; `resetUntrackedDigestCache` not called at run start. |
| L5 | Git inspection inherits ambient `GIT_*` env (can redirect the inspected repo). |
| L6 | `migrate --write` uses non-atomic `writeFileSync` after backup. |
| L7 | Redaction is exact substring only (no base64/URL-encoding variants). |
| L8 | Playwright report TOCTOU after process exit (concurrent local plant). |
| L9 | Subject verify allows symlinks (`statSync`); build-time subject inspection rejects them. |
| L10 | README hedges “once CONTRIBUTING is present” — file already exists. |
| L11 | Website OG image `dogfood-social.png` referenced but missing under `static/img/`. |
| L12 | Example trees leave large local `artifacts/` (gitignored); noise for developers. |
| L13 | `examples/minimal/checks/fail.mjs` appears unused; `browser.mjs` naming confuses with Playwright. |
| L14 | No JSON Schema for `manifest.json` / `summary.json` for integrators. |
| L15 | Shell execution of contracts is total RCE for untrusted contracts — **by design** (`SECURITY.md`); still a misuse risk in PR CI without CODEOWNERS. |

---

## Intentional non-goals (not bugs)

These are correctly documented or deliberately scoped:

- No sandbox around contract commands.
- Git-ignored files outside mutation guarantee (`ignoredFilesCovered: false`).
- Advisory assessments never change hard verdict; malformed `--evidence` **does** fail.
- Bare verify without `--key` is integrity-only (design); the problem is **wording/exit semantics** (H1), not the crypto.
- Standard-mode mutation focuses on tracked scope under `--cwd`.
- Playwright fixture intentionally outside default `npm test` (needs browser).

---

## Package / supply chain snapshot

| Item | Status |
|------|--------|
| Runtime dependencies | ajv ^8.20.0, ajv-formats ^3.0.1, yaml ^2.9.0 |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Engines | Node ≥ 20 |
| Published files | bin, src, schemas, templates, docs, selected examples (no example artifacts), security docs |
| Example artifacts | gitignored (`examples/*/artifacts/`) |
| Website build | gitignored; source only tracked |

---

## Recommended remediation order

### P0 — before calling 0.4.0 messaging “done”

1. **H3** Fix `docs/artifacts.md` + `SECURITY.md` to manifest **v4** + signing layout.  
2. **H4** Fix self-contract + init README version strings.  
3. **H1** Clarify verify verdict/exit vs provenance (API change or loud CLI + docs).  
4. **M8 / M9** Complete `dogfood help` and `docs/cli.md` `--force` for keygen.  
5. **M11** Remove or implement CHANGELOG `signing.required`.  
6. **M10** Fix junit-xml comment in CI template.

### P1 — integrity / ops hardening

7. **H2** Expand default redaction patterns.  
8. **M1 / M2** Side-file redaction docs/guards; harden `report` path + integrity.  
9. **M4** Timeout hard ceiling after SIGKILL.  
10. **M12** Action: optional verify public key; upload single bundle path.  
11. **M7** Reserve `_build-identity`.

### P2 — quality bar

12. **M15 / M16** Tests: severity, help completeness, rename v3 test, fail if docs missing.  
13. **M5 / M6 / M17** Evidence size limits; pointer CAS; large-untracked note or stronger detection.  
14. **M14 / M13** Align Playwright example + CI docs.  
15. **M18 / L11** Website ProofChain tabs + OG image.

---

## Per-area notes

### Core runner (`src/`)

Generally high quality: clear error types, invariant guards (`ReportInvariantError`), careful comments on security-sensitive paths. Residual risks are mostly **process boundaries** (shell, env, concurrent writers) and **resource bounds**.

### CLI (`bin/dogfood.mjs`)

Parsing is strict (unknown options, single-use flags, timeout range). Help text lags features. `report` is the weakest integrity path.

### Schemas

Contract/policy/advisory-receipt schemas are strict and match semantic validation well. Missing: manifest/summary schemas; non-existent `signing.required` in CHANGELOG only.

### Tests

Strong for signing, verify, policy, adapters, workflow shell hygiene. Gaps on marketing claims (severity), help completeness, and some naming drift (v3 vs v4).

### Website

Marketing copy matches product philosophy well. Interactive ProofChain tab bug and missing social image are polish issues.

---

## Health score rationale

| Component | Score | Notes |
|-----------|------:|-------|
| Trust model correctness | 90 | Crypto + design solid; VERIFIED wording undercuts it |
| Code correctness | 85 | Tests green; edge races/timeouts remain |
| Security containment | 72 | Shell TCB + redaction defaults + side files |
| Docs accuracy (0.4.0) | 60 | v3/v0.3 drift, help gaps |
| Test coverage | 80 | Good core; claim-level gaps |
| Ops / CI ergonomics | 75 | Action upload + no verify-key |
| **Weighted overall** | **78** | |

---

## Conclusion

This is a **serious evidence-gate product** with unusually careful signing and integrity design. The 0.4.0 remediation branch already shows deep attention to trust-model comments and tests.

What still hurts credibility for a 0.4.0 release is not a broken crypto primitive, but **operator-facing drift and over-trustable wording**: docs saying v3, help omitting signing, verify saying `VERIFIED` for unsigned bundles, and redaction defaults that miss common secret names.

Address P0 first (docs, help, branding, verify semantics messaging). Then harden containment and CI packaging (P1). Treat website and schema niceties as P2.

---

*Report generated by full-project review. No product code was modified for this report.*
