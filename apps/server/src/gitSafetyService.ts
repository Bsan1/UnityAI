import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { parseGitTaskEnvironment } from "@unityai/core";
import type {
  GitCheckpoint,
  GitTaskEnvironment,
  Task,
  TaskId,
} from "@unityai/core";

import { ServerError } from "./errors.js";
import { GitCommandRunner } from "./gitCommandRunner.js";
import type { GitCommandResult } from "./gitCommandRunner.js";
import { GitEnvironmentStore } from "./gitEnvironmentStore.js";
import { GitSafetyError } from "./gitErrors.js";
import { parsePorcelainStatus } from "./gitStatus.js";
import type {
  GitDiffReport,
  GitRepositoryInspection,
  GitRollbackResult,
  GitStatusReport,
} from "./gitTypes.js";
import type { TaskService } from "./taskService.js";

type JsonRecord = Record<string, unknown>;

const pathKey = (path: string): string =>
  process.platform === "win32" ? path.toLowerCase() : path;

const pathsEqual = (left: string, right: string): boolean =>
  pathKey(resolve(left)) === pathKey(resolve(right));

const uniqueSorted = (values: readonly string[]): readonly string[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right));

const readObject = (value: unknown, name: string): JsonRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ServerError("VALIDATION_ERROR", `${name} must be an object.`, 400);
  }
  return value as JsonRecord;
};

const readRequiredString = (
  value: unknown,
  field: string,
  name: string,
): string => {
  const record = readObject(value, name);
  const candidate = record[field];
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw new ServerError(
      "VALIDATION_ERROR",
      `${name}.${field} must be a non-empty string.`,
      400,
    );
  }
  return candidate.trim();
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
};

export class GitSafetyService {
  private readonly taskService: TaskService;
  private readonly environmentStore: GitEnvironmentStore;
  private readonly worktreesRoot: string;
  private readonly runner: GitCommandRunner;

  constructor(
    taskService: TaskService,
    environmentStore: GitEnvironmentStore,
    worktreesRoot: string,
    runner = new GitCommandRunner(),
  ) {
    this.taskService = taskService;
    this.environmentStore = environmentStore;
    this.worktreesRoot = resolve(worktreesRoot);
    this.runner = runner;
  }

  async getEnvironment(id: string): Promise<GitTaskEnvironment | undefined> {
    const task = await this.taskService.get(id);
    return this.environmentStore.get(task.id);
  }

  async getEnvironmentWithStatus(id: string): Promise<{
    readonly environment: GitTaskEnvironment | undefined;
    readonly status: GitStatusReport | undefined;
  }> {
    const task = await this.taskService.get(id);
    const environment = await this.environmentStore.get(task.id);
    if (environment === undefined) {
      throw new GitSafetyError(
        "GIT_ENVIRONMENT_NOT_PREPARED",
        `Task ${task.id} does not have a prepared Git environment.`,
        404,
      );
    }
    if (environment.status === "CLEANED") {
      return { environment, status: undefined };
    }
    await this.verifyManagedEnvironment(task, environment);
    return {
      environment,
      status: await this.readStatus(environment.taskWorktreePath),
    };
  }

  async inspect(id: string): Promise<GitRepositoryInspection> {
    const task = await this.taskService.get(id);
    return this.inspectTaskTarget(task);
  }

