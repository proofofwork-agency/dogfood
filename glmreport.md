# Dogfood — full-project flaw & issue report

**Scope:** `@proofofwork-agency/dogfood` v0.4.0 (`/…/testo`), portable evidence-gate CLI (Node.js, ESM, no build step).
**Method:** source review of `bin/`, `src/`, `schemas/`, `templates/`, `examples/`, `.github/`; doc/contract/CLI cross-check; `npm test` (133/133 pass); `dogfood validate` + `dogfood run` on the repo's own self-gate (PASS). All findings cite `file:line` and were verified against current source unless noted.
**Date:** 2026-08-04.

## Summary

| Domain | Critical | High | Medium | Low/Info |
|---|---|---|---|---|
| Integrity / verify / signing | 0 | 1 | 2 | 4 |
| Mutation detection & command execution | 0 | 1 | 4 | 2 |
| Docs / CLI / branding consistency | 0 | 2 | 4 | 4 |
| Packaging / repo hygiene | 0 | 0 | 2 | 2 |

**Health score: 72/100 — solid, honest, well-tested foundation, but the 0.4.0 signing release is only half-landed (docs/help/branding lag the code), the verify path has one real provenance TOCTOU, and the headline "edits tracked files ⇒ FAIL" guarantee is net-diff-only and is stated more strongly than the code delivers.**

---

## Critical / High

### H1. Provenance TOCTOU — `manifest.json` is read twice; signature is verified over different bytes than the checksums were validated against
- **File:** `src/verify.mjs:23` (parse + checksum walk) vs `src/verify.mjs:149` (signature read), see `verifyBundle` at `:14` and `checkSignature` at `:127`.
- **Issue:** The manifest is parsed once at line 23 and its `checksums` are validated against the bundle files (lines 38–55). Then at line 149 it is read **a second, independent time** to verify the detached signature. There is no guarantee the two reads return identical bytes. Between the reads the verifier performs the whole checksum walk, `listBundleEntries`, two `verifyNormalizedDocument` passes, and the subject/`summary.json` reads — a wide synchronous-I/O window.
- **Impact:** An attacker with concurrent write access to the bundle directory (shared/CI/network storage — exactly the "a malicious actor can regenerate the manifest" scenario the tool warns about) can swap `manifest.json` between the two reads: present a manifest whose checksums match attacker-controlled files for the first read, then swap in a legitimately-signed manifest from a prior run before line 149. Result: `signatureStatus = "verified"`, exit 0 — provenance asserted for files the trusted signer never signed. This directly undermines the headline ed25519/detached-signature guarantee.
- **Threat-model caveat:** requires write access to the bundle dir during verify. Even without an adversary this is a latent correctness defect.
- **Fix:** read the manifest bytes once into a `Buffer`, reuse that same buffer for both `JSON.parse` and `verifyManifestSignature`.

### H2. `dogfood help` omits the `keygen` command and every signing flag — the 0.4.0 headline feature is invisible from `--help`
- **File:** `bin/dogfood.mjs:350-376` (`printHelp`); `COMMANDS` at `:14` and `OPTION_SPECS` at `:21-23` do define `keygen`, `--sign`, `--key`, `--out`.
- **Issue:** Verified live: `dogfood help` prints only `init/validate/run/verify/migrate/report/version/help` and contains no occurrence of `keygen`, `--sign`, `--key`, or `--out`. `docs/cli.md` documents all of them, so the binary's own help is the outlier.
- **Impact:** users cannot discover key generation or signing from the CLI's own usage text; the trust model's central mechanism is undocumented in-place.

### H3. Bundle-format docs are a full major version behind: "Manifest version 3 … unsigned" while code emits/requires v4 and supports signing
- **Files:** `docs/artifacts.md:36` (`## Manifest version 3`), `docs/artifacts.md:38` (field list omits `signing`), `docs/artifacts.md:40` (claims only `manifest.json` is exempt from checksums — but `manifest.sig` is also exempt, `src/verify.mjs:75`), `docs/artifacts.md:48` ("Manifest v3 is unsigned"), `SECURITY.md:9` ("manifest v3 bundle").
- **Issue:** `src/report.mjs:177,96,148` write `version: 4`; `src/verify.mjs:182` rejects anything `!== 4`; `src/verify.mjs:27-29` treats v2/v3 as legacy. `CHANGELOG.md:65-66` itself records "report and manifest 3 → 4". The canonical bundle-format reference is therefore stale relative to both the code and the changelog, and asserts "unsigned" for a format that now carries `manifest.signing` (`src/report.mjs:202`).

