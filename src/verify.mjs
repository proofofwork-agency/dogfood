import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { sha256 } from "./hash.mjs";
import { listBundleEntries } from "./report.mjs";
import { embeddedPublicKey, loadPublicKey, SIGNATURE_FILE, verifyManifestSignature } from "./sign.mjs";

const NOTICE_UNSIGNED = "Integrity verification proves internal consistency, not cryptographic provenance. A malicious actor can regenerate this unsigned manifest. Sign it with dogfood run --sign to bind it to a key.";
const NOTICE_UNVERIFIED = "This bundle carries a signature that was NOT checked. The public key recorded inside a manifest is not a trust anchor, because whoever regenerates the manifest can also regenerate the key. Re-run with --key <public key obtained out of band> to establish provenance.";
const NOTICE_VERIFIED = "The detached signature was verified against the supplied public key, so this bundle came from the holder of that key. Provenance is only as good as your independent trust in the key.";
const NOTICE_INVALID = "This bundle carries a signature that does NOT match the supplied public key. Either the bundle was altered after signing, or it was signed by someone else. Do not trust it.";

export function verifyBundle(bundleDir, { subject = null, key = null, cwd = process.cwd() } = {}) {
  const directory = resolve(cwd, bundleDir);
  const errors = [];
  const warnings = [];
  let signatureStatus = "absent";
  const manifestPath = join(directory, "manifest.json");
  if (!existsSync(manifestPath)) return result(directory, null, ["manifest.json is missing"], warnings);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return result(directory, null, [`manifest.json is invalid JSON: ${error.message}`], warnings);
  }
  validateManifest(manifest, errors);
  if (errors.length > 0) return result(directory, manifest, errors, warnings);
  const recorded = new Set(Object.keys(manifest.checksums));
  const requiredFiles = ["summary.json", "summary.md", "matrix.json", "junit.xml", manifest.contract.originalFile, manifest.contract.snapshotFile];
  if (manifest.policy) requiredFiles.push(manifest.policy.originalFile, manifest.policy.snapshotFile);
  for (const name of requiredFiles) {
    if (!recorded.has(name)) errors.push(`required bundle file is not recorded in checksums: ${name}`);
  }
  for (const [name, expected] of Object.entries(manifest.checksums)) {
    const path = safeBundlePath(directory, name);
    if (!path) {
      errors.push(`checksum path escapes the bundle: ${name}`);
      continue;
    }
    if (!existsSync(path)) {
      errors.push(`recorded file is missing: ${name}`);
      continue;
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      errors.push(`recorded path is not a regular file: ${name}`);
      continue;
    }
    const actual = sha256(readFileSync(path));
    if (actual !== expected) errors.push(`checksum mismatch: ${name}`);
  }
  let entries = [];
  try {
    entries = listBundleEntries(directory);
  } catch (error) {
    errors.push(`bundle contents could not be enumerated: ${error.message}`);
  }
  for (const entry of entries) {
    if (entry.kind === "directory") {
      errors.push(`unrecorded directory is present in bundle: ${entry.name}`);
      continue;
    }
    if (entry.kind === "hardlink") {
      // An archiver may legitimately hardlink a stored bundle, so this cannot be an error.
      warnings.push(`recorded file has a second hard link, so its content can change from outside the bundle: ${entry.name}`);
    } else if (entry.kind !== "file") {
      errors.push(`bundle contains a non-regular file: ${entry.name}`);
      continue;
    }
    // Exempt by EXACT name only. A substring exemption is what let planted files through before.
    if (entry.name !== "manifest.json" && entry.name !== SIGNATURE_FILE && !recorded.has(entry.name)) {
      errors.push(`unrecorded file is present in bundle: ${entry.name}`);
    }
  }

  verifyNormalizedDocument(directory, manifest.contract, "contract", errors);
  if (manifest.policy) verifyNormalizedDocument(directory, manifest.policy, "policy", errors);

  let report = null;
  const reportPath = join(directory, "summary.json");
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (error) {
    errors.push(`summary.json is invalid or missing: ${error.message}`);
  }
  if (report) {
    for (const field of ["version", "runId", "mode", "profile", "verdict", "validationVerdict", "proofVerdict", "startedAt", "finishedAt"]) {
      if (JSON.stringify(report[field]) !== JSON.stringify(manifest[field])) errors.push(`report/manifest mismatch: ${field}`);
    }
    if (JSON.stringify(report.repository) !== JSON.stringify(manifest.repository)) errors.push("report/manifest mismatch: repository identity");
    if (JSON.stringify(report.buildSubject) !== JSON.stringify(manifest.build?.subject || null)) errors.push("report/manifest mismatch: build subject metadata");
    if (report.digests?.sourceContract !== manifest.contract.sourceDigest) errors.push("report/manifest mismatch: source contract digest");
    if (report.digests?.normalizedContract !== manifest.contract.normalizedDigest) errors.push("report/manifest mismatch: normalized contract digest");
    if ((report.digests?.sourcePolicy ?? null) !== (manifest.policy?.sourceDigest ?? null)) errors.push("report/manifest mismatch: source policy digest");
    if ((report.digests?.normalizedPolicy ?? null) !== (manifest.policy?.normalizedDigest ?? null)) errors.push("report/manifest mismatch: normalized policy digest");
  }

  const declaredSubject = manifest.build?.subject || null;
  if (declaredSubject && !subject) {
    errors.push("bundle declares a build subject; --subject <file> is required for verification");
  } else if (declaredSubject && subject) {
    const subjectPath = resolve(cwd, subject);
    if (!existsSync(subjectPath) || !statSync(subjectPath).isFile()) {
      errors.push(`subject is missing or not a regular file: ${subject}`);
    } else {
      const value = readFileSync(subjectPath);
      const digest = createHash(declaredSubject.algorithm).update(value).digest("hex");
      if (digest !== declaredSubject.digest) errors.push("build subject digest does not match the bundle");
      if (value.length !== declaredSubject.size) errors.push("build subject size does not match the bundle");
    }
  } else if (!declaredSubject && subject) {
    errors.push("--subject was supplied but the bundle does not declare a build subject");
  }

  signatureStatus = checkSignature(directory, manifest, key, cwd, errors);
  return result(directory, manifest, errors, warnings, signatureStatus);
}