  async prepare(id: string): Promise<GitTaskEnvironment> {
    const task = await this.taskService.get(id);
    const existing = await this.environmentStore.get(task.id);
    if (existing !== undefined) {
      if (existing.status === "CLEANED") {
        throw new GitSafetyError(
          "GIT_ENVIRONMENT_MISMATCH",
          `Git environment for ${task.id} was already cleaned and cannot be prepared again.`,
        );
      }
      await this.verifyManagedEnvironment(task, existing);
      return existing;
    }

    const inspection = await this.inspectTaskTarget(task);
    if (!inspection.status.isClean) {
      throw new GitSafetyError(
        "TARGET_WORKTREE_DIRTY",
        `Target worktree for ${task.id} is dirty. Commit or clean user changes manually before retrying.`,
        409,
        {
          stagedFiles: inspection.status.stagedFiles,
          unstagedFiles: inspection.status.unstagedFiles,
          untrackedFiles: inspection.status.untrackedFiles,
        },
      );
    }

    await mkdir(this.worktreesRoot, { recursive: true });
    const canonicalWorktreesRoot = await realpath(this.worktreesRoot);
    const intendedWorktreePath = resolve(canonicalWorktreesRoot, task.id);
    const taskBranch = `ai/${task.id}`;

    const branchCheck = await this.runner.run(
      ["show-ref", "--verify", "--quiet", `refs/heads/${taskBranch}`],
      { cwd: inspection.repositoryRoot },
    );
    if (branchCheck.exitCode === 0) {
      throw new GitSafetyError(
        "TASK_BRANCH_EXISTS",
        `Task branch ${taskBranch} already exists without matching UnityAI ownership metadata.`,
      );
    }
    if (branchCheck.exitCode !== 1) {
      this.throwCommandFailure("show-ref", branchCheck);
    }

    if (await pathExists(intendedWorktreePath)) {
      throw new GitSafetyError(
        "TASK_WORKTREE_EXISTS",
        `Managed task worktree path already exists: ${intendedWorktreePath}.`,
      );
    }

    await this.runner.runChecked(
      [
        "worktree",
        "add",
        "-b",
        taskBranch,
        intendedWorktreePath,
        inspection.headCommit,
      ],
      { cwd: inspection.repositoryRoot },
    );

    const taskWorktreePath = await realpath(intendedWorktreePath);
    const timestamp = new Date().toISOString();
    const environment = parseGitTaskEnvironment({
      schemaVersion: 1,
      taskId: task.id,
      repositoryRoot: inspection.repositoryRoot,
      originalWorktreePath: inspection.originalWorktreePath,
      gitCommonDirectory: inspection.gitCommonDirectory,
      baseBranch: inspection.currentBranch,
      baseCommit: inspection.headCommit,
      taskBranch,
      taskWorktreePath,
      writeOwnerTaskId: task.id,
      status: "ACTIVE",
      createdAt: timestamp,
      checkpoints: [],
    });

    await this.verifyManagedEnvironment(task, environment);
    const preparedHead = await this.readHead(taskWorktreePath);
    if (preparedHead !== environment.baseCommit) {
      throw new GitSafetyError(
        "GIT_ENVIRONMENT_MISMATCH",
        `Prepared worktree HEAD ${preparedHead} does not match base ${environment.baseCommit}.`,
      );
    }
    return this.environmentStore.save(environment);
  }

  async status(id: string): Promise<GitStatusReport> {
    const { task, environment } = await this.requireUsableEnvironment(id);
    await this.verifyManagedEnvironment(task, environment);
    return this.readStatus(environment.taskWorktreePath);
  }

  async diff(id: string): Promise<GitDiffReport> {
    const { task, environment } = await this.requireUsableEnvironment(id);
    await this.verifyManagedEnvironment(task, environment);
    const cwd = environment.taskWorktreePath;
    const [head, names, summary, diff, status] = await Promise.all([
      this.readHead(cwd),
      this.runner.runChecked(
        ["diff", "--name-only", "-z", environment.baseCommit, "--"],
        { cwd },
      ),
      this.runner.runChecked(
        ["diff", "--stat", "--no-ext-diff", environment.baseCommit, "--"],
        { cwd },
      ),
      this.runner.runChecked(
        ["diff", "--no-ext-diff", "--no-color", environment.baseCommit, "--"],
        { cwd },
      ),
      this.readStatus(cwd),
    ]);

    const changedFiles = uniqueSorted([
      ...names.stdout.split("\0").filter((path) => path.length > 0),
      ...status.untrackedFiles,
    ]);

    return {
      baseCommit: environment.baseCommit,
      headCommit: head,
      changedFiles,
      untrackedFiles: status.untrackedFiles,
      summary: summary.stdout.trim(),
      diff: diff.stdout,
    };
  }

