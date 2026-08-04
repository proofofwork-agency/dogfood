export const meta = {
  name: 'dogfood-p15',
  description: 'Dogfood 0.4.0 P1.5: manifest v4 + detached signing, JUnit-XML adapter, publish prep',
  phases: [
    { title: 'Build', detail: 'signing, JUnit adapter, publish prep — disjoint file sets' },
    { title: 'Attack', detail: 'adversarial attack on the trust model' },
    { title: 'Gate', detail: 'full scenario sweep' },
  ],
}

const REPO = '/Users/danillofelanso/projects/proofofworks/thinktank/concepts/testo'

const COMMON = `
Repo: ${REPO} (branch dogfood-0.4.0-remediation, Node v22.13.0, Chromium installed).
"@proofofwork-agency/dogfood" is an ESM CLI evidence gate: a contract maps acceptance criteria to
oracles (exact shell commands or exact Playwright test tags); "dogfood run" executes them and emits
a checksummed bundle under artifacts/dogfood/<runId>/ (summary.json/md, matrix.json, junit.xml,
manifest.json with per-file sha256, commands/<n>/*, evidence/<adapter>/*); "dogfood verify"
re-checks it offline. --policy enables an "authoritative" profile.

P0 and P1 ALREADY LANDED on this branch. READ every file before editing it — do not trust
remembered line numbers. Notable P0/P1 changes: src/report.mjs has listBundleEntries + a typed
BundleIntegrityError and writeManifest fails closed on non-regular entries; src/verify.mjs walks
entries and no longer has the ".tmp-" exemption; src/redact.mjs exists and redaction is on by
default; src/files.mjs has sweepPendingTemps.

STYLE: ESM, node: prefixed builtins, 2-space indent, double quotes, semicolons, terse one-line
helpers at file bottom, sparse comments. No new npm dependencies — the dep list stays at
ajv, ajv-formats, yaml.

RULES:
1. Only touch the files assigned to you. Other agents work concurrently on other files.
2. No git commands. No commits. Never run "npm publish".
3. Run your own tests directly: node --test test/x.test.mjs
4. Report tersely: files changed, what changed, tests added, observed test output.
`

