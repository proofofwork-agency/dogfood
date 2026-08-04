import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, sign as cryptoSign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runDogfood } from "../src/run.mjs";
import {
  generateKeyPair,
  keyIdFor,
  loadPrivateKey,
  loadPublicKey,
  SIGNATURE_FILE,
  SigningError,
  verifyManifestSignature,
  writeKeyPair,
} from "../src/sign.mjs";
import { verifyBundle } from "../src/verify.mjs";
import { createProject } from "./helpers.mjs";

function keyDir(cwd, name = "k") {
  const path = join(cwd, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function signWith(privatePem, bytes) {
  return cryptoSign(null, bytes, createPrivateKey(privatePem)).toString("base64");
}

test("keygen writes an ed25519 pair and refuses to clobber it", () => {
  const dir = keyDir(createProject());
  const written = writeKeyPair(dir);

  assert.ok(existsSync(written.privatePath));
  assert.ok(existsSync(written.publicPath));
  assert.match(readFileSync(written.privatePath, "utf8"), /BEGIN PRIVATE KEY/);
  assert.match(readFileSync(written.publicPath, "utf8"), /BEGIN PUBLIC KEY/);
  assert.match(written.keyId, /^[a-f0-9]{32}$/);

  assert.throws(() => writeKeyPair(dir), SigningError);
  assert.notEqual(writeKeyPair(dir, { force: true }).keyId, written.keyId);
});

test("a private key file is written owner-only", { skip: process.platform === "win32" }, () => {
  const { privatePath } = writeKeyPair(keyDir(createProject()));
  assert.equal(statSync(privatePath).mode & 0o777, 0o600);
});

test("key loading rejects the wrong type, missing files and garbage", () => {
  const dir = keyDir(createProject());
  const { privatePath, publicPath } = writeKeyPair(dir);

  assert.throws(() => loadPrivateKey(join(dir, "nope")), SigningError);
  assert.throws(() => loadPublicKey(join(dir, "nope")), SigningError);
  // A public key supplied where a private key is required must not silently work.
  assert.throws(() => loadPrivateKey(publicPath), SigningError);

  const garbage = join(dir, "garbage.pem");
  writeFileSync(garbage, "not a key\n", "utf8");
  assert.throws(() => loadPrivateKey(garbage), SigningError);
  assert.throws(() => loadPublicKey(garbage), SigningError);

  assert.ok(loadPrivateKey(privatePath));
  assert.ok(loadPublicKey(publicPath));
});

test("verifyManifestSignature rejects empty, malformed and foreign signatures", () => {
  const bytes = Buffer.from("manifest bytes");
  const mine = generateKeyPair();
  const theirs = generateKeyPair();
  const publicKey = createPublicKey(mine.publicKeyPem);

  assert.equal(verifyManifestSignature(bytes, "", publicKey), false);
  assert.equal(verifyManifestSignature(bytes, "!!!not base64!!!", publicKey), false);
  assert.equal(verifyManifestSignature(bytes, "AAAA", publicKey), false);
  assert.equal(verifyManifestSignature(bytes, signWith(theirs.privateKeyPem, bytes), publicKey), false);

  const own = signWith(mine.privateKeyPem, bytes);
  assert.equal(verifyManifestSignature(bytes, own, publicKey), true);
  // The signature covers these exact bytes, so any change at all breaks it.
  assert.equal(verifyManifestSignature(Buffer.from("manifest bytes "), own, publicKey), false);
});

test("keyIdFor is stable across PEM line-ending differences", () => {
  const { publicKeyPem } = generateKeyPair();
  assert.equal(keyIdFor(publicKeyPem), keyIdFor(publicKeyPem.replace(/\n/g, "\r\n")));
});

test("an unsigned bundle verifies, and --key against it is an error", async () => {
  const cwd = createProject();
  const { artifactDir } = await runDogfood({ cwd });
  const { publicPath } = writeKeyPair(keyDir(cwd));

  const bare = verifyBundle(artifactDir, { cwd });
  assert.equal(bare.ok, true);
  assert.equal(bare.signatureStatus, "absent");
  assert.equal(bare.verdict, "INTACT");
  assert.equal(bare.verificationLevel, "integrity");

  const withKey = verifyBundle(artifactDir, { cwd, key: publicPath });
  assert.equal(withKey.ok, false);
  assert.ok(withKey.errors.some((error) => error.includes("not signed")));
});

test("a signed bundle is unverified without --key and verified with the right one", async () => {
  const cwd = createProject();
  const { privatePath, publicPath } = writeKeyPair(keyDir(cwd));
  const { artifactDir } = await runDogfood({ cwd, sign: privatePath });
  assert.ok(existsSync(join(artifactDir, SIGNATURE_FILE)));

  // Bare verify must never claim provenance for a signature it did not check.
  const bare = verifyBundle(artifactDir, { cwd });
  assert.equal(bare.ok, true);
  assert.equal(bare.signatureStatus, "unverified");
  assert.equal(bare.verdict, "INTACT");
  assert.match(bare.notice, /not a trust anchor/);

  const anchored = verifyBundle(artifactDir, { cwd, key: publicPath });
  assert.equal(anchored.ok, true);
  assert.equal(anchored.signatureStatus, "verified");
  assert.equal(anchored.verdict, "AUTHENTICATED");
  assert.equal(anchored.verificationLevel, "provenance");
});

test("invalid signing metadata fails before a signature can be trusted", async () => {
  const cwd = createProject();
  const { privatePath, publicPath } = writeKeyPair(keyDir(cwd));
  const { artifactDir } = await runDogfood({ cwd, sign: privatePath });
  const manifestPath = join(artifactDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.signing.signatureFile = "other.sig";
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const result = verifyBundle(artifactDir, { cwd, key: publicPath });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("signatureFile must be manifest.sig")));

  manifest.signing.signatureFile = "manifest.sig";
  manifest.signing.publicKey = Buffer.from("not a public key").toString("base64");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const malformedKey = verifyBundle(artifactDir, { cwd, key: publicPath });
  assert.equal(malformedKey.ok, false);
  assert.ok(malformedKey.errors.some((error) => error.includes("must encode an ed25519 public key")));
});

test("a bundle signed by an attacker fails against the original key", async () => {
  const cwd = createProject();
  const mine = writeKeyPair(keyDir(cwd, "mine"));
  const theirs = writeKeyPair(keyDir(cwd, "theirs"));

  // The attacker owns the machine: they regenerate the manifest and sign it with their own key.
  const { artifactDir } = await runDogfood({ cwd, sign: theirs.privatePath });

  const anchored = verifyBundle(artifactDir, { cwd, key: mine.publicPath });
  assert.equal(anchored.ok, false, "a foreign signature must not verify against my key");
  assert.equal(anchored.signatureStatus, "invalid");
  assert.match(anchored.notice, /Do not trust it/);

  // It must also not look trustworthy merely because the bundle is internally self-consistent.
  assert.equal(verifyBundle(artifactDir, { cwd }).signatureStatus, "unverified");
});

test("editing the manifest after signing invalidates the signature", async () => {
  const cwd = createProject();
  const { privatePath, publicPath } = writeKeyPair(keyDir(cwd));
  const { artifactDir } = await runDogfood({ cwd, sign: privatePath });

  const manifestPath = join(artifactDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.runId = "forged";
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const anchored = verifyBundle(artifactDir, { cwd, key: publicPath });
  assert.equal(anchored.ok, false);
  assert.ok(anchored.errors.some((error) => error.includes("signature does not verify")));
});

test("a stripped signature file is an error when the manifest declares one", async () => {
  const cwd = createProject();
  const { privatePath } = writeKeyPair(keyDir(cwd));
  const { artifactDir } = await runDogfood({ cwd, sign: privatePath });

  rmSync(join(artifactDir, SIGNATURE_FILE));
  const stripped = verifyBundle(artifactDir, { cwd });
  assert.equal(stripped.ok, false);
  assert.ok(stripped.errors.some((error) => error.includes("declares a signature")));
});

test("a signature file without a manifest declaration is an error", async () => {
  const cwd = createProject();
  const { artifactDir } = await runDogfood({ cwd });
  writeFileSync(join(artifactDir, SIGNATURE_FILE), "AAAA\n", "utf8");

  const result = verifyBundle(artifactDir, { cwd });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("does not declare a signature")));
});

test("manifest.sig is exempt by exact name only, not by substring", async () => {
  const cwd = createProject();
  const { privatePath } = writeKeyPair(keyDir(cwd));
  const { artifactDir } = await runDogfood({ cwd, sign: privatePath });

  // A substring exemption is exactly the bug that let planted files through before.
  writeFileSync(join(artifactDir, "evidence-manifest.sig.bak"), "planted\n", "utf8");
  const result = verifyBundle(artifactDir, { cwd });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("unrecorded file is present in bundle")));
});