  async checkpoint(id: string, value: unknown): Promise<{
    readonly environment: GitTaskEnvironment;
    readonly checkpoint: GitCheckpoint;
  }> {
    const label = readRequiredString(value, "label", "checkpoint body");
    if (label.length > 120 || /[\r\n]/.test(label)) {
      throw new ServerError(
        "VALIDATION_ERROR",
        "checkpoint body.label must be a single line of at most 120 characters.",
        400,
      );
    }

    const { task, environment } = await this.requireActiveEnvironment(id);
    await this.verifyManagedEnvironment(task, environment);
    const cwd = environment.taskWorktreePath;
    const status = await this.readStatus(cwd);
    if (status.isClean) {
      throw new GitSafetyError(
        "NOTHING_TO_CHECKPOINT",
        `Task ${task.id} has no worktree changes to checkpoint.`,
      );
    }

    await this.runner.runChecked(["add", "--all"], { cwd });
    const staged = await this.runner.run(
      ["diff", "--cached", "--quiet", "--exit-code"],
      { cwd },
    );
    if (staged.exitCode === 0) {
      throw new GitSafetyError(
        "NOTHING_TO_CHECKPOINT",
        `Task ${task.id} has no checkpointable changes.`,
      );
    }
    if (staged.exitCode !== 1) {
      this.throwCommandFailure("diff", staged);
    }

    await this.runner.runChecked(
      ["commit", "-m", `checkpoint(${task.id}): ${label}`],
      { cwd },
    );
    const timestamp = new Date().toISOString();
    const checkpoint: GitCheckpoint = {
      id: `CHECKPOINT-${String(environment.checkpoints.length + 1).padStart(4, "0")}`,
      label,
      commit: await this.readHead(cwd),
      createdAt: timestamp,
    };
    const updated = parseGitTaskEnvironment({
      ...environment,
      checkpoints: [...environment.checkpoints, checkpoint],
    });
    return {
      environment: await this.environmentStore.save(updated),
      checkpoint,
    };
  }

  async rollback(id: string, value: unknown): Promise<GitRollbackResult> {
    const { task, environment } = await this.requireActiveEnvironment(id);
    const target = readRequiredString(value, "target", "rollback body");
    await this.verifyManagedEnvironment(task, environment);

    let targetCommit: string;
    if (target === "BASE") {
      targetCommit = environment.baseCommit;
    } else {
      const checkpoint = environment.checkpoints.find(
        (candidate) => candidate.id === target,
      );
      if (checkpoint === undefined) {
        throw new GitSafetyError(
          "CHECKPOINT_NOT_FOUND",
          `Checkpoint ${target} is not registered for ${task.id}.`,
          404,
        );
      }
      targetCommit = checkpoint.commit;
      await this.verifyCheckpointCommit(environment, targetCommit);
    }

    await this.destructiveReset(environment, targetCommit);
    return {
      environment,
      targetCommit,
      status: await this.readStatus(environment.taskWorktreePath),
    };
  }

  async finalize(id: string, value: unknown): Promise<GitTaskEnvironment> {
    const commitMessage = readRequiredString(
      value,
      "commitMessage",
      "finalize body",
    );
    if (commitMessage.length > 200 || /[\r\n]/.test(commitMessage)) {
      throw new ServerError(
        "VALIDATION_ERROR",
        "finalize body.commitMessage must be a single line of at most 200 characters.",
        400,
      );
    }

    const { task, environment } = await this.requireActiveEnvironment(id);
    await this.verifyManagedEnvironment(task, environment);
    const cwd = environment.taskWorktreePath;

    await this.runner.runChecked(["add", "--all"], { cwd });
    await this.runner.runChecked(["reset", "--soft", environment.baseCommit], {
      cwd,
    });

    const staged = await this.runner.run(
      ["diff", "--cached", "--quiet", "--exit-code"],
      { cwd },
    );
    if (staged.exitCode === 0) {
      throw new GitSafetyError(
        "NOTHING_TO_FINALIZE",
        `Task ${task.id} has no net changes compared with its base commit.`,
      );
    }
    if (staged.exitCode !== 1) {
      this.throwCommandFailure("diff", staged);
    }

    await this.runner.runChecked(["commit", "-m", commitMessage], { cwd });
    const finalCommit = await this.readHead(cwd);
    const parent = (
      await this.runner.runChecked(["rev-parse", "HEAD^"], { cwd })
    ).stdout.trim();
    const commitCount = (
      await this.runner.runChecked(
        ["rev-list", "--count", `${environment.baseCommit}..HEAD`],
        { cwd },
      )
    ).stdout.trim();
    if (parent !== environment.baseCommit || commitCount !== "1") {
      throw new GitSafetyError(
        "GIT_ENVIRONMENT_MISMATCH",
        "Final task history is not exactly one commit on top of the recorded base.",
      );
    }

    const finalized = parseGitTaskEnvironment({
      ...environment,
      status: "FINALIZED",
      finalizedAt: new Date().toISOString(),
      finalCommit,
    });
    return this.environmentStore.save(finalized);
  }

