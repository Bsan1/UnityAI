import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type ProcessResultStatus =
  | "EXITED"
  | "SPAWN_FAILED"
  | "TIMED_OUT"
  | "CANCELLED";

export interface ProcessExecutionRequest {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly input?: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly maximumCaptureBytes?: number;
}

export interface ProcessExecutionResult {
  readonly status: ProcessResultStatus;
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly spawnError?: string;
}

export interface ProcessRunner {
  run(request: ProcessExecutionRequest): Promise<ProcessExecutionResult>;
}

const defaultMaximumCaptureBytes = 10 * 1024 * 1024;

class BoundedCapture {
  private contents = Buffer.alloc(0);
  private readonly maximumBytes: number;
  truncated = false;

  constructor(maximumBytes: number) {
    this.maximumBytes = maximumBytes;
  }

  append(chunk: Buffer): void {
    const combined = Buffer.concat([this.contents, chunk]);
    if (combined.length > this.maximumBytes) {
      this.contents = combined.subarray(combined.length - this.maximumBytes);
      this.truncated = true;
      return;
    }
    this.contents = combined;
  }

  text(): string {
    return this.contents.toString("utf8");
  }
}

const buildEnvironment = (
  overrides: Readonly<Record<string, string | undefined>> | undefined,
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) {
      delete environment[key];
    } else {
      environment[key] = value;
    }
  }
  return environment;
};

const immediateResult = (
  status: "CANCELLED" | "SPAWN_FAILED",
  startedAt: string,
  startedMilliseconds: number,
  spawnError?: string,
): ProcessExecutionResult => {
  const finishedMilliseconds = Date.now();
  return {
    status,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    startedAt,
    finishedAt: new Date(finishedMilliseconds).toISOString(),
    durationMs: finishedMilliseconds - startedMilliseconds,
    ...(spawnError === undefined ? {} : { spawnError }),
  };
};

export class SafeProcessRunner implements ProcessRunner {
  async run(request: ProcessExecutionRequest): Promise<ProcessExecutionResult> {
    const startedMilliseconds = Date.now();
    const startedAt = new Date(startedMilliseconds).toISOString();
    if (request.signal?.aborted === true) {
      return immediateResult("CANCELLED", startedAt, startedMilliseconds);
    }

    const maximumCaptureBytes =
      request.maximumCaptureBytes ?? defaultMaximumCaptureBytes;
    const stdout = new BoundedCapture(maximumCaptureBytes);
    const stderr = new BoundedCapture(maximumCaptureBytes);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(request.executable, [...request.arguments], {
        cwd: request.workingDirectory,
        env: buildEnvironment(request.environment),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown spawn error";
      return immediateResult(
        "SPAWN_FAILED",
        startedAt,
        startedMilliseconds,
        message,
      );
    }

    return new Promise<ProcessExecutionResult>((resolve) => {
      let settled = false;
      let requestedStatus: "TIMED_OUT" | "CANCELLED" | undefined;

      const finish = (
        status: ProcessResultStatus,
        exitCode?: number,
        spawnError?: string,
      ): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        request.signal?.removeEventListener("abort", abort);
        const finishedMilliseconds = Date.now();
        resolve({
          status,
          ...(exitCode === undefined ? {} : { exitCode }),
          stdout: stdout.text(),
          stderr: stderr.text(),
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          startedAt,
          finishedAt: new Date(finishedMilliseconds).toISOString(),
          durationMs: finishedMilliseconds - startedMilliseconds,
          ...(spawnError === undefined ? {} : { spawnError }),
        });
      };

      const terminate = (status: "TIMED_OUT" | "CANCELLED"): void => {
        if (settled || requestedStatus !== undefined) {
          return;
        }
        requestedStatus = status;
        child.kill("SIGTERM");
        const forceTimer = setTimeout(() => {
          if (!settled) {
            child.kill("SIGKILL");
          }
        }, 1_000);
        forceTimer.unref();
      };

      const abort = (): void => terminate("CANCELLED");
      const timeout = setTimeout(
        () => terminate("TIMED_OUT"),
        request.timeoutMs,
      );
      timeout.unref();

      request.signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
      child.stdin.on("error", () => undefined);
      child.on("error", (error: Error) => {
        finish("SPAWN_FAILED", undefined, error.message);
      });
      child.on("close", (exitCode) => {
        finish(requestedStatus ?? "EXITED", exitCode ?? undefined);
      });

      child.stdin.end(request.input ?? "");
    });
  }
}
