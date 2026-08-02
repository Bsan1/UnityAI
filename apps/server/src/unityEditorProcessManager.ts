import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { TaskId } from "@unityai/core";
import { UnityIntegrationError } from "@unityai/unity";

export interface UnityEditorExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface UnityEditorProcessHandle {
  readonly pid: number;
  readonly exit: Promise<UnityEditorExit>;
  terminate(): Promise<void>;
}

export interface UnityEditorLauncher {
  launch(input: {
    readonly executablePath: string;
    readonly args: readonly string[];
    readonly logPath: string;
  }): Promise<UnityEditorProcessHandle>;
}

export const buildUnityEditorArguments = (
  managedWorktreePath: string,
  logPath: string,
): readonly string[] => [
  "-projectPath",
  resolve(managedWorktreePath),
  "-logFile",
  resolve(logPath),
];

const waitForSpawn = (child: ChildProcess): Promise<number> =>
  new Promise((resolvePromise, rejectPromise) => {
    child.once("spawn", () => {
      if (child.pid === undefined) {
        rejectPromise(new Error("Unity process spawned without a PID."));
      } else {
        resolvePromise(child.pid);
      }
    });
    child.once("error", rejectPromise);
  });

export class NativeUnityEditorLauncher implements UnityEditorLauncher {
  async launch(input: {
    readonly executablePath: string;
    readonly args: readonly string[];
    readonly logPath: string;
  }): Promise<UnityEditorProcessHandle> {
    await mkdir(dirname(input.logPath), { recursive: true });
    const child = spawn(input.executablePath, [...input.args], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    let pid: number;
    try {
      pid = await waitForSpawn(child);
    } catch (error: unknown) {
      throw new UnityIntegrationError(
        "UNITY_EDITOR_START_FAILED",
        `Could not launch Unity Editor: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    const exit = new Promise<UnityEditorExit>((resolvePromise) => {
      child.once("exit", (exitCode, signal) => resolvePromise({ exitCode, signal }));
    });
    return {
      pid,
      exit,
      terminate: async () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          return;
        }
        child.kill();
        await Promise.race([
          exit.then(() => undefined),
          new Promise<void>((_, rejectPromise) => {
            setTimeout(
              () => rejectPromise(new Error("Unity Editor did not exit within 15 seconds.")),
              15_000,
            );
          }),
        ]);
      },
    };
  }
}

interface OwnedEditor {
  readonly taskId: TaskId;
  readonly projectPath: string;
  readonly handle: UnityEditorProcessHandle;
}

export class UnityEditorProcessManager {
  private readonly launcher: UnityEditorLauncher;
  private readonly owned = new Map<TaskId, OwnedEditor>();

  constructor(launcher: UnityEditorLauncher = new NativeUnityEditorLauncher()) {
    this.launcher = launcher;
  }

  async start(input: {
    readonly taskId: TaskId;
    readonly executablePath: string;
    readonly projectPath: string;
    readonly logPath: string;
  }): Promise<UnityEditorProcessHandle> {
    if (this.owned.has(input.taskId)) {
      throw new UnityIntegrationError(
        "UNITY_EDITOR_START_FAILED",
        `UnityAI already owns an Editor process for ${input.taskId}.`,
      );
    }
    const projectPath = resolve(input.projectPath);
    const handle = await this.launcher.launch({
      executablePath: input.executablePath,
      args: buildUnityEditorArguments(projectPath, input.logPath),
      logPath: input.logPath,
    });
    this.owned.set(input.taskId, { taskId: input.taskId, projectPath, handle });
    void handle.exit.finally(() => {
      const current = this.owned.get(input.taskId);
      if (current?.handle === handle) {
        this.owned.delete(input.taskId);
      }
    });
    return handle;
  }

  isOwned(taskId: TaskId, processId?: number): boolean {
    const entry = this.owned.get(taskId);
    return entry !== undefined &&
      (processId === undefined || entry.handle.pid === processId);
  }

  projectPath(taskId: TaskId): string | undefined {
    return this.owned.get(taskId)?.projectPath;
  }

  exit(taskId: TaskId): Promise<UnityEditorExit> | undefined {
    return this.owned.get(taskId)?.handle.exit;
  }

  async stop(taskId: TaskId, expectedProcessId: number): Promise<void> {
    const entry = this.owned.get(taskId);
    if (
      entry === undefined ||
      entry.handle.pid !== expectedProcessId
    ) {
      throw new UnityIntegrationError(
        "EDITOR_NOT_OWNED",
        `Unity Editor process ${expectedProcessId} is not owned by this UnityAI server session.`,
      );
    }
    try {
      await entry.handle.terminate();
    } catch (error: unknown) {
      throw new UnityIntegrationError(
        "UNITY_COMMAND_FAILED",
        `Could not stop the owned Unity Editor: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    } finally {
      this.owned.delete(taskId);
    }
  }
}
