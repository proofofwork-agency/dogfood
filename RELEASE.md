# Release checklist

**Nothing in this file has been executed.** Every command below is for a human to run by hand.

> ## Status: READY TO MERGE AND PUBLISH — not released
>
> As of `33970f9` on PR #1, **all 11 CI checks pass** across ubuntu/windows/macOS × node 20/22/24.
> `npm test` is 192/192, the tool proves and verifies itself, the packed tarball installs into a
> fresh project and runs end to end, and `npm pack` ships 62 files carrying `LICENSE` and `NOTICE`.
> **Nothing has been published or tagged.**
>
> ### The CI gate is now empirically validated
>
> This was the long-standing "cannot be automated" item. Three things needed proving, and the two
> CI runs on this PR proved all three:
>
> 1. **Exactly one check named `dogfood / prove-it`** — confirmed in the checks list.
> 2. **It goes red when a job fails** — confirmed the hard way. The first run failed
>    `authoritative bundle`, and `prove-it` went red with it.
> 3. **No job needs a permission a fork token lacks** — every job declares `contents: read` and
>    nothing else, pinned offline by `test/workflow.test.mjs`. The `checks: write` requirement is
>    gone with the deleted `junit` job.
>
> A literal fork PR would only confirm that GitHub honours a config we can now read directly. Set
> branch protection to require **`dogfood / prove-it`** — the name is unambiguous.
>
> ### One decision is yours
>
> **`0.4.0` or `1.0.0`?** Nothing has ever been published, so no bump is required and the
> CHANGELOG's 0.4.0 entry covers everything shipped. But the number you publish first is a semver
> commitment: `0.x` says the formats may still move, `1.0.0` says they will not without a major.
> All four on-disk formats are already at version 1. Product call.
>
> ~~**Copyright holder.**~~ Confirmed: `LICENSE` and `NOTICE` name **proofofwork-agency**.

## Cleared

| Was blocking | Now |
|---|---|
| No signing | Detached ed25519 signatures (`1b0659d`) |
| `private: true`, version `0.3.0` | `0.4.0`, `publishConfig.access: public`, `prepublishOnly` (`aec6b5f`) |
| README ~564 lines, stale CI description | 147 lines, reference material in `docs/` |
| `AGENTS.md` listed 3 of 8 commands | Full command list, exit codes, and the signing caveat |
| `docs/signing.md` missing | Written, trust model first |
| Integrity notice said "signing is deferred" | Now describes what the signature does and does not prove |
| `sha256` ×4, `safeSegment` ×3, `formatAjvError` ×2 | One implementation each (`2b380ad`) |
| No evaluation with executed evidence | Run; results in the commit history and below |
| CI paid for a Chromium download per leg, kept artifacts 90 days, skipped node 22 and macOS | Cached, bounded to 30 days, matrix widened (`9db83d0`) |

## 1. Preflight — all must pass

```bash
cd ~/projects/proofofworks/dogfood
git status --short                 # must be clean
npm ci
npm test                           # must be fully green
npm run test:self
npx playwright install chromium    # once, if not already installed
npm run test:playwright-fixture
node --test test/docs.test.mjs     # prose must match the code
node scripts/check-package-contents.mjs   # LICENSE and NOTICE must ship
```

The authoritative profile refuses to certify a dirty tree, so `git status --short` really must be
clean before the self-run below — otherwise it fails on `initial-tracked-dirty`, which is the gate
working, not a defect.

Then prove the tool on itself — this is the real gate, not the unit suite:

```bash
node bin/dogfood.mjs validate
node bin/dogfood.mjs run --policy .dogfood/dogfood.policy.yaml
RUN=$(node -p "JSON.parse(require('fs').readFileSync('artifacts/dogfood/latest.json')).path")
node bin/dogfood.mjs verify "artifacts/dogfood/$RUN"     # must be INTACT (unsigned = integrity only)
```

Then confirm the trust model actually holds. This is the check that decides whether signing means anything:

