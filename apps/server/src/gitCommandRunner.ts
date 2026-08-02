import { spawn } from "node:child_process";

import { GitSafetyError } from "./gitErrors.js";

export interface GitCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitCommandOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
}

type GitOperationLogger = (operation: string) => void;

const maximumOutputBytes = 10 * 1024 * 1024;
const defaultTimeoutMs = 120_000;

export class GitCommandRunner {
  private readonly logger: GitOperationLogger;

  constructor(logger: GitOperationLogger = () => undefined) {
    this.logger = logger;
  }

  async run(
    args: readonly string[],
    options: GitCommandOptions,
  ): Promise<GitCommandResult> {
    if (args.length === 0) {
      throw new GitSafetyError(
        "GIT_COMMAND_FAILED",
        "A Git operation name is required.",
        500,
      );
    }

    this.logger(`git ${args[0]}`);

    return new Promise<GitCommandResult>((resolve, reject) => {
      const child = spawn("git", [...args], {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
        },
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;

      const finishWithError = (error: GitSafetyError): void => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill();
        reject(error);
      };

      const timer = setTimeout(() => {
        finishWithError(
          new GitSafetyError(
            "GIT_COMMAND_FAILED",
            `Git operation ${args[0]} timed out.`,
            500,
          ),
        );
      }, options.timeoutMs ?? defaultTimeoutMs);

      const collect = (target: Buffer[], chunk: Buffer): void => {
        outputBytes += chunk.length;
        if (outputBytes > maximumOutputBytes) {
          finishWithError(
            new GitSafetyError(
              "GIT_COMMAND_FAILED",
              `Git operation ${args[0]} exceeded the output limit.`,
              500,
            ),
          );
          return;
        }
        target.push(chunk);
      };

      child.stdout.on("data", (chunk: Buffer) => collect(stdoutChunks, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderrChunks, chunk));

      child.on("error", (error: Error) => {
        clearTimeout(timer);
        finishWithError(
          new GitSafetyError(
            "GIT_COMMAND_FAILED",
            `Could not start Git operation ${args[0]}: ${error.message}`,
            500,
          ),
        );
      });

      child.on("close", (exitCode) => {
        clearTimeout(timer);
        if (settled) {
          return;
        }
        settled = true;
        resolve({
          exitCode: exitCode ?? -1,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
        });
      });
    });
  }

  async runChecked(
    args: readonly string[],
    options: GitCommandOptions,
  ): Promise<GitCommandResult> {
    const result = await this.run(args, options);
    if (result.exitCode !== 0) {
      throw new GitSafetyError(
        "GIT_COMMAND_FAILED",
        `Git operation ${args[0] ?? "unknown"} failed.`,
        500,
        {
          exitCode: result.exitCode,
          stderr: result.stderr.trim(),
        },
      );
    }
    return result;
  }
}
