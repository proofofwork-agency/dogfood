import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateAdapter, prepareAdapter } from "./adapters.mjs";
import { captureRepositoryState, repositoryStateChanged } from "./repository.mjs";

const MAX_CAPTURE_BYTES = 5 * 1024 * 1024;

export function runCommand(name, command, { cwd, timeoutMs = 600_000, env = process.env } = {}) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      env: { ...env, DOGFOOD: "1" },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutCapture = createCapture();
    const stderrCapture = createCapture();
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
      killTimer.unref();
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      appendCapture(stdoutCapture, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      appendCapture(stderrCapture, chunk);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        name,
        command,
        code: null,
        signal: null,
        timedOut,
        timeoutMs,
        durationMs: Date.now() - started,
        startedAt,
        finishedAt: new Date().toISOString(),
        stdout: finishCapture(stdoutCapture),
        stderr: `${finishCapture(stderrCapture)}\n${error.message}`.trim(),
        stdoutTruncated: stdoutCapture.truncated,
        stderrTruncated: stderrCapture.truncated,
        status: "infra",
      });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        name,
        command,
        code,
        signal,
        timedOut,
        timeoutMs,
        durationMs: Date.now() - started,
        startedAt,
        finishedAt: new Date().toISOString(),
        stdout: finishCapture(stdoutCapture),
        stderr: finishCapture(stderrCapture),
        stdoutTruncated: stdoutCapture.truncated,
        stderrTruncated: stderrCapture.truncated,
        status: timedOut || code === null || signal ? "infra" : code === 0 ? "pass" : "fail",
      });
    });
  });
}

export async function runNamedCommands(
  names,
  commands,
  { cwd, artifactDir, timeoutMs, expectedTagsByCommand = {} },
) {
  const results = [];
  for (const name of names) {
    const definition = commands[name];
    const prepared = prepareAdapter(name, definition, artifactDir);
    const beforeRepository = await captureRepositoryState(cwd);
    const effectiveTimeoutMs = timeoutMs == null
      ? definition.timeoutMs
      : Math.min(timeoutMs, definition.timeoutMs);
    const processResult = await runCommand(name, definition.run, {
      cwd,
      timeoutMs: effectiveTimeoutMs,
      env: { ...process.env, ...prepared.env },
    });
    const afterRepository = await captureRepositoryState(cwd);
    const mutationDetected = repositoryStateChanged(beforeRepository, afterRepository);
    const repositoryInspectionFailed = !beforeRepository.available || !afterRepository.available;
    const adapter = evaluateAdapter(
      definition,
      processResult,
      prepared,
      expectedTagsByCommand[name] || [],
    );

    let status = adapter.status;
    let detail = adapter.detail;
    if (processResult.status === "infra") {
      status = "infra";
    } else if (processResult.status === "fail") {
      status = "fail";
    } else if (repositoryInspectionFailed) {
      status = "infra";
      detail = "tracked repository state could not be inspected before and after the command";
    }
    if (mutationDetected) {
      status = "fail";
      detail = "verification command changed tracked repository state";
    }

    const result = {
      ...processResult,
      definition,
      status,
      detail,
      adapter,
      evidence: {
        report: prepared.reportFile,
        evaluation: prepared.evaluationFile,
      },
      mutationDetected,
      repositoryInspectionFailed,
      repositoryBefore: summarizeRepository(beforeRepository),
      repositoryAfter: summarizeRepository(afterRepository),
    };
    results.push(result);
    writeCommandLogs(artifactDir, [result]);
  }
  return results;
}

export function writeCommandLogs(artifactDir, results) {
  const root = join(artifactDir, "commands");
  mkdirSync(root, { recursive: true });
  for (const result of results) {
    const directory = join(root, safeSegment(result.name));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "stdout.log"), result.stdout || "", "utf8");
    writeFileSync(join(directory, "stderr.log"), result.stderr || "", "utf8");
    writeFileSync(
      join(directory, "metadata.json"),
      JSON.stringify(
        {
          name: result.name,
          definition: result.definition || null,
          command: result.command,
          status: result.status,
          detail: result.detail || null,
          code: result.code,
          signal: result.signal,
          timedOut: result.timedOut,
          timeoutMs: result.timeoutMs,
          durationMs: result.durationMs,
          startedAt: result.startedAt,
          finishedAt: result.finishedAt,
          stdoutTruncated: result.stdoutTruncated,
          stderrTruncated: result.stderrTruncated,
          mutationDetected: result.mutationDetected || false,
          repositoryInspectionFailed: result.repositoryInspectionFailed || false,
          repositoryBefore: result.repositoryBefore || null,
          repositoryAfter: result.repositoryAfter || null,
          evidence: result.evidence || null,
          adapter: result.adapter || null,
        },
        null,
        2,
      ),
      "utf8",
    );
  }
}

function summarizeRepository(repository) {
  return {
    available: repository.available,
    head: repository.head,
    dirty: repository.dirty,
    trackedDirty: repository.trackedDirty,
    dirtyStateDigest: repository.dirtyStateDigest,
    diffDigest: repository.diffDigest,
    error: repository.error,
  };
}

function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, "_");
}

function createCapture() {
  return { chunks: [], bytes: 0, truncated: false };
}

function appendCapture(capture, chunk) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  capture.chunks.push(buffer);
  capture.bytes += buffer.length;
  while (capture.bytes > MAX_CAPTURE_BYTES) {
    const excess = capture.bytes - MAX_CAPTURE_BYTES;
    const first = capture.chunks[0];
    if (first.length <= excess) {
      capture.chunks.shift();
      capture.bytes -= first.length;
    } else {
      capture.chunks[0] = first.subarray(excess);
      capture.bytes -= excess;
    }
    capture.truncated = true;
  }
}

function finishCapture(capture) {
  const buffer = Buffer.concat(capture.chunks, capture.bytes);
  let start = 0;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString("utf8");
}