phase('Build')
const build = await parallel([
  () => agent(`${COMMON}
TASK: manifest v4 + detached ed25519 signing. THIS IS THE MOST SECURITY-SENSITIVE WORK IN THE
PROJECT — a signing scheme that looks right but proves nothing is strictly WORSE than no signing,
because it invites trust the artifact has not earned.

You own: src/sign.mjs (create), src/report.mjs, src/verify.mjs, bin/dogfood.mjs,
schemas/policy.schema.json, test/sign.test.mjs (create), test/verify.test.mjs

BACKGROUND. README.md concedes today: "an attacker able to regenerate an unsigned manifest can
regenerate its checksums." The manifest is currently version 3 and src/verify.mjs's validateManifest
has a CLOSED "allowed" field set plus a hard \`version !== 3\` reject. Older v2 manifests are already
rejected with rerun guidance. Bumping to v4 now is a deliberate, approved decision: the package is
private and unpublished, so this is the last moment the format break is free.

=== 1. Manifest v4 ===
- Bump the manifest version to 4 everywhere it is written and validated.
- Add ONE new field to the allowed set: \`signing\`, an object
  { algorithm, keyId, publicKey, signatureFile } or null when unsigned.
- Update the v-mismatch rejection message so it names the version found and says to rerun with
  Dogfood v0.4 (keep rejecting v2 and now also v3 — same guidance).
- Every existing bundle under artifacts/dogfood/ is v3 and WILL now fail verify. That is intended.

=== 2. Detached signature ===
A signature cannot live inside the bytes it signs. So:
- \`manifest.sig\` sits beside manifest.json and holds the base64 ed25519 signature over the EXACT
  bytes of manifest.json.
- manifest.json's \`signing\` block records algorithm "ed25519", the keyId (sha256 of the public key,
  hex), the public key (SPKI, base64), and signatureFile "manifest.sig".
- CRITICAL: the unrecorded-file walk in src/verify.mjs must exempt "manifest.sig" BY EXACT NAME,
  never by substring. The bug P0 just removed was \`!name.includes(".tmp-")\` — a substring exemption
  that let any planted file whose path contained ".tmp-" pass. Do not reintroduce that shape.
  manifest.json is already exempt by exact name; follow that pattern exactly.

=== 3. THE TRUST MODEL — get this right or the feature is theater ===
A public key embedded in the manifest is WORTHLESS on its own: whoever can regenerate the manifest
can also generate a fresh keypair and re-sign. Therefore:
- \`dogfood verify <bundle> --key <public-key-file>\` verifies the detached signature against an
  EXTERNALLY SUPPLIED anchor. Only this mode proves provenance. If the bundle's embedded publicKey
  does not match the supplied key, that is an ERROR (not a warning).
- Bare \`dogfood verify <bundle>\` on a signed bundle must report the signature as
  PRESENT BUT UNVERIFIED and MUST NOT upgrade the verdict or claim provenance. Surface this in the
  result object as e.g. signatureStatus: "unverified" | "verified" | "invalid" | "absent".
- \`--key\` against an UNSIGNED bundle is an error ("bundle is not signed").
- An invalid signature is an error, obviously.
Write these semantics as a comment block at the top of src/sign.mjs so the next reader cannot
misread them.

=== 4. src/sign.mjs ===
Use node:crypto only — NO new dependency:
  generateKeyPairSync("ed25519"), createPrivateKey/createPublicKey, sign(null, data, key),
  verify(null, data, key, signature)
Export: generateKeyPair(), signManifest(manifestBytes, privateKey), verifyManifestSignature(
manifestBytes, signatureB64, publicKey), keyIdFor(publicKey), loadPrivateKey(path), loadPublicKey(path).
Private keys are written mode 0o600. Handle a malformed/unreadable key file with a clear typed error,
never a stack trace.

=== 5. CLI ===
- \`dogfood keygen --out <dir>\` writes dogfood-signing-key (private, 0600) and
  dogfood-signing-key.pub. Refuse to overwrite without --force.
- \`dogfood run --sign <private-key-path>\` signs the manifest after it is written.
- \`dogfood verify <bundle> --key <public-key-path>\` as specified above.
- Register the new options in the existing option-spec table with the right per-command allowlists,
  and update the help text and the exit-code documentation block.

=== 6. Policy (stays v1 — additive only) ===
Add an optional \`signing\` object with \`required: boolean\` (default false) to
schemas/policy.schema.json. When true, an authoritative run that produced no signature is a hard
FAIL with a clear message. Additive optional field => every existing v1 policy still validates.

=== 7. TESTS (test/sign.test.mjs, plus cases in test/verify.test.mjs) ===
  - round trip: keygen -> run --sign -> verify --key -> verified
  - TAMPER: flip one byte in summary.json after signing -> checksum error AND signature still valid
    over the manifest (proves the two layers are independent and both are needed)
  - TAMPER: edit manifest.json after signing -> signature invalid
  - ATTACK: regenerate the manifest AND re-sign with an ATTACKER key -> bare verify must NOT say
    verified; verify --key <original public key> MUST fail. This is the single most important test
    in the file — it is the whole point of the feature.
  - bare verify on a signed bundle -> signatureStatus "unverified", verdict not upgraded
  - --key on an unsigned bundle -> error
  - unsigned bundle still verifies its checksums normally (signing is opt-in)
  - policy signing.required true + unsigned run -> FAIL
  - manifest.sig is exempt from the unrecorded-file walk, but a file named e.g.
    "evidence/x.manifest.sig.bak" is NOT exempt (proves exact-name, not substring)
Verify: node --test test/sign.test.mjs test/verify.test.mjs
`, { label: 'signing', phase: 'Build' }),

  () => agent(`${COMMON}
TASK: generic JUnit-XML adapter — a third adapter that binds an acceptance criterion to a NAMED
TESTCASE, not to a suite exit code. This generalizes the tool's best idea (exact-tag Playwright
oracles) to pytest, Vitest, Go/gotestsum, Maven and Gradle.

You own: src/adapters.mjs, schemas/contract.schema.json, src/validate.mjs, src/score-ac.mjs,
examples/junit/ (create), test/junit-adapter.test.mjs (create)

READ src/adapters.mjs FIRST — study how playwright-json works (prepareAdapter allocates evidence
paths and injects PLAYWRIGHT_JSON_OUTPUT_FILE; evaluatePlaywrightTag walks the suite tree and
requires every matching execution to have exactly one attempt, first result passed). Mirror that
rigor.

=== 1. Schema (contract stays v2 — additive only) ===
- Add "junit-xml" to the commands[].adapter enum (currently ["exit-code","playwright-json"]).
- Add a new oracle kind "junit" with fields: command (the command name), and a testcase selector.
  The selector is { classname?, name } — name is REQUIRED, classname optional. Both are exact
  string matches, not patterns: this tool's whole thesis is that fuzzy matching produces false
  greens.
- Add \`reportPath\` to the command definition for junit-xml commands: a workspace-relative path to
  the XML the runner will write.
  WHY NOT AN ENV VAR: unlike Playwright, JUnit output paths are runner-specific flags
  (pytest --junitxml=, Vitest --reporter=junit --outputFile=, gotestsum --junitfile=), so injecting
  one env var does not generalize. The contract declares the path instead.

=== 2. Validation (src/validate.mjs) ===
Mirror the existing semantic rules exactly:
  - a junit oracle must reference a command whose adapter is junit-xml (and vice versa)
  - a junit-xml command must declare reportPath
  - a deterministic criterion bound to a junit oracle is fine; the usual advisory/judgmental rules
    are unchanged
  - warn about junit oracles that no criterion references, same as existing unused-oracle warnings

=== 3. Adapter (src/adapters.mjs) ===
- prepareAdapter: resolve reportPath against cwd, apply the SAME workspace-containment check the
  build subject and advisory artifacts use (reject symlinks and paths escaping the workspace —
  find the existing helper, do not write a new one).
- evaluateJunitXml: after the command runs, read the XML and copy it into
  evidence/junit-xml/<name>.report.xml. Parse WITHOUT a new dependency — a focused scanner over
  <testsuite>/<testcase>/<failure>/<error>/<skipped> elements is sufficient; handle self-closing
  tags, attribute quoting with both ' and ", and XML entities in attribute values.
- evaluateJunitCase(report, selector): the named testcase MUST exist; if the selector matches
  NOTHING that is a FAIL with a message saying so explicitly (this is the "--grep matched nothing
  and exited 0" false-green this tool exists to kill). If it matches, it must have no <failure> and
  no <error> and must not be <skipped>. If the selector matches MULTIPLE testcases (e.g. a matrix),
  ALL of them must pass — mirror the Playwright rule.
- If the report file is absent after the command ran: FAIL with guidance naming the declared
  reportPath. DO NOT add a stdout fallback — P0 just removed exactly that hole from the Playwright
  adapter because it let a command fabricate its own evidence.
- Register the adapter version in ADAPTER_VERSIONS.

=== 4. score-ac ===
Ensure scoreAcceptanceCriteria handles junit oracles with the same precedence as playwright ones
(command must have run; command infra -> blocked; mutation -> fail; selector result not pass -> fail).
Check expectedPlaywrightTags's analogue — junit selectors must be passed to the adapter the same way
tags are.

=== 5. examples/junit/ ===
A runnable example needing NO python/go toolchain: a tiny Node script that emits a JUnit XML file
with two passing testcases and one that can be flipped to failing, plus .dogfood/dogfood.contract.yaml
binding an AC to one exact testcase name. Mirror the shape of examples/minimal.

=== 6. TESTS (test/junit-adapter.test.mjs) ===
Unit-test the parser and evaluator directly with XML fixture strings:
  passing testcase; failing testcase; errored testcase; skipped testcase; selector matching nothing
  (MUST fail, with a message naming the selector); selector matching multiple where one fails;
  nested testsuites; self-closing testcase tags; attributes with single quotes; XML entities in the
  name; a malformed XML document (must fail cleanly, not throw an unhandled parse error).
Plus one end-to-end through runDogfood using examples/junit's shape in a temp project.
Verify: node --test test/junit-adapter.test.mjs
`, { label: 'junit-adapter', phase: 'Build' }),

  () => agent(`${COMMON}
TASK: publish preparation. IMPORTANT — PREPARE ONLY. You must NEVER run \`npm publish\`,
\`npm version\`, \`git push\`, \`git tag\`, or \`gh release\`. The human will release later, by hand.

You own: package.json, action.yml (create), RELEASE.md (create), .npmignore,
scripts/check-package-contents.mjs, .github/workflows/ (only if adding a release-prep workflow —
prefer not to)

=== 1. package.json ===
- Bump version to 0.4.0.
- REMOVE \`"private": true\`. The package is being prepared for a public npm release.
- Add "docs/" to files[] (a later phase creates that directory — add the entry now).
- Add "scripts/" is FORBIDDEN in files[] — the package-contents checker asserts scripts/ is NOT
  shipped. Do not add it.
- Add a "publishConfig": { "access": "public" } block, since this is a scoped package and scoped
  packages default to restricted.
- Add "prepublishOnly": "npm test && node scripts/check-package-contents.mjs" so a publish that
  would ship the wrong file set cannot happen by accident.
- Verify engines, repository, bugs, homepage, license, keywords are all correct and consistent.
- DO NOT change scripts.test's file list — another phase owns that and test/meta.test.mjs asserts it.

=== 2. scripts/check-package-contents.mjs ===
It currently has "docs/" absent from required (the dir did not exist when it was written). Add
"docs/" to the required prefixes now, and confirm forbidden still covers test/, artifacts/,
.contextrelay/, node_modules/, scripts/, .github/. Since docs/ does not exist yet, the check will
fail until the docs phase lands — that is correct and expected; note it in your report. Make the
failure message say clearly which required prefix is missing.

=== 3. .npmignore ===
DELETE IT. It is dead config: npm ignores .npmignore entirely when files[] is present. Its lines
duplicate the allowlist, two of them can never match, and one pins a literal dated filename. One
mechanism, not two.

=== 4. action.yml (create) — a thin GitHub Action wrapper ===
A composite action at the repo root so the repo can be listed on the Actions Marketplace.
Inputs: contract (optional), policy (optional), baseline-ref (optional), subject (optional),
sign-key (optional), evidence (optional, multiline), node-version (default "24"),
working-directory (default "."), fail-on (default "any").
Steps (composite, shell: bash):
  - setup-node pinned to the SAME full commit SHA already used in .github/workflows/dogfood.yml
  - install the CLI
  - run \`dogfood validate\` then \`dogfood run\`, passing through the inputs
  - always upload the bundle via actions/upload-artifact, pinned to the same SHA already in use
  - write a JUnit summary to $GITHUB_STEP_SUMMARY
Outputs: verdict, run-id, bundle-path.
CRITICAL: never interpolate \${{ inputs.* }} directly into a run: block — pass every input through
an env: mapping and reference "$VAR" in shell. test/workflow.test.mjs already pins that rule for the
workflows; make sure action.yml obeys it too, and EXTEND test/workflow.test.mjs to cover action.yml
(read that test file first; it is owned by an earlier phase but adding action.yml coverage is yours).
Do not add any third-party action that is not already pinned in .github/workflows/dogfood.yml.

=== 5. RELEASE.md (create) — the human's checklist ===
A short, exact, copy-pasteable checklist for the human to run LATER, by hand:
  preflight (npm test, test:self, test:playwright-fixture, self-run + verify,
  node scripts/check-package-contents.mjs, npm pack --dry-run and eyeball the file list),
  the version/tag/publish commands, post-publish verification (npx the published package in a clean
  temp dir), the Marketplace listing steps, and the branch-protection step (require the single
  status check named "dogfood / prove-it" — note that P0 removed a duplicate check with that exact
  name which previously made the requirement ambiguous).
State plainly at the top that NOTHING in this file has been executed.

Verify: node --test test/workflow.test.mjs ; node -e "JSON.parse(require('fs').readFileSync('package.json'))"
and confirm \`npx js-yaml action.yml\` style parsing works via the yaml package.
`, { label: 'publish-prep', phase: 'Build' }),
])

