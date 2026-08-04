import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { evaluateAdapter, prepareAdapter } from "./adapters.mjs";
import { atomicWriteFile, atomicWriteJson, safeSegment } from "./files.mjs";
import { createDocumentRedactor, createRedactor, redactDeep } from "./redact.mjs";
import {
  authoritativeRepositoryProblems,
  captureRepositoryState,
  repositoryStateChanged,
  summarizeRepository,
} from "./repository.mjs";

const MAX_CAPTURE_BYTES = 5 * 1024 * 1024;

export function runCommand(
  name,
  command,
  { cwd, timeoutMs = 600_000, env = process.env, signal } = {},
) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  return new Promise((resolvePromise) => {
    const detached = process.platform !== "win32";
    const child = spawn(command, {
      cwd,
      env: { ...env, DOGFOOD: "1" },
      shell: true,
      detached,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutCapture = createCapture();
    const stderrCapture = createCapture();
    let settled = false;
    let timedOut = false;
    let interrupted = false;
    let closeResult = null;
    let forceKillTimer = null;
    let forceSweepDone = false;

    const finish = (code, childSignal, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", abort);
      resolvePromise({
        name,
        command,
        code,
        signal: childSignal,
        timedOut,
        interrupted,
        timeoutMs,
        durationMs: Date.now() - started,
        startedAt,
        finishedAt: new Date().toISOString(),
        stdout: finishCapture(stdoutCapture),
        stderr: `${finishCapture(stderrCapture)}${error ? `\n${error.message}` : ""}`.trim(),
        stdoutTruncated: stdoutCapture.truncated,
        stderrTruncated: stderrCapture.truncated,
        status: timedOut || interrupted || error || code === null || childSignal
          ? "infra"
          : code === 0 ? "pass" : "fail",
      });
    };

    const terminate = (reason) => {
      if (settled || timedOut || interrupted) return;
      if (reason === "timeout") timedOut = true;
      else interrupted = true;
      terminateTree(child.pid, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        terminateTree(child.pid, "SIGKILL");
        forceSweepDone = true;
        if (closeResult) finish(closeResult.code, closeResult.signal);
      }, 500);
    };
    const abort = () => terminate("interrupted");
    const timer = setTimeout(() => terminate("timeout"), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();

    child.stdout?.on("data", (chunk) => appendCapture(stdoutCapture, chunk));
    child.stderr?.on("data", (chunk) => appendCapture(stderrCapture, chunk));
    child.on("error", (error) => finish(null, null, error));
    child.on("close", (code, childSignal) => {
      closeResult = { code, signal: childSignal };
      if (!timedOut && !interrupted) finish(code, childSignal);
      else if (forceSweepDone) finish(code, childSignal);
      // During termination, wait for the forced process-group sweep before resolving.
    });
  });
}

export async function runNamedCommands(
  names,
  commands,
  {
    cwd,
    artifactDir,
    timeoutMs,
    expectedTagsByCommand = {},
    authoritative = false,
    allowUntracked = [],
    logs = null,
    signal,
  },
) {
  const results = [];
  for (const name of names) {
    if (signal?.aborted) {
      const definition = commands[name];
      const timestamp = new Date().toISOString();
      const result = {
        name,
        command: definition.run,
        definition,
        code: null,
        signal: null,
        timedOut: false,
        interrupted: true,
        timeoutMs: timeoutMs == null ? definition.timeoutMs : Math.min(timeoutMs, definition.timeoutMs),
        durationMs: 0,
        startedAt: timestamp,
        finishedAt: timestamp,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        status: "infra",
        detail: "command was not started because the proof was interrupted",
        adapter: {
          adapter: definition.adapter,
          version: null,
          status: "infra",
          detail: "command was not started because the proof was interrupted",
          tags: {},
        },
        evidence: { report: null, evaluation: null, reportSource: null, reportAccepted: null },
        mutationDetected: false,
        mutationProblems: [],
        repositoryInspectionFailed: false,
        repositoryBefore: null,
        repositoryAfter: null,
      };
      results.push(result);
      writeCommandLogs(artifactDir, [result], { logs, env: process.env });
      continue;
    }
    const definition = commands[name];
    const prepared = prepareAdapter(name, definition, artifactDir);
    const beforeRepository = await captureRepositoryState(cwd, { authoritative });
    const effectiveTimeoutMs = timeoutMs == null
      ? definition.timeoutMs
      : Math.min(timeoutMs, definition.timeoutMs);
    const processResult = await runCommand(name, definition.run, {
      cwd,
      timeoutMs: effectiveTimeoutMs,
      env: { ...process.env, ...prepared.env },
      signal,
    });
    const afterRepository = await captureRepositoryState(cwd, { authoritative });
    const authoritativeProblems = authoritative
      ? authoritativeRepositoryProblems(beforeRepository, afterRepository, allowUntracked)
      : [];
    // A repository that was already dirty before this command started is a problem with the run,
    // not evidence that this command wrote anything. It is reported by the run, never charged here.
    const mutationDetected = authoritative
      ? authoritativeProblems.some((problem) => problem.code !== "initial-tracked-dirty")
      : repositoryStateChanged(beforeRepository, afterRepository);
    const repositoryInspectionFailed = !beforeRepository.available || !afterRepository.available;
    const adapter = evaluateAdapter(
      definition,
      processResult,
      prepared,
      expectedTagsByCommand[name] || [],
      logs,
    );

    let status = adapter.status;
    let detail = adapter.detail;
    if (processResult.status === "infra") {
      status = "infra";
      detail = processResult.interrupted ? "command was interrupted" : adapter.detail;
    } else if (processResult.status === "fail") {
      status = "fail";
    } else if (repositoryInspectionFailed) {
      status = "infra";
      detail = "repository state could not be inspected before and after the command";
    }
    if (mutationDetected) {
      status = "fail";
      detail = authoritativeProblems.map((problem) => problem.message).join("; ")
        || "verification command changed tracked repository state";
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
        reportSource: adapter.reportSource ?? null,
        reportAccepted: adapter.accepted ?? null,
      },
      mutationDetected,
      mutationProblems: authoritativeProblems,
      repositoryInspectionFailed,
      repositoryBefore: summarizeRepository(beforeRepository, { cwd }),
      repositoryAfter: summarizeRepository(afterRepository, { cwd }),
    };
    results.push(result);
    writeCommandLogs(artifactDir, [result], { logs, env: process.env });
  }
  return results;
}