  async cleanup(id: string, value: unknown): Promise<GitTaskEnvironment> {
    const task = await this.taskService.get(id);
    const environment = await this.requireEnvironment(task.id);
    if (environment.status === "CLEANED") {
      return environment;
    }
    const body = readObject(value, "cleanup body");
    const discardChanges = body.discardChanges ?? false;
    if (typeof discardChanges !== "boolean") {
      throw new ServerError(
        "VALIDATION_ERROR",
        "cleanup body.discardChanges must be a boolean.",
        400,
      );
    }

    await this.verifyManagedEnvironment(task, environment);
    const cwd = environment.taskWorktreePath;
    const status = await this.readStatus(cwd);
    const ignoredFiles = await this.readIgnoredFiles(cwd);
    const commitsAhead = Number(
      (
        await this.runner.runChecked(
          ["rev-list", "--count", `${environment.baseCommit}..HEAD`],
          { cwd },
        )
      ).stdout.trim(),
    );
    const hasDiscardableChanges =
      environment.status === "ACTIVE"
        ? !status.isClean || ignoredFiles.length > 0 || commitsAhead > 0
        : !status.isClean || ignoredFiles.length > 0;

    if (hasDiscardableChanges && !discardChanges) {
      throw new GitSafetyError(
        "WORKTREE_HAS_CHANGES",
        `Managed worktree for ${task.id} contains unfinalized or post-finalization changes. Explicit discardChanges is required.`,
        409,
        { ignoredFiles },
      );
    }

    if (discardChanges) {
      const resetTarget =
        environment.status === "FINALIZED"
          ? environment.finalCommit
          : environment.baseCommit;
      if (resetTarget === undefined) {
        throw new GitSafetyError(
          "GIT_ENVIRONMENT_MISMATCH",
          "Finalized environment is missing its final commit.",
        );
      }
      await this.destructiveReset(environment, resetTarget);
    }

    await this.verifyManagedEnvironment(task, environment);
    await this.runner.runChecked(
      ["worktree", "remove", environment.taskWorktreePath],
      { cwd: environment.repositoryRoot },
    );
    if (await pathExists(environment.taskWorktreePath)) {
      throw new GitSafetyError(
        "GIT_ENVIRONMENT_MISMATCH",
        "Git reported cleanup success but the managed worktree still exists.",
      );
    }

    const branchCheck = await this.runner.run(
      ["show-ref", "--verify", "--quiet", `refs/heads/${environment.taskBranch}`],
      { cwd: environment.repositoryRoot },
    );
    if (branchCheck.exitCode !== 0) {
      throw new GitSafetyError(
        "GIT_ENVIRONMENT_MISMATCH",
        `Task branch ${environment.taskBranch} did not remain after cleanup.`,
      );
    }

    const cleaned = parseGitTaskEnvironment({
      ...environment,
      status: "CLEANED",
      cleanedAt: new Date().toISOString(),
    });
    return this.environmentStore.save(cleaned);
  }