phase('Attack')
const ATTACKS = [
  { key: 'signing-trust', lens: 'Attack the signing trust model. Can a bundle be re-signed with an attacker key and still appear trustworthy in ANY output surface (CLI text, --json, exit code, summary)? Does bare `verify` anywhere imply provenance? Can --key be satisfied by a key embedded in the bundle rather than the one supplied? Can manifest.sig be swapped, truncated, empty, or made a symlink? Does the exact-name exemption for manifest.sig admit anything else (e.g. a directory named manifest.sig, or evidence/manifest.sig)?' },
  { key: 'signing-crypto', lens: 'Attack the crypto plumbing. Signature over the wrong bytes (pretty-printed vs raw, trailing newline, BOM, CRLF)? Any place the signature is verified over a re-serialized object instead of the bytes on disk? Key confusion between SPKI/PKCS8/raw? What happens with a 0-byte key, a public key passed where a private key is expected, an RSA key, a key from a different algorithm? Does keygen refuse to overwrite? Is the private key really 0600?' },
  { key: 'junit-falsegreen', lens: 'Make the JUnit adapter report a false green. A selector matching nothing MUST fail — try empty name, whitespace-only, case differences, a name that exists only in a skipped case, a testcase with a <failure> child that has no message attribute, a <testcase> with BOTH a failure and a passing duplicate elsewhere, nested testsuites, XML entities and CDATA, a testsuite with errors=0 failures=0 that still contains a <failure> element, and a report file the command itself writes with fabricated content.' },
  { key: 'junit-parser', lens: 'Break the hand-rolled XML parser. Malformed XML, unclosed tags, attributes containing > or quotes, comments containing testcase-like text, CDATA containing markup, very large files, XML with a DOCTYPE / entity declaration (check for billion-laughs style expansion — the parser must not be vulnerable), namespaced elements, UTF-16 or BOM-prefixed input. Any crash, hang, or silently-wrong parse is a finding.' },
  { key: 'publish-surface', lens: 'Would publishing this ship anything it should not, or fail to ship something needed? Run `npm pack --dry-run --json` and inspect the ACTUAL file list against files[]. Check for secrets, .contextrelay, artifacts, test files, the private key from any keygen run, or absolute paths baked into any shipped file. Also verify removing private:true did not leave any other publish blocker, and that action.yml has no ${{ }} inside a run: block.' },
  { key: 'regression-p0p1', lens: 'Did P1.5 break P0 or P1? Re-run every earlier attack: plant an unrecorded file, plant a file whose name contains .tmp-, plant a symlink, plant an empty directory, fabricate a Playwright stdout report, pass a dash-prefixed --baseline-ref, run with a secret in the env and grep the whole bundle for it. All must still be caught. Confirm the tool still verifies its own freshly produced authoritative bundle, signed AND unsigned.' },
]

