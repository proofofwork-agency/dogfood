import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { listFiles, sha256 } from "./report.mjs";

const NOTICE = "Integrity verification proves internal consistency, not cryptographic provenance. A malicious actor can regenerate this unsigned manifest; signing is deferred.";

export function verifyBundle(bundleDir, { subject = null, cwd = process.cwd() } = {}) {
  const directory = resolve(cwd, bundleDir);
  const errors = [];
  const warnings = [];
  const manifestPath = join(directory, "manifest.json");
  if (!existsSync(manifestPath)) return result(directory, null, ["manifest.json is missing"], warnings);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return result(directory, null, [`manifest.json is invalid JSON: ${error.message}`], warnings);
  }
  if (manifest?.version === 2) {
    return result(directory, manifest, ["report/manifest v2 cannot be verified reproducibly because it lacks a source-contract digest; rerun with Dogfood v0.3"], warnings);
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
  for (const file of listFiles(directory)) {
    const name = portableRelative(directory, file);
    if (name !== "manifest.json" && !recorded.has(name) && !name.includes(".tmp-")) {
      errors.push(`unrecorded file is present in bundle: ${name}`);
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
  return result(directory, manifest, errors, warnings);
}

function validateManifest(manifest, errors) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    errors.push("manifest root must be an object");
    return;
  }
  if (manifest.version !== 3) errors.push(`unsupported manifest version: ${JSON.stringify(manifest.version)}`);
  const allowed = new Set([
    "version", "checksumAlgorithm", "runId", "mode", "profile", "verdict", "validationVerdict",
    "proofVerdict", "contract", "policy", "repository", "runtime", "package", "build", "commands",
    "adapters", "baseline", "metadata", "startedAt", "finishedAt", "checksums", "integrityNotice",
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
  const candidate = resolve(directory, name);
  const rel = relative(directory, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return candidate;
}

function result(directory, manifest, errors, warnings) {
  return {
    version: 1,
    bundleDir: directory,
    runId: manifest?.runId || null,
    ok: errors.length === 0,
    verdict: errors.length === 0 ? "VERIFIED" : "INVALID",
    errors,
    warnings,
    notice: NOTICE,
  };
}

function portableRelative(from, to) {
  return relative(from, to).split(sep).join("/") || ".";
}
