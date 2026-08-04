import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Streamed so a large untracked file cannot be held in memory all at once. */
export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