const verdicts = await parallel(ATTACKS.map((a) => () => agent(`
You are a red-team attacker against the repo at ${REPO} (branch dogfood-0.4.0-remediation).
It is a Node ESM CLI "evidence gate" whose entire product promise is that its artifact bundles are
tamper-evident and its acceptance criteria cannot produce false greens. Manifest v4 + detached
ed25519 signing and a JUnit-XML adapter have just been added.

YOUR JOB IS TO BREAK IT. Assume every fix is broken until you have executed a probe proving
otherwise. Default to refuted = true when uncertain. A FALSE POSITIVE (a legitimate case now
wrongly rejected) counts as a finding too — for a gate, false greens and false reds are both fatal.

ATTACK — ${a.key}:
${a.lens}

METHOD: read the CURRENT source first. Write probes under
/private/tmp/claude-501/-Users-danillofelanso-projects-proofofworks-thinktank-concepts-testo/67ddd512-2138-42e8-958c-a0459b147b90/scratchpad
and RUN them. Create temp git repos under $TMPDIR and run the real CLI against them. Chromium is
installed. You MUST NOT modify any file inside ${REPO} — read-only there.
Prefer executed evidence over reasoning. "I read the code and it looks correct" is NOT confirmation.
`, { label: `attack:${a.key}`, phase: 'Attack', schema: {
  type: 'object', additionalProperties: false,
  required: ['attack', 'refuted', 'evidence', 'findings'],
  properties: {
    attack: { type: 'string' },
    refuted: { type: 'boolean' },
    evidence: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['severity', 'summary', 'reproduction', 'file'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          summary: { type: 'string' },
          reproduction: { type: 'string' },
          file: { type: 'string' },
        },
      },
    },
  },
} })))

