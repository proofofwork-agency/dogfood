import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./files.mjs";

/**
 * TRUST MODEL — read this before changing anything in this file.
 *
 * The signature is DETACHED: it lives in manifest.sig, beside manifest.json, because a signature
 * cannot be contained in the bytes it signs. It covers the exact on-disk bytes of manifest.json,
 * never a re-serialized object — re-serializing would let a formatting change silently invalidate
 * or, worse, silently validate a different document.
 *
 * The public key recorded inside the manifest is NOT a trust anchor. Anyone who can regenerate the
 * manifest can also generate a fresh keypair and re-sign, so a self-described key proves only that
 * the bundle is internally consistent — which the checksums already prove.
 *
 * Therefore exactly one mode establishes provenance:
 *
 *   verify --key <public key you obtained out of band>   -> "verified"
 *
 * Bare verify on a signed bundle reports "unverified" and MUST NOT upgrade the verdict or describe
 * the bundle as trusted anywhere — CLI text, --json, or exit code. A signing scheme that looks
 * authoritative but anchors to itself is worse than no signing, because it invites trust the
 * artifact has not earned.
 */

export const SIGNATURE_FILE = "manifest.sig";
export const SIGNING_ALGORITHM = "ed25519";

export class SigningError extends Error {}

export function generateKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  };
}

export function writeKeyPair(directory, { force = false } = {}) {
  const privatePath = join(directory, "dogfood-signing-key");
  const publicPath = join(directory, "dogfood-signing-key.pub");
  if (!force && (existsSync(privatePath) || existsSync(publicPath))) {
    throw new SigningError(`Signing key already exists at ${privatePath} (use --force to overwrite)`);
  }
  const { privateKeyPem, publicKeyPem } = generateKeyPair();
  atomicWriteFile(privatePath, privateKeyPem, "utf8", { mode: 0o600 });
  atomicWriteFile(publicPath, publicKeyPem, "utf8");
  return { privatePath, publicPath, keyId: keyIdFor(publicKeyPem) };
}

export function loadPrivateKey(path) {
  let pem;
  try {
    pem = readFileSync(path, "utf8");
  } catch (error) {
    throw new SigningError(`Could not read signing key ${path}: ${error.message}`);
  }
  let key;
  try {
    key = createPrivateKey(pem);
  } catch (error) {
    throw new SigningError(`Signing key ${path} is not a readable private key: ${error.message}`);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new SigningError(`Signing key ${path} must be ed25519, not ${key.asymmetricKeyType}`);
  }
  return key;
}

export function loadPublicKey(path) {
  let pem;
  try {
    pem = readFileSync(path, "utf8");
  } catch (error) {
    throw new SigningError(`Could not read public key ${path}: ${error.message}`);
  }
  let key;
  try {
    key = createPublicKey(pem);
  } catch (error) {
    throw new SigningError(`Public key ${path} is not a readable public key: ${error.message}`);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new SigningError(`Public key ${path} must be ed25519, not ${key.asymmetricKeyType}`);
  }
  return key;
}

/** Sign the manifest bytes exactly as they exist on disk and write the detached signature. */
export function signManifest(artifactDir, privateKey) {
  const manifestPath = join(artifactDir, "manifest.json");
  const bytes = readFileSync(manifestPath);
  const signature = sign(null, bytes, privateKey).toString("base64");
  atomicWriteFile(join(artifactDir, SIGNATURE_FILE), `${signature}\n`, "utf8");
  return signature;
}

export function verifyManifestSignature(manifestBytes, signatureBase64, publicKey) {
  let signature;
  try {
    signature = Buffer.from(String(signatureBase64).trim(), "base64");
  } catch {
    return false;
  }
  if (signature.length === 0) return false;
  try {
    return verify(null, manifestBytes, publicKey, signature);
  } catch {
    return false;
  }
}

export function publicKeyPemOf(privateKey) {
  return createPublicKey(privateKey).export({ type: "spki", format: "pem" });
}

export function signingBlock(privateKey) {
  const publicKeyPem = publicKeyPemOf(privateKey);
  return {
    algorithm: SIGNING_ALGORITHM,
    keyId: keyIdFor(publicKeyPem),
    publicKey: Buffer.from(publicKeyPem, "utf8").toString("base64"),
    signatureFile: SIGNATURE_FILE,
  };
}

export function embeddedPublicKey(signingMetadata) {
  if (!signingMetadata?.publicKey) return null;
  try {
    return createPublicKey(Buffer.from(signingMetadata.publicKey, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export function keyIdFor(publicKeyPem) {
  return createHash("sha256").update(normalizePem(publicKeyPem)).digest("hex").slice(0, 32);
}

function normalizePem(pem) { return String(pem).replace(/\r\n/g, "\n").trim(); }