---

## Medium

### M1. Snapshot-based mutation detection is net-diff only; "edits tracked files ⇒ FAIL" is stronger than the code delivers
- **Files:** `src/repository.mjs:107-113` (`repositoryStateChanged`), `src/run-commands.mjs:164-172` (before/after capture), `src/run.mjs:222-232` (redundant global cross-check, also a net diff).
- **Issue:** Mutation enforcement is a before/after git snapshot compare (`head` + `diffDigest`). A verification command (or the project's own test script, including `pretest`/`posttest` hooks, or any `playwright.config` reporter) can: edit a tracked file → run the now-passing test → revert the file (`git checkout -- .`, `git stash`/`pop`, or rewrite byte-for-byte). `head` and `diffDigest` are then identical ⇒ `mutationDetected = false` ⇒ status `pass`. This holds in **both** standard and authoritative modes; neither mode observes intermediate writes. `README.md:34` ("A command that edits tracked files during its own proof fails") and `AGENTS.md` ("mutation detection fails the run regardless") overstate what the code guarantees.
- **Fix path:** this is fundamental to snapshot detection; the actionable fix is to correct the docs to say "net change" and stop claiming in-place revert is caught.

### M2. `artifacts/` (the evidence store itself) sits inside the git-ignored blind spot
- **Files:** `.gitignore:2` (`artifacts/`); `src/repository.mjs:38` (`--exclude-standard`), `:35-37` (status/diff don't see ignored paths); `src/report.mjs:121` (`ignoredFilesCovered: false`).
- **Issue:** `dogfood init`'s own `gitignore.fragment` ignores `artifacts/dogfood/`, and the repo does the same. Because ignored paths are a total blind spot for mutation detection, a verification command can create/modify/delete anything under `artifacts/` during a run without ever tripping detection. The README honestly discloses the ignored blind spot generally, but not this self-referential case (the evidence being produced lives inside it).

### M3. Untracked-file detection is defeatable (size+mtime cache key; >8 MB files get `digest: null`)
- **Files:** `src/repository.mjs:270-292` (`untrackedFileEntry`, process-lifetime memo keyed on `${path}\0${size}\0${mtimeNs}`), `:15` (`MAX_UNTRACKED_DIGEST_BYTES = 8*1024*1024`), `:278-282`, `:154-165`.
- **Issue:** The after-snapshot re-`lstat`s and, on a matching path+size+mtimeNs key, returns the **memoized** digest without re-hashing. A command can rewrite an untracked file preserving size and restore `mtimeNs` via `utimes`/`lutimes`, hitting the cache ⇒ no mutation. Independently, any untracked file >8 MB is recorded as `{size, digest: null, digestSkipped: true}`; two snapshots of the same size compare equal regardless of content. The inline comment at `:283-284` admits the gap. `resetUntrackedDigestCache` (`:274`) is never called between commands in `run-commands.mjs`.
- **Impact:** authoritative mode's "non-ignored untracked file changed ⇒ FAIL" guarantee is bypassable for same-size files (trivial for text/configs/fixtures) and for any >8 MB file.

### M4. `runCommand` can hang forever when an orphaned grandchild holds the stdio pipes
- **Files:** `src/run-commands.mjs:24-31` (`detached`, `shell:true`, piped stdio), `:69-93` (`terminate`, `forceKillTimer`, `close` handler).
- **Issue:** On timeout/abort the code SIGTERM/SIGKILLs the child process group (`process.kill(-pid)`). A grandchild that calls `setsid()` starts a new session and is not signalled, yet inherits the child's stdout/stderr pipe FDs. Node only emits `close` after all write ends close; with the grandchild holding them, `close` never fires, `closeResult` stays `null`, and the `forceKillTimer`'s `if (closeResult) finish(...)` never resolves. `runNamedCommands` then `await`s a promise that never settles → `dogfood run` hangs with no further timeout.
- **Impact:** a verification command that spawns a detached `setsid` worker pins the run permanently (DoS; CI job must be killed externally, no usable verdict).

### M5. Hard-link detection is fatal at write time but downgraded to a non-blocking warning at verify time
- **Files:** `src/verify.mjs:67-73` (warning) vs `src/report.mjs:166-168` (`throw BundleIntegrityError`).
- **Issue:** At bundle creation a second hard link throws; at verify the same condition only pushes a `warning`, so `ok` stays `true` and the verdict stays `VERIFIED` (exit 0). The verify comment (`:68`) says an archiver may legitimately hardlink. An attacker can take a clean bundle, add an external hard link (`ln bundle/summary.json /elsewhere/twin`), pass `verify` (exit 0), then mutate `/elsewhere/twin` to rewrite the bundle file in place via the shared inode — the archived "evidence" then no longer matches the manifest checksums despite having already passed the gate. This is the "hard condition downgraded to a warning that changes the verdict" pattern.

### M6. Default (standard-mode) command-log capture is **unredacted** — secrets in command output land in the bundle
- **Files:** `src/redact.mjs:13-16` (`createRedactor` returns the no-redaction path when `logs` is null or `capture === "full"`); `templates/dogfood.policy.yaml` ships `capture: "full-redacted"` but policies are opt-in.
- **Issue:** With no `--policy`, `createRedactor(null)` returns `{ apply: v => String(v||""), redactionApplied: false }`. Command stdout/stderr (which may contain tokens, passwords, `*_KEY` env values) are written to the bundle verbatim. The aggressive env-glob redaction (`*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_KEY`, `*_CREDENTIAL*`) only activates under an authoritative policy that the consumer must remember to pass.
- **Impact:** secret leakage into shareable/signed evidence bundles in the default configuration.

### M7. Standard mode has no criteria floor — a contract with only judgmental/zero criteria runs nothing and PASSES
- **Files:** `src/score-ac.mjs:115-126` (`collectCommandsToRun` returns `[]`), `src/run.mjs:194-204`, `src/report.mjs:138-141` (`classifyVerdict([]) === "PASS"`).
- **Issue:** Without an authoritative policy, `minimumDeterministic` / `requiredGates` don't exist (`policy.mjs:43-53`). A contract whose deterministic criteria were all removed/relaxed executes no commands and still yields `PASS`. Combined with M11 (baseline opt-in) this means a silently-weakened standard contract produces green evidence having proven nothing.

### M8. Stale "v0.3" branding shipped in the self-contract and written into consumers' READMEs by `init`
- **Files:** `.dogfood/dogfood.contract.yaml:3` (`description: Dogfood v0.3 proves …`); `src/run.mjs:349` (`"The explicit policy enables the authoritative v0.3 profile."`).
- **Issue:** `package.json:3` is `0.4.0`. The repo's own self-gate contract and every `dogfood init --authoritative` consumer's generated `.dogfood/README.md` advertise the previous version.

### M9. CHANGELOG documents a policy field `signing.required` that the schema rejects
- **Files:** `CHANGELOG.md:66` ("policy v1, unchanged (`logs.capture: "full"` and `signing.required` are additive)"); `schemas/policy.schema.json` has no `signing` field and is `additionalProperties: false`.
- **Issue:** A policy containing `signing.required` would fail validation, and no runtime code reads it. The changelog promises a feature that does not exist.

### M10. Playwright `test.fail` (expectedStatus `"failed"`) is mis-evaluated as a failure
- **Files:** `src/adapters.mjs:226-246` (`passedFirstAttempt` requires `expectedStatus === "passed"`), `:248-259`.
- **Issue:** A legitimately-passing `test.fail('x', …)` has `expectedStatus === "failed"` ⇒ `passedFirstAttempt = false` ⇒ the execution is counted in `failed` ⇒ the tag returns `fail`. Projects using `test.fail` cannot pass a dogfood playwright oracle at all. (Correctness false-positive, not a bypass.)

---

## Low / Informational

### L1. Per-file TOCTOU in verify: `existsSync` → `lstatSync` → `readFileSync`
- **File:** `src/verify.mjs:44-53`. The symlink/non-regular rejection happens at `lstatSync` time but bytes are read by a separate `readFileSync` that follows symlinks; with concurrent write access a regular file can be swapped for a symlink before the read. Same class as H1, narrower. `fs.openSync(O_RDONLY | O_NOFOLLOW)` + fstat/read on the fd closes it.

### L2. `manifest.json` is never type-checked (may be a symlink)
- **File:** `src/verify.mjs:19-26,149`. Unlike checksummed files, the manifest is read with no `lstat`/regular-file check; a repointed symlink target widens the H1 window.

### L3. `dogfood report` path containment is a lexical string prefix, no `realpath`
- **File:** `bin/dogfood.mjs:268-272,382-385` (`inside()`). Inconsistent with the stronger `realpath`-based containment used in `src/files.mjs` (`isPathInside`). A symlink planted in `artifacts/dogfood/` plus a crafted `latest.json` passes the lexical check while reading outside the artifact root (display path only, not a verified verdict).

### L4. `hardLinkCount` swallows `lstatSync` errors and returns `1` (fail-open)
- **File:** `src/report.mjs:393`. On any transient `lstat` error the entry is classified as a clean `"file"`, silently disabling the hard-link guard for that entry in both `writeManifest` and `verifyBundle`.

### L5. `safeSegment` collisions can delete another command's evidence
- **Files:** `src/files.mjs:174-176` (collapses non-`[A-Za-z0-9._-]` to `_`); `src/adapters.mjs:11-22` (`prepareAdapter` keys evidence dir on `safeSegment(name)` and `rmSync`s the report path). Command names `a/b`, `a b`, `a+b` all map to `a_b` and share one evidence dir; the second deletes the first's republished report. Produces an internally-inconsistent bundle (not a verdict bypass).

### L6. `writeLatestPointer` read-modify-write race under concurrency
- **File:** `src/run.mjs:311-320`. Concurrent `dogfood run`s sharing one artifact root can both read `latest.json`, and the loser silently drops its pointer update; `latest.json` can point to an older run.

### L7. YAML "canonicalization" is not a stable canonical form
- **File:** `src/verify.mjs:257,262-264` (`stringifyYaml(parseYaml(x), { lineWidth: 0 })`). `yaml`'s stringify with only `lineWidth:0` is not canonical across versions; a bundle produced under one `yaml` release and verified under another can produce spurious `normalized digest mismatch` (false-INVALID). Risk is false-INVALID, not bypass.

### L8. README docs list omits `docs/cli.md`; harness lists disagree (Windsurf only in agents.md); `docs/cli.md` under-documents `--force` (also valid on `keygen`)
- **Files:** `README.md:191-199` vs `docs/` (10 files); `README.md:65` vs `docs/agents.md:15`; `docs/cli.md:29` vs `bin/dogfood.mjs:25`.

### L9. Scratch/working docs tracked in the repo
- **Files:** `RELEASE.md` (line 3 "Nothing in this file has been executed."; line 37 `cd ~/projects/proofofworks/dogfood` does not match the real path `~/projects/proofofworks/thinktank/concepts/testo`); `RESUME.md` (internal handover: private branch name `dogfood-0.4.0-remediation`, a personal `https://ntfy.sh/pow-done-x` endpoint, commit SHAs). Neither is in `package.json` `files[]` (won't reach npm) but ships in git as scratch.

### L10. `docs/ci.md` presents repo workflow and shipped template as equivalent; they are not
- **Files:** `docs/ci.md:5-6` vs `.github/workflows/dogfood.yml` (3 proof jobs: unit on ubuntu/windows/**macos** × node 20/22/24, standalone `playwright-fixture`, `authoritative`; `prove-it needs [unit, playwright-fixture, authoritative]`) vs `templates/ci/dogfood.yml` (2 proof jobs: `tests` on ubuntu/windows only, node 20/24, no macos/22, Playwright baked into `authoritative`; `prove-it needs [tests, authoritative]`). Consumers copying the template get a weaker matrix and no isolated fixture job.

---

## Inherent threat-model limitations (not defects — disclose precisely)

These are unavoidable for a tool that runs arbitrary shell, and several are partly disclosed already; they are listed so the docs can be made exactly accurate rather than overstated.

- **Mutation detection is net-change only.** Edit-and-revert within a single command is undetected in every mode (M1). The honest statement is "a command whose net git state changed fails," not "a command that edits tracked files fails."
- **Playwright evidence trusts the project's own `playwright.config` (product code).** A custom `reporter` can write a hand-crafted passing JSON to `PLAYWRIGHT_JSON_OUTPUT_FILE` while running no real tests; the adapter validates shape, not provenance (`src/adapters.mjs:127-143,290-302`). Claims "tag matched nothing ⇒ FAIL" and "retry ⇒ FAIL" hold only against an honest reporter.
- **An exit-code oracle proves only "the command returned 0."** Correctly, a signal-killed command maps to `infra`, not `pass` (`src/run-commands.mjs:63-65`) — that potential bug is absent.
- **Standard mode accepts an external contract path with no containment:** `dogfood run --contract /tmp/evil.yaml` loads and executes an arbitrary contract; recorded `contractPath` is a relative `../../…` but nothing refuses it. Containment is enforced only in authoritative mode.
- **Orphaned descendants survive termination.** Any `setsid`/detached grandchild escapes the `-pid` group kill and can keep writing after the final snapshot (`src/run-commands.mjs:285-296`).

---

## What is verified correct (not bugs)

- Exit-code adapter maps signal kill → `infra`, not `pass`.
- `severity` does not affect the verdict by design (`report.mjs:118`); advisory receipts never flip a hard verdict (only malformed `--evidence` *input* becomes a hardFail, `run.mjs:184-192`).
- `validateOnly` does not hide blocking problems: `report.mjs:82-91` throws `ReportInvariantError` if a non-contract hardFail would sit behind VALID.
- Signature comparison itself goes through `crypto.verify` (constant-time ed25519 in OpenSSL); the `!==` digest/PEM string compares are not exploitable (no secret material in a SHA-256 hex digest; the PEM compare only ever *rejects*).
- `--key` / bad-algorithm failures push an error (exit 1) — fails closed, despite slightly misleading notice text.
- `package.json` `files[]` ships exactly what it should: no leak of `website/`, `scripts/`, `.github/`, `action.yml`; all runtime paths present. (Note: `scripts/check-package-contents.mjs` does not ship but is invoked by the repo's own self-gate — intentional, since consumers don't run dogfood's self-gate.)
- Test suite is comprehensive and self-aware: 133 tests including meta/docs/CI-workflow lint tests.

---

## Recommended fix order

1. **H1** — read manifest once, reuse buffer for parse + signature verify. (Smallest change, biggest integrity win.)
2. **H2 / H3 / M8 / M9** — one docs+help+branding pass: add `keygen`/`--sign`/`--key`/`--out` to `printHelp`; bump `docs/artifacts.md` to "Manifest version 4", add the `signing` field, note `manifest.sig` checksum exemption, drop "unsigned"; fix `SECURITY.md:9`; reword `CHANGELOG.md:66`; fix "v0.3" strings in `.dogfood/dogfood.contract.yaml:3` and `src/run.mjs:349`.
3. **M4** — bound the `close` wait with a hard deadline that rejects/finishes regardless of orphaned pipe holders.
4. **M5 / L4** — decide one policy for hard-links (fail-closed at verify too, or explicitly document post-verify tamper risk); make `hardLinkCount` fail-closed on `lstat` error.
5. **M1 / M2 / M3** — correct docs to state net-diff semantics precisely; document the `artifacts/` self-blind-spot; consider re-hashing untracked files unconditionally (drop the mtime cache) and hashing a streaming digest for >8 MB files instead of `null`.
6. **M6** — default `capture` to `full-redacted` (or at least redact env by default) so secrets don't leak without an explicit policy.
7. **M10** — treat `expectedStatus === "failed"` with a passing result as a pass.