log(`attacks landed: ${verdicts.filter(Boolean).filter((v) => v.refuted).length}/${verdicts.filter(Boolean).length}`)

phase('Gate')
const gate = await agent(`${COMMON}
TASK: reconcile, repair and prove P1.5. You own the whole repo. You MAY edit package.json.

RED-TEAM FINDINGS you must resolve:
${JSON.stringify(verdicts.filter(Boolean), null, 2)}

STEPS:
1. Sync package.json scripts.test to every test/*.test.mjs on disk, sorted, excluding
   test/playwright-fixture.mjs and test/helpers.mjs. test/meta.test.mjs asserts this exactly.
2. npm test -> fix every failure. Distinguish a test asserting deliberately-changed behavior
   (update it, and say so) from a genuine regression (fix the source). Never weaken an assertion.
   NOTE: the manifest v3->v4 bump means any test with a hardcoded version 3 must be updated, and
   every pre-existing bundle under artifacts/dogfood/ will now fail verify — that is intended.
3. Resolve every blocker and major from the red team. Fix cheap minors; record the rest precisely.
   If an attacker is WRONG, say so with executed evidence.
4. FULL SCENARIO SWEEP — run all of these and report verdict + exit code for each:
   a. npm test
   b. npm run test:self
   c. npm run test:playwright-fixture      (Chromium is installed; this must actually run)
   d. node bin/dogfood.mjs validate
   e. node bin/dogfood.mjs run --policy .dogfood/dogfood.policy.yaml
   f. verify that bundle -> VERIFIED
   g. node bin/dogfood.mjs keygen --out /tmp/dfkeys
   h. node bin/dogfood.mjs run --policy .dogfood/dogfood.policy.yaml --sign /tmp/dfkeys/dogfood-signing-key
   i. verify that bundle WITHOUT --key   -> signature reported present-but-unverified, NOT provenance
   j. verify that bundle WITH --key /tmp/dfkeys/dogfood-signing-key.pub -> verified
   k. generate a SECOND keypair, verify the same bundle with the WRONG public key -> MUST fail
   l. node bin/dogfood.mjs run   (standard, no policy) -> A5 policy warning present
   m. cd examples/minimal-broken && node ../../bin/dogfood.mjs validate -> exit 1
   n. the examples/junit example runs and passes; then flip its testcase to failing and confirm FAIL
   o. node scripts/check-package-contents.mjs  (expected to FAIL on missing docs/ — confirm that is
      the ONLY reason it fails)
   p. npm pack --dry-run --json -> inspect the file list; confirm no secrets, no artifacts/, no
      test/, no .contextrelay/, no signing keys
5. Delete /tmp/dfkeys when done. Never leave a private key on disk outside a temp dir.
6. Report: files changed, npm test summary line, every scenario result from step 4, every red-team
   finding and its resolution, anything deferred.

Do not commit. Do not publish. Do not push. Do not tag. Do not write prose documentation
(the docs phase is next and owns that).
`, { label: 'gate', phase: 'Gate' })

return { build, verdicts, gate }