  private async inspectTaskTarget(task: Task): Promise<GitRepositoryInspection> {
    if (task.targetProjectPath === undefined) {
      throw new GitSafetyError(
        "INVALID_TARGET_PATH",
        `Task ${task.id} does not have a targetProjectPath.`,
        422,
      );
    }

    let targetStats;
    try {
      targetStats = await stat(task.targetProjectPath);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new GitSafetyError(
        "INVALID_TARGET_PATH",
        `Target project path is not accessible: ${message}`,
        422,
      );
    }
    if (!targetStats.isDirectory()) {
      throw new GitSafetyError(
        "INVALID_TARGET_PATH",
        "targetProjectPath must identify a directory.",
        422,
      );
    }

    const targetPath = await realpath(task.targetProjectPath);
    const rootResult = await this.runner.run(["rev-parse", "--show-toplevel"], {
      cwd: targetPath,
    });
    if (rootResult.exitCode !== 0) {
      throw new GitSafetyError(
        "NOT_A_GIT_REPOSITORY",
        `Target path for ${task.id} is not inside a Git worktree.`,
        422,
      );
    }
    const rootOutput = rootResult.stdout.trim();
    const repositoryRoot = await realpath(
      isAbsolute(rootOutput) ? rootOutput : resolve(targetPath, rootOutput),
    );

    const insideWorktree = await this.runner.run(
      ["rev-parse", "--is-inside-work-tree"],
      { cwd: repositoryRoot },
    );
    if (
      insideWorktree.exitCode !== 0 ||
      insideWorktree.stdout.trim() !== "true"
    ) {
      throw new GitSafetyError(
        "NOT_A_GIT_REPOSITORY",
        "Target repository is not a usable non-bare Git worktree.",
        422,
      );
    }

    const headResult = await this.runner.run(
      ["rev-parse", "--verify", "HEAD^{commit}"],
      { cwd: repositoryRoot },
    );
    if (headResult.exitCode !== 0) {
      throw new GitSafetyError(
        "NO_COMMITS",
        "Target repository does not have an initial commit.",
        422,
      );
    }

    const branchResult = await this.runner.run(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      { cwd: repositoryRoot },
    );
    if (branchResult.exitCode !== 0 || branchResult.stdout.trim().length === 0) {
      throw new GitSafetyError(
        "UNSUPPORTED_HEAD_STATE",
        "Target repository HEAD is detached or otherwise unsupported for M2 preparation.",
        422,
      );
    }

    const gitCommonDirectory = await this.readGitCommonDirectory(repositoryRoot);
    const status = await this.readStatus(repositoryRoot);
    return {
      targetPath,
      repositoryRoot,
      originalWorktreePath: repositoryRoot,
      gitCommonDirectory,
      currentBranch: branchResult.stdout.trim(),
      headCommit: headResult.stdout.trim(),
      status,
    };
  }

  private async readStatus(cwd: string): Promise<GitStatusReport> {
    const [porcelain, branch, head] = await Promise.all([
      this.runner.runChecked(
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        { cwd },
      ),
      this.runner.runChecked(["symbolic-ref", "--quiet", "--short", "HEAD"], {
        cwd,
      }),
      this.runner.runChecked(["rev-parse", "HEAD"], { cwd }),
    ]);
    return {
      branch: branch.stdout.trim(),
      headCommit: head.stdout.trim(),
      ...parsePorcelainStatus(porcelain.stdout),
    };
  }

  private async readHead(cwd: string): Promise<string> {
    return (
      await this.runner.runChecked(["rev-parse", "HEAD"], { cwd })
    ).stdout.trim();
  }

  private async readGitCommonDirectory(cwd: string): Promise<string> {
    const result = await this.runner.runChecked(
      ["rev-parse", "--git-common-dir"],
      { cwd },
    );
    const output = result.stdout.trim();
    return realpath(isAbsolute(output) ? output : resolve(cwd, output));
  }

  private async readIgnoredFiles(cwd: string): Promise<readonly string[]> {
    const result = await this.runner.runChecked(
      ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
      { cwd },
    );
    return uniqueSorted(
      result.stdout.split("\0").filter((path) => path.length > 0),
    );
  }

  private async requireEnvironment(taskId: TaskId): Promise<GitTaskEnvironment> {
    const environment = await this.environmentStore.get(taskId);
    if (environment === undefined) {
      throw new GitSafetyError(
        "GIT_ENVIRONMENT_NOT_PREPARED",
        `Task ${taskId} does not have a prepared Git environment.`,
        404,
      );
    }
    return environment;
  }

