import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicWriteFile, atomicWriteJson, isPathInside } from "./files.mjs";
import { validateAdvisoryReceipt } from "./validate.mjs";

export function collectAdvisoryEvidence(paths, { cwd, artifactDir, criteria = [] }) {
  const receipts = [];
  const errors = [];
  const workspace = realpathSync(cwd);
  const knownCriteria = new Set(criteria.map((criterion) => criterion.id));
  const destination = join(artifactDir, "evidence", "advisory");
  mkdirSync(destination, { recursive: true });

  for (const [index, input] of paths.entries()) {
    const label = `evidence[${index}]`;
    let receiptPath;
    try {
      receiptPath = safeWorkspacePath(input, workspace, cwd);
    } catch (error) {
      errors.push(`${label}: ${error.message}`);
      continue;
    }

    let receipt;
    try {
      receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    } catch (error) {
      errors.push(`${label}: could not read JSON receipt: ${error.message}`);
      continue;
    }

    const validation = validateAdvisoryReceipt(receipt);
    if (!validation.ok) {
      errors.push(...validation.errors.map((error) => `${label}: ${error}`));
      continue;
    }
    if (!knownCriteria.has(receipt.acId)) {
      errors.push(`${label}: references unknown acceptance criterion "${receipt.acId}"`);
      continue;
    }

    const copiedArtifacts = [];
    let artifactError = false;
    for (const [artifactIndex, artifact] of receipt.artifacts.entries()) {
      let source;
      try {
        source = safeWorkspacePath(artifact, workspace, cwd);
        if (!existsSync(source) || !statSync(source).isFile()) {
          throw new Error(`artifact is not a file: ${artifact}`);
        }
      } catch (error) {
        errors.push(`${label}.artifacts[${artifactIndex}]: ${error.message}`);
        artifactError = true;
        continue;
      }
      const relativeDestination = join(
        "artifacts",
        String(index + 1),
        `${artifactIndex + 1}-${safeSegment(basename(source))}`,
      );
      const target = join(destination, relativeDestination);
      mkdirSync(dirname(target), { recursive: true });
      atomicWriteFile(target, readFileSync(source));
      copiedArtifacts.push(relativeDestination.split(sep).join("/"));
    }
    if (artifactError) continue;

    const normalized = {
      ...receipt,
      source: relative(workspace, receiptPath).split(sep).join("/"),
      artifacts: copiedArtifacts,
    };
    const receiptFile = `receipt-${index + 1}.json`;
    atomicWriteJson(join(destination, receiptFile), normalized);
    receipts.push({ ...normalized, receiptFile: `evidence/advisory/${receiptFile}` });
  }

  return { receipts, errors };
}

// A copied basename becomes a bundle path, so it may not carry separators or non-portable bytes.
function safeSegment(value) { return String(value).replace(/[^A-Za-z0-9._-]+/g, "_"); }

function safeWorkspacePath(input, workspace, cwd) {
  const candidate = isAbsolute(input) ? input : resolve(cwd, input);
  if (!existsSync(candidate)) throw new Error(`path does not exist: ${input}`);
  const real = realpathSync(candidate);
  if (!isPathInside(workspace, real)) {
    throw new Error(`path escapes project workspace: ${input}`);
  }
  return real;
}