/**
 * Returns "absent" | "unverified" | "verified". Anything wrong pushes an error and the bundle is
 * INVALID; a signature that is merely unchecked is NOT an error, but it is also not provenance.
 */
function checkSignature(directory, manifest, key, cwd, errors) {
  const signaturePath = join(directory, SIGNATURE_FILE);
  const declared = manifest.signing || null;
  const present = existsSync(signaturePath);

  if (declared && !present) {
    errors.push(`manifest declares a signature but ${SIGNATURE_FILE} is missing`);
    return "absent";
  }
  if (!declared && present) {
    errors.push(`${SIGNATURE_FILE} is present but the manifest does not declare a signature`);
    return "absent";
  }
  if (!declared) {
    if (key) errors.push("--key was supplied but the bundle is not signed");
    return "absent";
  }
  if (declared.algorithm !== "ed25519") {
    errors.push(`unsupported signature algorithm: ${JSON.stringify(declared.algorithm)}`);
    return "absent";
  }

  const manifestBytes = readFileSync(join(directory, "manifest.json"));
  const signature = readFileSync(signaturePath, "utf8");

  if (!key) {
    // Deliberately do NOT validate against the embedded key and call it verified. Doing so would
    // anchor the bundle to itself and turn a self-signed forgery into a green check.
    return "unverified";
  }

  let anchor;
  try {
    anchor = loadPublicKey(resolve(cwd, key));
  } catch (error) {
    errors.push(error.message);
    return "unverified";
  }
  if (!verifyManifestSignature(manifestBytes, signature, anchor)) {
    errors.push("manifest signature does not verify against the supplied public key");
    return "invalid";
  }
  const embedded = embeddedPublicKey(declared);
  if (embedded && embedded.export({ type: "spki", format: "pem" }) !== anchor.export({ type: "spki", format: "pem" })) {
    errors.push("bundle records a different public key than the one supplied");
    return "invalid";
  }
  return "verified";
}