  private async requireUsableEnvironment(id: string): Promise<{
    readonly task: Task;
    readonly environment: GitTaskEnvironment;
  }> {
    const task = await this.taskService.get(id);
    const environment = await this.requireEnvironment(task.id);
    if (environment.status === "CLEANED") {
      throw new GitSafetyError(
        "GIT_ENVIRONMENT_NOT_PREPARED",
        `Managed worktree for ${task.id} has been cleaned up.`,
        404,
      );
    }
    return { task, environment };
  }

  private async requireActiveEnvironment(id: string): Promise<{
    readonly task: Task;
    readonly environment: GitTaskEnvironment;
  }> {
    const result = await this.requireUsableEnvironment(id);
    if (result.environment.status !== "ACTIVE") {
      throw new GitSafetyError(
        "GIT_ENVIRONMENT_MISMATCH",
        `Git environment for ${result.task.id} is not active.`,
      );
    }
    return result;
  }

  private async verifyManagedEnvironment(
    task: Task,
    environment: GitTaskEnvironment,
  ): Promise<void> {
    if (
      environment.taskId !== task.id ||
      environment.writeOwnerTaskId !== task.id
    ) {
      throw new GitSafetyError(
        "GIT_ENVIRONMENT_MISMATCH",
        "Git environment task identity or write ownership does not match.",
      );
    }
    if (environment.status === "CLEANED") {
      throw new GitSafetyError(
        "GIT_ENVIRONMENT_NOT_PREPARED",
        `Managed worktree for ${task.id} has already been cleaned.`,
        404,
      );
    }

    const canonicalWorktreesRoot = await realpath(this.worktreesRoot);
    const expectedWorktreePath = resolve(canonicalWorktreesRoot, task.id);
    if (!pathsEqual(environment.taskWorktreePath, expectedWorktreePath)) {
      throw new GitSafetyError(
        "NOT_MANAGED_WORKTREE",
        "Persisted worktree path is not the exact UnityAI-managed path for this task.",
      );
    }

    const canonicalWorktree = await realpath(environment.taskWorktreePath).catch(
      () => {
        throw new GitSafetyError(
          "NOT_MANAGED_WORKTREE",
          "Registered managed worktree path does not exist.",
        );
      },
    );
    const canonicalOriginal = await realpath(environment.originalWorktreePath);
    const canonicalRepositoryRoot = await realpath(environment.repositoryRoot);
    if (
      !pathsEqual(canonicalWorktree, expectedWorktreePath) ||
      pathsEqual(canonicalWorktree, canonicalOriginal) ||
      !pathsEqual(canonicalOriginal, canonicalRepositoryRoot)
    ) {
      throw new GitSafetyError(
        "NOT_MANAGED_WORKTREE",
        "Managed worktree canonical paths failed ownership validation.",
      );
    }

    if (task.targetProjectPath === undefined) {
      throw new GitSafetyError(
        "GIT_ENVIRONMENT_MISMATCH",
        "Task no longer has the target path recorded by its Git environment.",
      );
    }
    const canonicalTaskTarget = await realpath(task.targetProjectPath);
    const taskRootResult = await this.runner.runChecked(
      ["rev-parse", "--show-toplevel"],
      { cwd: canonicalTaskTarget },
    );
    const taskRootOutput = taskRootResult.stdout.trim();
    const taskRepositoryRoot = await realpath(
      isAbsolute(taskRootOutput)
        ? taskRootOutput
        : resolve(canonicalTaskTarget, taskRootOutput),
    );
    if (!pathsEqual(taskRepositoryRoot, canonicalRepositoryRoot)) {
      throw new GitSafetyError(
        "GIT_ENVIRONMENT_MISMATCH",
        "Task targetProjectPath no longer belongs to the recorded repository.",
      );
    }

    const originalCommonDirectory = await this.readGitCommonDirectory(
      canonicalOriginal,
    );
    const expectedCommonDirectory = await realpath(
      environment.gitCommonDirectory,
    );
    if (!pathsEqual(originalCommonDirectory, expectedCommonDirectory)) {
      throw new GitSafetyError(
        "GIT_ENVIRONMENT_MISMATCH",
        "Original worktree no longer belongs to the recorded Git repository.",
      );
    }

    const worktreeRootResult = await this.runner.runChecked(
      ["rev-parse", "--show-toplevel"],
      { cwd: canonicalWorktree },
    );
    const worktreeRootOutput = worktreeRootResult.stdout.trim();
    const worktreeRoot = await realpath(
      isAbsolute(worktreeRootOutput)
        ? worktreeRootOutput
        : resolve(canonicalWorktree, worktreeRootOutput),
    );
    if (!pathsEqual(worktreeRoot, canonicalWorktree)) {
      throw new GitSafetyError(
        "NOT_MANAGED_WORKTREE",
        "Registered path is not the root of the managed Git worktree.",
      );
    }

    const commonDirectory = await this.readGitCommonDirectory(canonicalWorktree);
    if (!pathsEqual(commonDirectory, expectedCommonDirectory)) {
      throw new GitSafetyError(
        "GIT_ENVIRONMENT_MISMATCH",
        "Managed worktree belongs to a different Git repository.",
      );
    }

    const branch = (
      await this.runner.runChecked(
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        { cwd: canonicalWorktree },
      )
    ).stdout.trim();
    if (branch !== environment.taskBranch) {
      throw new GitSafetyError(
        "GIT_ENVIRONMENT_MISMATCH",
        `Managed worktree is on ${branch}, expected ${environment.taskBranch}.`,
      );
    }

    const basedOnRecordedBase = await this.runner.run(
      ["merge-base", "--is-ancestor", environment.baseCommit, "HEAD"],
      { cwd: canonicalWorktree },
    );
    if (basedOnRecordedBase.exitCode !== 0) {
      throw new GitSafetyError(
        "GIT_ENVIRONMENT_MISMATCH",
        "Managed task-branch history is not based on its recorded base commit.",
      );
    }

    if (
      environment.status === "FINALIZED" &&
      (await this.readHead(canonicalWorktree)) !== environment.finalCommit
    ) {
      throw new GitSafetyError(
        "GIT_ENVIRONMENT_MISMATCH",
        "Finalized worktree HEAD does not match its recorded final commit.",
      );
    }
  }