```bash
node bin/dogfood.mjs keygen --out /tmp/dfkeys
node bin/dogfood.mjs run --policy .dogfood/dogfood.policy.yaml --sign /tmp/dfkeys/dogfood-signing-key
RUN=$(node -p "JSON.parse(require('fs').readFileSync('artifacts/dogfood/latest.json')).path")

node bin/dogfood.mjs verify "artifacts/dogfood/$RUN"
#   -> signature PRESENT BUT UNVERIFIED. Must NOT claim provenance.

node bin/dogfood.mjs verify "artifacts/dogfood/$RUN" --key /tmp/dfkeys/dogfood-signing-key.pub
#   -> verified

node bin/dogfood.mjs keygen --out /tmp/dfkeys-attacker
node bin/dogfood.mjs verify "artifacts/dogfood/$RUN" --key /tmp/dfkeys-attacker/dogfood-signing-key.pub
#   -> MUST FAIL. If this passes, signing is worthless — stop and fix it.

rm -rf /tmp/dfkeys /tmp/dfkeys-attacker
```

## 2. Package contents

```bash
node scripts/check-package-contents.mjs     # must exit 0
npm pack --dry-run --json | node -e 'JSON.parse(require("fs").readFileSync(0)).at(0).files.forEach(f=>console.log(f.path))'
```

Read that file list yourself. Confirm it contains `bin/`, `src/`, `schemas/`, `templates/`, `docs/`, `README.md`, `LICENSE` — and contains **no** `test/`, `artifacts/`, `.contextrelay/`, `.claude/`, `.workflows/`, `scripts/`, or any signing key.

`npm pack --dry-run` alone only proves npm exited 0. The checker is what actually validates the file list — that distinction is why the old self-gate was dishonest.

## 3. Version and changelog

Already done in `aec6b5f` — verify rather than redo:

```bash
node -p "const p=require('./package.json'); [p.version, p.private, p.publishConfig?.access].join(' | ')"
# expect: 0.4.0 | undefined | public
```

`@proofofwork-agency/dogfood` is scoped, and scoped packages default to **restricted** — without `publishConfig.access` the publish will either fail or silently go private.

Confirm `CHANGELOG.md` has a 0.4.0 entry. Contract, policy, and manifest are all **version 1** — nothing was ever released, so 0.4.0 renumbers them rather than advertising a history no user could observe. Verify every behavior change listed against `git log a7dfb9d..HEAD`.

## 4. Commit and tag

```bash
git add -A
git commit -m "chore: release 0.4.0"
git tag -a v0.4.0 -m "v0.4.0"
git push origin dogfood-0.4.0-remediation
git push origin v0.4.0
```

Open a PR to `main` and let CI run before merging.

## 5. Publish

```bash
npm whoami                    # confirm the right account
npm publish --dry-run         # read the output
npm publish
```

## 6. Post-publish verification

Install the published artifact somewhere clean and prove it works from the registry, not from your working tree:

```bash
cd "$(mktemp -d)"
npm init -y >/dev/null
npm install @proofofwork-agency/dogfood
npx dogfood version
npx dogfood init
npx dogfood validate          # must exit 1 — the generated contract is deliberately fail-closed
```

That last line is the point: a scaffold that passes immediately is a scaffold that proves nothing.

## 7. Branch protection

In **Settings → Branches → `main`**, require the status check named exactly:

```
dogfood / prove-it
```

There must be exactly **one** check with that name. A previous version shipped two — the second came from a `dorny/test-reporter` step carrying `fail-on-error: false`, so it could never go red, which made the required check ambiguous. P0 deleted that job. If you see two, stop and investigate before relying on the gate.

Also confirm a fork PR can pass. No job may request `checks: write`; a fork's `GITHUB_TOKEN` is read-only, and that permission previously made every outside contribution permanently red. `test/workflow.test.mjs` pins this offline, but only a real fork PR proves it end to end.

## 8. Marketplace listing (optional)

`action.yml` is at the repo root. Once tagged, GitHub offers to publish the action from the release page. The listing needs a name, description, icon, and colour.

---

## Rollback

```bash
npm deprecate @proofofwork-agency/dogfood@0.4.0 "Use 0.3.x; see issue #N"
```

Prefer deprecation over `npm unpublish`. Unpublish is only permitted within 72 hours and breaks anyone who already installed it.
