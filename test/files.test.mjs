import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atomicWriteFile, sweepPendingTemps } from "../src/files.mjs";

test("atomicWriteFile leaves no temp sibling on success", () => {
  const root = createRoot();
  try {
    const target = join(root, "nested", "value.txt");
    atomicWriteFile(target, "value\n", "utf8");
    assert.equal(readFileSync(target, "utf8"), "value\n");
    assert.deepEqual(temps(join(root, "nested")), []);
    assert.deepEqual(sweepPendingTemps(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("atomicWriteFile leaves no temp sibling when the write fails", () => {
  const root = createRoot();
  try {
    const target = join(root, "occupied");
    mkdirSync(target);
    assert.throws(() => atomicWriteFile(target, "value\n", "utf8"));
    assert.deepEqual(temps(root), []);
    assert.deepEqual(sweepPendingTemps(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sweepPendingTemps removes only in-flight temps inside the given root", { skip: process.platform === "win32" }, () => {
  const root = createRoot();
  const outside = createRoot();
  try {
    // fs reads the options object after the temp is open, which is the only moment
    // a pending temp is observable from outside atomicWriteFile.
    let swept = null;
    const options = {
      get encoding() {
        swept ??= { outside: sweepPendingTemps(outside), root: sweepPendingTemps(root) };
        return "utf8";
      },
    };
    assert.throws(() => atomicWriteFile(join(root, "value.txt"), "value\n", options), /ENOENT/);
    assert.ok(swept, "fs never read the options object, so no temp was pending during the sweep");
    assert.deepEqual(swept.outside, []);
    assert.equal(swept.root.length, 1);
    assert.ok(swept.root[0].includes(".tmp-"), swept.root[0]);
    assert.equal(existsSync(swept.root[0]), false);
    assert.deepEqual(readdirSync(root), []);
    assert.deepEqual(sweepPendingTemps(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

function createRoot() { return mkdtempSync(join(tmpdir(), "dogfood-files-")); }
function temps(directory) { return readdirSync(directory).filter((name) => name.includes(".tmp-")); }