  private async verifyCheckpointCommit(
    environment: GitTaskEnvironment,
    commit: string,
  ): Promise<void> {
    const cwd = environment.taskWorktreePath;
    const exists = await this.runner.run(["cat-file", "-e", `${commit}^{commit}`], {
      cwd,
    });
    const basedOnRecordedBase = await this.runner.run(
      ["merge-base", "--is-ancestor", environment.baseCommit, commit],
      { cwd },
    );
    if (exists.exitCode !== 0 || basedOnRecordedBase.exitCode !== 0) {
      throw new GitSafetyError(
        "GIT_ENVIRONMENT_MISMATCH",
        "Registered checkpoint commit is missing or not based on the task base.",
      );
    }
  }

  private async destructiveReset(
    environment: GitTaskEnvironment,
    targetCommit: string,
  ): Promise<void> {
    const task = await this.taskService.get(environment.taskId);
    await this.verifyManagedEnvironment(task, environment);
    const cwd = environment.taskWorktreePath;
    await this.runner.runChecked(["reset", "--hard", targetCommit], { cwd });
    await this.runner.runChecked(["clean", "-fdx"], { cwd });
    const head = await this.readHead(cwd);
    const status = await this.readStatus(cwd);
    const ignoredFiles = await this.readIgnoredFiles(cwd);
    if (head !== targetCommit || !status.isClean || ignoredFiles.length > 0) {
      throw new GitSafetyError(
        "GIT_ENVIRONMENT_MISMATCH",
        "Managed worktree rollback did not reach the requested clean state.",
      );
    }
  }

  private throwCommandFailure(
    operation: string,
    result: GitCommandResult,
  ): never {
    throw new GitSafetyError(
      "GIT_COMMAND_FAILED",
      `Git operation ${operation} failed.`,
      500,
      { exitCode: result.exitCode, stderr: result.stderr.trim() },
    );
  }
}
