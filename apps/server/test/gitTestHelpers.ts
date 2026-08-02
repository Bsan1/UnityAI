import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Task, TaskSettings } from "@unityai/core";

import { GitCommandRunner } from "../src/gitCommandRunner.js";
import { GitEnvironmentStore } from "../src/gitEnvironmentStore.js";
import { GitSafetyService } from "../src/gitSafetyService.js";
import { TaskService } from "../src/taskService.js";
import { TaskStore } from "../src/taskStore.js";

const settings: TaskSettings = {
  crossReviewEnabled: true,
  automaticFixesEnabled: true,
};

export interface GitTestContext {
  readonly root: string;
  readonly repositoryRoot: string;
  readonly runtimeRoot: string;
  readonly worktreesRoot: string;
  readonly runner: GitCommandRunner;
  readonly taskService: TaskService;
  readonly environmentStore: GitEnvironmentStore;
  readonly gitService: GitSafetyService;
  readonly task: Task;
  readonly baseCommit: string;
}

export const createTemporaryRoot = async (): Promise<string> =>
  mkdtemp(join(tmpdir(), "unityai-m2-test-"));

export const removeTemporaryRoot = async (root: string): Promise<void> => {
  await rm(root, { recursive: true, force: true });
};

export const initializeRepository = async (
  root: string,
  withCommit = true,
): Promise<{
  readonly repositoryRoot: string;
  readonly runner: GitCommandRunner;
  readonly baseCommit?: string;
}> => {
  const repositoryRoot = join(root, "project");
  await mkdir(repositoryRoot, { recursive: true });
  const runner = new GitCommandRunner();
  await runner.runChecked(["init"], { cwd: repositoryRoot });
  await runner.runChecked(["symbolic-ref", "HEAD", "refs/heads/main"], {
    cwd: repositoryRoot,
  });
  await runner.runChecked(["config", "user.name", "UnityAI Tests"], {
    cwd: repositoryRoot,
  });
  await runner.runChecked(["config", "user.email", "unityai-tests@local"], {
    cwd: repositoryRoot,
  });

  if (!withCommit) {
    return { repositoryRoot, runner };
  }

  await writeFile(join(repositoryRoot, "README.md"), "initial\n", "utf8");
  await runner.runChecked(["add", "README.md"], { cwd: repositoryRoot });
  await runner.runChecked(["commit", "-m", "Initial target commit"], {
    cwd: repositoryRoot,
  });
  const baseCommit = (
    await runner.runChecked(["rev-parse", "HEAD"], { cwd: repositoryRoot })
  ).stdout.trim();
  return { repositoryRoot, runner, baseCommit };
};

export const createGitTestContext = async (): Promise<GitTestContext> => {
  const root = await createTemporaryRoot();
  const initialized = await initializeRepository(root);
  if (initialized.baseCommit === undefined) {
    throw new Error("Expected initialized repository to have a commit.");
  }

  const runtimeRoot = join(root, "runtime");
  const worktreesRoot = join(runtimeRoot, "worktrees");
  const taskStore = new TaskStore(runtimeRoot);
  await taskStore.initialize();
  const taskService = new TaskService(taskStore, settings);
  const task = await taskService.create({
    title: "Synthetic Git task",
    originalRequest: "Modify the external test project",
    targetProjectPath: initialized.repositoryRoot,
    strength: "STANDARD",
  });
  const environmentStore = new GitEnvironmentStore(runtimeRoot);
  await environmentStore.initialize();
  const gitService = new GitSafetyService(
    taskService,
    environmentStore,
    worktreesRoot,
    initialized.runner,
  );

  return {
    root,
    repositoryRoot: initialized.repositoryRoot,
    runtimeRoot,
    worktreesRoot,
    runner: initialized.runner,
    taskService,
    environmentStore,
    gitService,
    task,
    baseCommit: initialized.baseCommit,
  };
};