function validateManifest(manifest, errors) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    errors.push("manifest root must be an object");
    return;
  }
  if (manifest.version !== 1) errors.push(`unsupported manifest version: ${JSON.stringify(manifest.version)}`);
  const allowed = new Set([
    "version", "checksumAlgorithm", "runId", "mode", "profile", "verdict", "validationVerdict",
    "proofVerdict", "contract", "policy", "repository", "runtime", "package", "build", "commands",
    "adapters", "baseline", "metadata", "startedAt", "finishedAt", "checksums", "signing", "integrityNotice",
  ]);
  for (const field of Object.keys(manifest)) {
    if (!allowed.has(field)) errors.push(`manifest has unknown field: ${field}`);
  }
  if (manifest.checksumAlgorithm !== "sha256") errors.push("manifest checksumAlgorithm must be sha256");
  for (const name of ["runId", "mode", "profile", "verdict", "validationVerdict", "proofVerdict", "startedAt", "finishedAt"]) {
    if (typeof manifest[name] !== "string" || manifest[name].length === 0) errors.push(`manifest.${name} must be a non-empty string`);
  }
  if (!["validate", "run"].includes(manifest.mode)) errors.push("manifest.mode must be validate or run");
  if (!["standard", "authoritative"].includes(manifest.profile)) errors.push("manifest.profile must be standard or authoritative");
  if (!["VALID", "INVALID"].includes(manifest.validationVerdict)) errors.push("manifest.validationVerdict is invalid");
  if (!["NOT_RUN", "PASS", "FAIL", "INFRA_ERROR"].includes(manifest.proofVerdict)) errors.push("manifest.proofVerdict is invalid");
  if (manifest.mode === "validate" && manifest.verdict !== manifest.validationVerdict) errors.push("validate manifest verdict must equal validationVerdict");
  if (manifest.mode === "validate" && manifest.proofVerdict !== "NOT_RUN") errors.push("validate manifest proofVerdict must be NOT_RUN");
  if (manifest.mode === "run" && !["PASS", "FAIL", "INFRA_ERROR"].includes(manifest.verdict)) errors.push("run manifest verdict is invalid");
  if (manifest.mode === "run" && manifest.validationVerdict === "VALID" && manifest.proofVerdict !== manifest.verdict) errors.push("valid run manifest proofVerdict must equal verdict");
  if (manifest.mode === "run" && manifest.validationVerdict === "INVALID" && (manifest.verdict !== "FAIL" || manifest.proofVerdict !== "NOT_RUN")) errors.push("invalid run manifest must be FAIL with proofVerdict NOT_RUN");
  if (manifest.profile === "authoritative" && !manifest.policy) errors.push("authoritative manifest requires policy metadata");
  if (manifest.profile === "standard" && manifest.policy) errors.push("standard manifest must not contain policy metadata");
  if (!manifest.contract || typeof manifest.contract !== "object") errors.push("manifest.contract is required");
  else validateDigestRecord(manifest.contract, "manifest.contract", errors);
  if (manifest.policy !== null && manifest.policy !== undefined) validateDigestRecord(manifest.policy, "manifest.policy", errors);
  if (!manifest.checksums || typeof manifest.checksums !== "object" || Array.isArray(manifest.checksums)) errors.push("manifest.checksums must be an object");
  else {
    for (const [name, digest] of Object.entries(manifest.checksums)) {
      if (!name || isAbsolute(name) || name.split(/[\\/]/).includes("..")) errors.push(`invalid checksum path: ${name}`);
      if (!/^[a-f0-9]{64}$/.test(digest)) errors.push(`invalid sha256 checksum for ${name}`);
    }
  }
  if (!manifest.repository || typeof manifest.repository !== "object") errors.push("manifest.repository is required");
  if (!manifest.build || typeof manifest.build !== "object") errors.push("manifest.build is required");
  else if (manifest.build.subject !== null && manifest.build.subject !== undefined) {
    const subject = manifest.build.subject;
    if (!subject || typeof subject !== "object" || subject.algorithm !== "sha256" ||
      typeof subject.path !== "string" || !subject.path || !/^[a-f0-9]{64}$/.test(subject.digest || "") ||
      !Number.isSafeInteger(subject.size) || subject.size < 0) {
      errors.push("manifest.build.subject is invalid");
    }
  }
}

