# Release checklist

**Nothing in this file has been executed.** Every command below is for a human to run by hand.

> ## Status: BLOCKED — do not release yet
>
> As of `affc619`, this package is **not ready to publish**. `package.json` still says `"version": "0.3.0"` and `"private": true`, the manifest is still v3, and three phases of planned work are incomplete. See [Blockers](#blockers).
>
> Releasing now would ship a package whose README describes features it does not have.

---

## Blockers

| # | Blocker | Where |
|---|---|---|
| 1 | **P1.5 untouched** — no `src/sign.mjs`, no manifest v4, no JUnit adapter, no `action.yml` | see `RESUME.md` |
| 2 | **`private: true` still set**, version still `0.3.0` | `package.json` |
| 3 | **README still ~564 lines** and documents the pre-P0 CI job layout | `README.md:319` |
| 4 | **`AGENTS.md` still lists 3 of 8 commands** and never mentions `--policy` | `AGENTS.md` |
| 5 | **`docs/signing.md` and `docs/junit.md` missing** — blocked on blocker 1 | `docs/` |
| 6 | **Integrity notice still says "signing is deferred"** — becomes false the moment signing lands | `src/report.mjs:202`, `src/verify.mjs:7` |
| 7 | **P3 untouched** — duplicated helpers still present (`sha256` ×4, three containment impls, four git wrappers) | see `RESUME.md` |
| 8 | **No final evaluation** with executed evidence has been run | — |

Work through `RESUME.md`, then come back here.

---

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
```

Then prove the tool on itself — this is the real gate, not the unit suite:

```bash
node bin/dogfood.mjs validate
node bin/dogfood.mjs run --policy .dogfood/dogfood.policy.yaml
RUN=$(node -p "JSON.parse(require('fs').readFileSync('artifacts/dogfood/latest.json')).path")
node bin/dogfood.mjs verify "artifacts/dogfood/$RUN"     # must be VERIFIED
```

Once signing exists (blocker 1), also confirm the trust model actually holds:

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

```bash
# edit package.json by hand: version -> 0.4.0, remove "private": true
# add:  "publishConfig": { "access": "public" }
# add:  "prepublishOnly": "npm test && node scripts/check-package-contents.mjs"
```

`@proofofwork-agency/dogfood` is scoped, and scoped packages default to **restricted** — without `publishConfig.access` the publish will either fail or silently go private.

Confirm `CHANGELOG.md` has a 0.4.0 entry naming which of the **four independent version numbers** moved: package (0.4.0), contract (v2, unchanged), policy (v1, unchanged), report/manifest (3 → 4). Verify every behavior change listed against `git log a7dfb9d..HEAD`.

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

Requires `action.yml` at the repo root (blocker 1). Once tagged, GitHub offers to publish the action from the release page. The listing needs a name, description, icon, and colour.

---

## Rollback

```bash
npm deprecate @proofofwork-agency/dogfood@0.4.0 "Use 0.3.x; see issue #N"
```

Prefer deprecation over `npm unpublish`. Unpublish is only permitted within 72 hours and breaks anyone who already installed it.
