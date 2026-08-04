import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BundleIntegrityError, listBundleEntries, listFiles, writeManifest } from "../src/report.mjs";

const noSymlinks = process.platform === "win32";

test("listBundleEntries records regular files and recurses into real directories", () => {
  const root = createBundle();
  try {
    assert.deepEqual(kinds(root), [["commands/proof/stdout.log", "file"], ["summary.json", "file"]]);
    assert.deepEqual(listFiles(root), [join(root, "commands", "proof", "stdout.log"), join(root, "summary.json")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listBundleEntries reports symlinks without following them", { skip: noSymlinks }, () => {
  const root = createBundle();
  try {
    symlinkSync(join(root, "summary.json"), join(root, "link.json"));
    symlinkSync(join(root, "commands"), join(root, "link-dir"));
    assert.deepEqual(kinds(root), [
      ["commands/proof/stdout.log", "file"],
      ["link-dir", "symlink"],
      ["link.json", "symlink"],
      ["summary.json", "file"],
    ]);
    assert.deepEqual(listFiles(root), [join(root, "commands", "proof", "stdout.log"), join(root, "summary.json")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeManifest checksums every regular file except manifest.json", () => {
  const root = createBundle();
  try {
    writeFileSync(join(root, "manifest.json"), "{}\n", "utf8");
    const manifest = writeManifest(root, {});
    assert.deepEqual(Object.keys(manifest.checksums).sort(), ["commands/proof/stdout.log", "summary.json"]);
    assert.equal(JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")).version, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeManifest fails closed on an entry it cannot checksum", { skip: noSymlinks }, () => {
  const root = createBundle();
  try {
    symlinkSync(join(root, "summary.json"), join(root, "link.json"));
    assert.throws(() => writeManifest(root, {}), (error) => error instanceof BundleIntegrityError && /non-regular entry/.test(error.message));
    assert.equal(existsSync(join(root, "manifest.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("entry names come from the walk, so a backslash or padding cannot alias a recorded file", { skip: noSymlinks }, () => {
  const root = createBundle();
  try {
    // On POSIX these are ordinary filename bytes; re-deriving a name via realpath collapsed
    // them onto summary.json, which made a planted file look like an already-recorded one.
    for (const name of ["\\summary.json", ".\\summary.json", "summary.json ", "summary.json\t"]) {
      writeFileSync(join(root, name), "payload\n", "utf8");
    }
    writeFileSync(join(root, "commands", "proof", "stdout.log\\"), "payload\n", "utf8");
    assert.deepEqual(names(root), [
      ".\\summary.json",
      "\\summary.json",
      "commands/proof/stdout.log",
      "commands/proof/stdout.log\\",
      "summary.json",
      "summary.json\t",
      "summary.json ",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty directory is its own entry and writeManifest prunes it", () => {
  const root = createBundle();
  try {
    mkdirSync(join(root, "ghost", "nested-empty"), { recursive: true });
    assert.deepEqual(kinds(root).filter(([, kind]) => kind === "directory"), [["ghost/nested-empty", "directory"]]);
    const manifest = writeManifest(root, {});
    assert.equal(existsSync(join(root, "ghost")), false);
    assert.deepEqual(Object.keys(manifest.checksums).sort(), ["commands/proof/stdout.log", "summary.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeManifest fails closed on a hardlinked entry naming the planted file", () => {
  const root = createBundle();
  const outside = mkdtempSync(join(tmpdir(), "dogfood-outside-"));
  try {
    const payload = join(outside, "payload.txt");
    writeFileSync(payload, "OUTSIDE\n", "utf8");
    linkSync(payload, join(root, "planted-hard.txt"));
    assert.deepEqual(kinds(root).filter(([, kind]) => kind === "hardlink"), [["planted-hard.txt", "hardlink"]]);
    assert.throws(
      () => writeManifest(root, {}),
      (error) => error instanceof BundleIntegrityError && /second hard link.*planted-hard\.txt/.test(error.message),
    );
    assert.equal(existsSync(join(root, "manifest.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

function createBundle() {
  const root = mkdtempSync(join(tmpdir(), "dogfood-report-"));
  writeFileSync(join(root, "summary.json"), "{}\n", "utf8");
  mkdirSync(join(root, "commands", "proof"), { recursive: true });
  writeFileSync(join(root, "commands", "proof", "stdout.log"), "proof passed\n", "utf8");
  return root;
}

function kinds(root) { return listBundleEntries(root).map((entry) => [entry.name, entry.kind]); }
function names(root) { return listBundleEntries(root).map((entry) => entry.name); }