function validateDigestRecord(record, label, errors) {
  for (const field of Object.keys(record || {})) {
    if (!["originalFile", "snapshotFile", "sourceDigest", "normalizedDigest"].includes(field)) {
      errors.push(`${label} has unknown field: ${field}`);
    }
  }
  for (const name of ["originalFile", "snapshotFile"]) {
    if (typeof record[name] !== "string" || !record[name]) errors.push(`${label}.${name} must be a non-empty string`);
  }
  for (const name of ["sourceDigest", "normalizedDigest"]) {
    if (!/^[a-f0-9]{64}$/.test(record[name] || "")) errors.push(`${label}.${name} must be a sha256 digest`);
  }
}

function verifyNormalizedDocument(directory, record, label, errors) {
  const originalPath = safeBundlePath(directory, record.originalFile);
  const snapshotPath = safeBundlePath(directory, record.snapshotFile);
  if (!originalPath || !snapshotPath) {
    errors.push(`${label} document path escapes the bundle`);
    return;
  }
  if (!existsSync(originalPath)) errors.push(`${label} original document is missing`);
  if (!existsSync(snapshotPath)) errors.push(`${label} normalized snapshot is missing`);
  if (!existsSync(originalPath) || !existsSync(snapshotPath)) return;
  const original = readFileSync(originalPath, "utf8");
  const snapshot = readFileSync(snapshotPath, "utf8");
  if (sha256(original) !== record.sourceDigest) errors.push(`${label} source digest mismatch`);
  let normalized;
  try {
    normalized = stringifyYaml(parseYaml(original), { lineWidth: 0 });
  } catch (error) {
    errors.push(`${label} original document cannot be normalized: ${error.message}`);
    return;
  }
  if (sha256(normalized) !== record.normalizedDigest) errors.push(`${label} normalized digest mismatch`);
  if (normalized !== snapshot) errors.push(`${label} normalized snapshot does not match the exact source document`);
  if (sha256(snapshot) !== record.normalizedDigest) errors.push(`${label} snapshot digest mismatch`);
}

function safeBundlePath(directory, name) {
  if (typeof name !== "string" || isAbsolute(name)) return null;
  const root = resolve(directory);
  const candidate = resolve(root, name);
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return candidate;
}

function result(directory, manifest, errors, warnings, signatureStatus = "absent") {
  const notice = signatureStatus === "verified"
    ? NOTICE_VERIFIED
    : signatureStatus === "unverified"
      ? NOTICE_UNVERIFIED
      : signatureStatus === "invalid"
        ? NOTICE_INVALID
        : NOTICE_UNSIGNED;
  return {
    version: 1,
    bundleDir: directory,
    runId: manifest?.runId || null,
    ok: errors.length === 0,
    // A present-but-unchecked signature never upgrades this verdict: only the checksum walk and an
    // externally anchored --key can. See the trust-model note in src/sign.mjs.
    verdict: errors.length === 0 ? "VERIFIED" : "INVALID",
    signatureStatus,
    errors,
    warnings,
    notice,
  };
}


