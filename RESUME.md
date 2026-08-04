# Dogfood 0.4.0 — status

**Branch:** `dogfood-0.4.0-remediation` · **`npm test` 129/129** · coverage 91.8% · tree clean apart from untracked `.claude/`
**Nothing has been published, pushed, or tagged.**

Read **`RELEASE.md`** for the handover checklist. **`.workflows/PLAN.md`** holds the original plan.

## Done

| Phase | Commit | What |
|---|---|---|
| P0 | `a7dfb9d` | Bundle integrity bypasses closed, Playwright forgery rejected, redaction default-on, CI gate made real, self-gate made honest |
| P1 correctness | `e512b52` | Structured mutation codes, advisory reclassification, one `summarizeRepository`, fsync, unborn HEAD |
| P2 reference | `aadd335` | `docs/` tree, docs gate, CHANGELOG/CONTRIBUTING/SECURITY |
| P1.5 signing | `1b0659d` | Manifest v4, detached ed25519 signatures, trust model enforced in code |
| P1.5 publish prep | `aec6b5f` | 0.4.0, `private` removed, `action.yml`, `.npmignore` deleted |
| P3 dedup | `2b380ad` | `sha256` ×4 → 1, `safeSegment` ×3 → 1, `formatAjvError` ×2 → 1 |

### What P0 actually closed

- **`.tmp-` bypass** — `verify` exempted any unrecorded file whose *path* contained `.tmp-`. Temps are now tracked and swept before the manifest is taken; exemptions are **exact-name only**.
- **Symlink blindness** — a `readdirSync` Dirent for a symlink is neither `isFile()` nor `isDirectory()`, so symlinks were skipped by *both* `writeManifest` and `verify`. Enumeration is lstat-based and `writeManifest` fails closed.
- **Playwright stdout forgery** — the adapter parsed the command's own stdout as its report. Rejected; the report path is unlinked before the command runs.
- **CI gate ambiguity** — two check runs named `dogfood / prove-it`, one carrying `fail-on-error: false`. Its `checks: write` also made fork PRs permanently red.
- **`--baseline-ref` injection** — reached `git show` unsanitized, where `--output=` is an arbitrary-file-write primitive.
- **`validate` clobbering `latest.json`** — `report` showed the check instead of the proof.
- **Dishonest self-gate** — `npm pack --dry-run` through `exit-code` behind an oracle named `package-contents`.

## Outstanding — both deliberate

1. **JUnit-XML adapter → 0.5.0.** A new feature, not a fix. 0.4.0 is scoped to making the existing claims true; a third adapter would widen the blast radius of exactly the release that shouldn't have one. `.workflows/p15.js` carries the full spec.
2. **Fork-PR CI validation.** `test/workflow.test.mjs` pins the invariants offline — no duplicate check names, no `checks: write`, no `${{ }}` inside `run:` — but only a real fork PR proves end-to-end behavior. `RELEASE.md` step 7.

Not blocking: `runDogfood` is still one long function (`.workflows/p3.js` has the decomposition), and CI could gain a Playwright browser cache plus a node-22/macOS matrix (`.workflows/p1.js`, P1d).

## Standing constraints

1. **No release.** No `npm publish`, `git push`, `git tag`, or `gh release`. Local commits only.
2. **No new dependencies.** Runtime deps stay exactly `ajv`, `ajv-formats`, `yaml`.
3. **Contract stays v2, policy stays v1** — additive only. Manifest is now v4.
4. **Never weaken an assertion to get green.** A failing test is either asserting deliberately-changed behavior (update it, and say which) or a genuine regression (fix the source).
5. **Both failure directions are fatal.** A false green breaks the product; a false red makes it unusable. Every fix needs a test in both directions.

## Notes

- **Chromium is installed**, so `npm run test:playwright-fixture` runs locally (3/3 passing).
- **`.claude/agents/`** — `qa`, `security`, `reviewer`, `documenter`, `evaluator`, `git-ops` were rewritten for this project and are used via `agentType` in the workflow scripts. The rest are still written for an unrelated NestJS/Next.js project and should not be used. `.claude/` is untracked **and not gitignored**, which is a footgun worth settling — dogfood's own `init` creates `.claude/skills/`, so the directory is semantically meaningful here.
- **Don't run probes against the working tree while a workflow holds it.** A transient duplicate-declaration error mid-consolidation briefly looked like a false positive.
- The **P0 gate agent overruled a verifier with evidence**: it declined to treat `nlink > 1` as non-regular in `verify` after finding all four pre-existing bundles were hardlink-copied, which would have failed every one. It hard-fails in `writeManifest` (production time) and warns in `verify`. Worth preserving if the topic resurfaces.
- Notifications go to `https://ntfy.sh/pow-done-x`.
