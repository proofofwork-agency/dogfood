import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
  closeSync,
} from "node:fs";
import { dirname } from "node:path";

export function atomicWriteFile(path, value, encoding = undefined) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, value, encoding);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function atomicWriteJson(path, value) {
  atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
