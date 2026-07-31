/**
 * Snippet: call dogfood at the end of implement-batch (or any JS workflow).
 *
 * Paste near the end of implement-batch.js after merges / CI green.
 * Adjust import path to your dogfood package location.
 *
 * Policy:
 * - FAIL => do not mark batch final; open fix handoff / tickets
 * - INFRA_ERROR => recover env, re-run once
 * - Do NOT auto-repair product code inside this hook
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * @param {object} opts
 * @param {string} opts.cwd - product repo root
 * @param {string} [opts.dogfoodBin] - path to dogfood.mjs or "dogfood" on PATH
 * @returns {{ ok: boolean, verdict: string, status: number }}
 */
export function runDogfoodGate({ cwd, dogfoodBin = "dogfood" }) {
  const result = spawnSync(
    dogfoodBin,
    ["run", "--cwd", resolve(cwd), "--json"],
    {
      encoding: "utf8",
      shell: false,
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    },
  );

  let verdict = "FAIL";
  try {
    const parsed = JSON.parse(result.stdout || "{}");
    verdict = parsed.verdict || verdict;
  } catch {
    // non-json stdout
  }

  const status = result.status ?? 1;
  return {
    ok: status === 0 && verdict === "PASS",
    verdict,
    status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

// Example usage in workflow:
//
// const gate = runDogfoodGate({ cwd: projectRoot });
// if (!gate.ok) {
//   console.error(`Dogfood ${gate.verdict} — batch not final`);
//   // handoff to re-implement with artifacts/dogfood/latest.json
//   process.exit(gate.status === 2 ? 2 : 1);
// }