export function writeCommandLogs(artifactDir, results, { logs = null, env = process.env } = {}) {
  const root = join(artifactDir, "commands");
  mkdirSync(root, { recursive: true });
  // A secret on a command line is published unless the recorded definition is masked too. A
  // declared literal is masked in every capture mode; the log redactor then covers the values
  // that only exist in the environment, exactly as it does for the captured output.
  const documentRedactor = createDocumentRedactor(logs);
  const logRedactor = createRedactor(logs, env);
  const maskText = (value) => logRedactor.apply(documentRedactor.apply(value));
  const maskDeep = (value) => redactDeep(redactDeep(value, documentRedactor), logRedactor);
  for (const result of results) {
    const directory = join(root, safeSegment(result.name));
    mkdirSync(directory, { recursive: true });
    const persisted = persistedLogs(result, logs, env);
    atomicWriteFile(join(directory, "stdout.log"), persisted.stdout, "utf8");
    atomicWriteFile(join(directory, "stderr.log"), persisted.stderr, "utf8");
    atomicWriteJson(join(directory, "metadata.json"), {
      name: result.name,
      definition: maskDeep(result.definition || null),
      command: maskText(result.command),
      status: result.status,
      detail: result.detail ? maskText(result.detail) : null,
      code: result.code,
      signal: result.signal,
      timedOut: result.timedOut,
      interrupted: result.interrupted || false,
      timeoutMs: result.timeoutMs,
      durationMs: result.durationMs,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      logCapture: persisted.capture,
      redactionApplied: persisted.redactionApplied,
      mutationDetected: result.mutationDetected || false,
      mutationProblems: maskDeep(result.mutationProblems || []),
      repositoryInspectionFailed: result.repositoryInspectionFailed || false,
      repositoryBefore: result.repositoryBefore || null,
      repositoryAfter: result.repositoryAfter || null,
      evidence: result.evidence || null,
      adapter: maskDeep(result.adapter || null),
    });
  }
}

export function redactLog(value, logs, env = process.env) {
  return createRedactor(logs, env).apply(value);
}

function persistedLogs(result, logs, env) {
  const redactor = createRedactor(logs, env);
  if (redactor.capture === "metadata-only") {
    return { stdout: "", stderr: "", capture: "metadata-only", redactionApplied: true };
  }
  return {
    stdout: redactor.apply(result.stdout),
    stderr: redactor.apply(result.stderr),
    capture: redactor.capture,
    redactionApplied: redactor.redactionApplied,
  };
}

function terminateTree(pid, signal) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      process.kill(-pid, signal);
    }
  } catch (error) {
    if (error?.code !== "ESRCH") return;
  }
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
