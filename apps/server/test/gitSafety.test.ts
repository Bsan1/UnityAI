import assert from "node:assert/strict";
import { once } from "node:events";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { afterEach, test } from "node:test";

import type { GitTaskEnvironment } from "@unityai/core";

import { createUnityAiServer } from "../src/app.js";
import { ServerError } from "../src/errors.js";
import { GitEnvironmentStore } from "../src/gitEnvironmentStore.js";
import { GitSafetyError } from "../src/gitErrors.js";
import { GitSafetyService } from "../src/gitSafetyService.js";
import {
  createGitTestContext,
  createTemporaryRoot,
  initializeRepository,
  removeTemporaryRoot,
} from "./gitTestHelpers.js";

const temporaryRoots = new Set<string>();

const trackRoot = (root: string): string => {
  temporaryRoots.add(root);
  return root;
};

const expectGitError = (code: string) => (error: unknown): boolean =>
  error instanceof GitSafetyError && error.code === code;

const pathIsMissing = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
};

afterEach(async () => {
  const roots = [...temporaryRoots];
  temporaryRoots.clear();
  await Promise.all(roots.map((root) => removeTemporaryRoot(root)));
});

test("repository inspection detects clean, non-Git, no-commit, and detached states", async () => {
  const context = await createGitTestContext();
  trackRoot(context.root);

  const inspection = await context.gitService.inspect(context.task.id);
  assert.equal(inspection.repositoryRoot, context.repositoryRoot);
  assert.equal(inspection.currentBranch, "main");
  assert.equal(inspection.headCommit, context.baseCommit);
  assert.equal(inspection.status.isClean, true);

  const nonGitDirectory = join(context.root, "not-git");
  await mkdir(nonGitDirectory);
  const nonGitTask = await context.taskService.create({
    originalRequest: "Target a non-Git directory",
    targetProjectPath: nonGitDirectory,
    strength: "LIGHT",
  });
  await assert.rejects(
    () => context.gitService.inspect(nonGitTask.id),
    expectGitError("NOT_A_GIT_REPOSITORY"),
  );

  const noCommitRoot = trackRoot(await createTemporaryRoot());
  const noCommitRepository = await initializeRepository(noCommitRoot, false);
  const noCommitTask = await context.taskService.create({
    originalRequest: "Target a repository without commits",
    targetProjectPath: noCommitRepository.repositoryRoot,
    strength: "LIGHT",
  });
  await assert.rejects(
    () => context.gitService.inspect(noCommitTask.id),
    expectGitError("NO_COMMITS"),
  );

  await context.runner.runChecked(["checkout", "--detach", context.baseCommit], {
    cwd: context.repositoryRoot,
  });
  await assert.rejects(
    () => context.gitService.inspect(context.task.id),
    expectGitError("UNSUPPORTED_HEAD_STATE"),
  );
});

test("tracked, staged, and untracked user changes each block prepare without mutation", async (t) => {
  for (const dirtyKind of ["tracked", "staged", "untracked"] as const) {
    await t.test(dirtyKind, async () => {
      const context = await createGitTestContext();
      trackRoot(context.root);
      const readmePath = join(context.repositoryRoot, "README.md");
      const untrackedPath = join(context.repositoryRoot, "user-note.txt");

      if (dirtyKind === "untracked") {
        await writeFile(untrackedPath, "user data\n", "utf8");
      } else {
        await writeFile(readmePath, `user ${dirtyKind} change\n`, "utf8");
        if (dirtyKind === "staged") {
          await context.runner.runChecked(["add", "README.md"], {
            cwd: context.repositoryRoot,
          });
        }
      }

      const beforeStatus = (
        await context.runner.runChecked(
          ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
          { cwd: context.repositoryRoot },
        )
      ).stdout;
      const beforeContents = await readFile(
        dirtyKind === "untracked" ? untrackedPath : readmePath,
        "utf8",
      );

      await assert.rejects(
        () => context.gitService.prepare(context.task.id),
        expectGitError("TARGET_WORKTREE_DIRTY"),
      );

      const afterStatus = (
        await context.runner.runChecked(
          ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
          { cwd: context.repositoryRoot },
        )
      ).stdout;
      const afterContents = await readFile(
        dirtyKind === "untracked" ? untrackedPath : readmePath,
        "utf8",
      );
      assert.equal(afterStatus, beforeStatus);
      assert.equal(afterContents, beforeContents);
      assert.equal(
        (
          await context.runner.run(
            ["show-ref", "--verify", "--quiet", `refs/heads/ai/${context.task.id}`],
            { cwd: context.repositoryRoot },
          )
        ).exitCode,
        1,
      );
      assert.equal(
        await pathIsMissing(join(context.worktreesRoot, context.task.id)),
        true,
      );
    });
  }
});

test("prepare records base identity, creates an isolated branch/worktree, and is idempotent", async () => {
  const context = await createGitTestContext();
  trackRoot(context.root);
  const originalHeadBefore = (
    await context.runner.runChecked(["rev-parse", "HEAD"], {
      cwd: context.repositoryRoot,
    })
  ).stdout.trim();

  const environment = await context.gitService.prepare(context.task.id);
  assert.equal(environment.baseBranch, "main");
  assert.equal(environment.baseCommit, context.baseCommit);
  assert.equal(environment.taskBranch, `ai/${context.task.id}`);
  assert.equal(environment.writeOwnerTaskId, context.task.id);
  assert.equal(environment.status, "ACTIVE");
  assert.equal(await pathIsMissing(environment.taskWorktreePath), false);
  assert.equal(
    (
      await context.runner.runChecked(["symbolic-ref", "--short", "HEAD"], {
        cwd: environment.taskWorktreePath,
      })
    ).stdout.trim(),
    environment.taskBranch,
  );
  assert.equal(
    (
      await context.runner.runChecked(["rev-parse", "HEAD"], {
        cwd: context.repositoryRoot,
      })
    ).stdout.trim(),
    originalHeadBefore,
  );
  assert.equal(
    (
      await context.runner.runChecked(["status", "--porcelain"], {
        cwd: context.repositoryRoot,
      })
    ).stdout,
    "",
  );

  const secondPrepare = await context.gitService.prepare(context.task.id);
  assert.deepEqual(secondPrepare, environment);

  const restartedStore = new GitEnvironmentStore(context.runtimeRoot);
  await restartedStore.initialize();
  assert.deepEqual(await restartedStore.get(context.task.id), environment);
});

test("prepare refuses unrelated existing task branches and managed paths", async () => {
  const branchContext = await createGitTestContext();
  trackRoot(branchContext.root);
  await branchContext.runner.runChecked(
    ["branch", `ai/${branchContext.task.id}`, branchContext.baseCommit],
    { cwd: branchContext.repositoryRoot },
  );
  await assert.rejects(
    () => branchContext.gitService.prepare(branchContext.task.id),
    expectGitError("TASK_BRANCH_EXISTS"),
  );

  const pathContext = await createGitTestContext();
  trackRoot(pathContext.root);
  await mkdir(join(pathContext.worktreesRoot, pathContext.task.id), {
    recursive: true,
  });
  await assert.rejects(
    () => pathContext.gitService.prepare(pathContext.task.id),
    expectGitError("TASK_WORKTREE_EXISTS"),
  );
});

test("different tasks receive different branches and writable worktrees", async () => {
  const context = await createGitTestContext();
  trackRoot(context.root);
  const secondTask = await context.taskService.create({
    originalRequest: "Second isolated task",
    targetProjectPath: context.repositoryRoot,
    strength: "LIGHT",
  });

  const firstEnvironment = await context.gitService.prepare(context.task.id);
  const secondEnvironment = await context.gitService.prepare(secondTask.id);
  assert.notEqual(
    firstEnvironment.taskWorktreePath,
    secondEnvironment.taskWorktreePath,
  );
  assert.notEqual(firstEnvironment.taskBranch, secondEnvironment.taskBranch);
  assert.equal(firstEnvironment.writeOwnerTaskId, context.task.id);
  assert.equal(secondEnvironment.writeOwnerTaskId, secondTask.id);
});

test("task worktree status and diff report tracked and untracked changes", async () => {
  const context = await createGitTestContext();
  trackRoot(context.root);
  const environment = await context.gitService.prepare(context.task.id);
  await writeFile(
    join(environment.taskWorktreePath, "README.md"),
    "task modification\n",
    "utf8",
  );
  await writeFile(
    join(environment.taskWorktreePath, "new-file.txt"),
    "new task file\n",
    "utf8",
  );

  const status = await context.gitService.status(context.task.id);
  assert.equal(status.isClean, false);
  assert.deepEqual(status.unstagedFiles, ["README.md"]);
  assert.deepEqual(status.untrackedFiles, ["new-file.txt"]);

  const diff = await context.gitService.diff(context.task.id);
  assert.deepEqual(diff.changedFiles, ["new-file.txt", "README.md"]);
  assert.deepEqual(diff.untrackedFiles, ["new-file.txt"]);
  assert.match(diff.diff, /task modification/);
  assert.equal(
    await readFile(join(context.repositoryRoot, "README.md"), "utf8"),
    "initial\n",
  );
});

test("checkpoints create local commits, support multiples, and reject empty worktrees", async () => {
  const context = await createGitTestContext();
  trackRoot(context.root);
  const environment = await context.gitService.prepare(context.task.id);

  await assert.rejects(
    () => context.gitService.checkpoint(context.task.id, { label: "empty" }),
    expectGitError("NOTHING_TO_CHECKPOINT"),
  );

  await writeFile(
    join(environment.taskWorktreePath, "README.md"),
    "checkpoint one\n",
    "utf8",
  );
  const first = await context.gitService.checkpoint(context.task.id, {
    label: "implementation-1",
  });
  await writeFile(
    join(environment.taskWorktreePath, "README.md"),
    "checkpoint two\n",
    "utf8",
  );
  const second = await context.gitService.checkpoint(context.task.id, {
    label: "implementation-2",
  });

  assert.equal(first.checkpoint.id, "CHECKPOINT-0001");
  assert.equal(second.checkpoint.id, "CHECKPOINT-0002");
  assert.equal(second.environment.checkpoints.length, 2);
  assert.equal(
    (
      await context.runner.runChecked(
        ["rev-list", "--count", `${context.baseCommit}..HEAD`],
        { cwd: environment.taskWorktreePath },
      )
    ).stdout.trim(),
    "2",
  );
  assert.match(
    (
      await context.runner.runChecked(["log", "-1", "--format=%s"], {
        cwd: environment.taskWorktreePath,
      })
    ).stdout,
    /checkpoint\(TASK-0001\): implementation-2/,
  );
});

test("rollback restores checkpoints/base and removes managed untracked files", async () => {
  const context = await createGitTestContext();
  trackRoot(context.root);
  const environment = await context.gitService.prepare(context.task.id);
  const readme = join(environment.taskWorktreePath, "README.md");

  await writeFile(readme, "checkpoint one\n", "utf8");
  const first = await context.gitService.checkpoint(context.task.id, {
    label: "one",
  });
  await writeFile(readme, "checkpoint two\n", "utf8");
  await context.gitService.checkpoint(context.task.id, { label: "two" });
  const untracked = join(environment.taskWorktreePath, "temporary.txt");
  await writeFile(untracked, "temporary\n", "utf8");

  const checkpointRollback = await context.gitService.rollback(
    context.task.id,
    { target: first.checkpoint.id },
  );
  assert.equal(checkpointRollback.targetCommit, first.checkpoint.commit);
  assert.equal(
    (await readFile(readme, "utf8")).replace(/\r\n/g, "\n"),
    "checkpoint one\n",
  );
  assert.equal(await pathIsMissing(untracked), true);

  const baseRollback = await context.gitService.rollback(context.task.id, {
    target: "BASE",
  });
  assert.equal(baseRollback.targetCommit, context.baseCommit);
  assert.equal(
    (await readFile(readme, "utf8")).replace(/\r\n/g, "\n"),
    "initial\n",
  );
  assert.equal(baseRollback.status.isClean, true);
});

test("rollback rejects tampered metadata before it can target the original worktree", async () => {
  const context = await createGitTestContext();
  trackRoot(context.root);
  const environment = await context.gitService.prepare(context.task.id);
  const originalReadme = join(context.repositoryRoot, "README.md");
  const originalUntracked = join(context.repositoryRoot, "user-work.txt");
  await writeFile(originalReadme, "precious user modification\n", "utf8");
  await writeFile(originalUntracked, "precious untracked work\n", "utf8");

  const tampered: GitTaskEnvironment = {
    ...environment,
    taskWorktreePath: `${context.repositoryRoot}${sep}.`,
  };
  await context.environmentStore.save(tampered);
  const restartedGitService = new GitSafetyService(
    context.taskService,
    context.environmentStore,
    context.worktreesRoot,
    context.runner,
  );

  await assert.rejects(
    () => restartedGitService.rollback(context.task.id, { target: "BASE" }),
    expectGitError("NOT_MANAGED_WORKTREE"),
  );
  assert.equal(
    await readFile(originalReadme, "utf8"),
    "precious user modification\n",
  );
  assert.equal(
    await readFile(originalUntracked, "utf8"),
    "precious untracked work\n",
  );
  assert.equal(await pathIsMissing(environment.taskWorktreePath), false);
});

test("nothing-to-finalize is clear and leaves the original branch untouched", async () => {
  const context = await createGitTestContext();
  trackRoot(context.root);
  const environment = await context.gitService.prepare(context.task.id);
  await assert.rejects(
    () =>
      context.gitService.finalize(context.task.id, {
        commitMessage: "Synthetic final task",
      }),
    expectGitError("NOTHING_TO_FINALIZE"),
  );
  assert.equal(
    (
      await context.runner.runChecked(["rev-parse", "HEAD"], {
        cwd: environment.taskWorktreePath,
      })
    ).stdout.trim(),
    context.baseCommit,
  );
  assert.equal(
    (
      await context.runner.runChecked(["rev-parse", "main"], {
        cwd: context.repositoryRoot,
      })
    ).stdout.trim(),
    context.baseCommit,
  );
});

test("cleanup protects active changes and keeps finalized branches", async (t) => {
  await t.test("active worktree requires explicit discard", async () => {
    const context = await createGitTestContext();
    trackRoot(context.root);
    const environment = await context.gitService.prepare(context.task.id);
    await writeFile(
      join(environment.taskWorktreePath, "active.txt"),
      "active change\n",
      "utf8",
    );
    await assert.rejects(
      () => context.gitService.cleanup(context.task.id, {}),
      expectGitError("WORKTREE_HAS_CHANGES"),
    );
    assert.equal(await pathIsMissing(environment.taskWorktreePath), false);

    const cleaned = await context.gitService.cleanup(context.task.id, {
      discardChanges: true,
    });
    assert.equal(cleaned.status, "CLEANED");
    assert.equal(await pathIsMissing(environment.taskWorktreePath), true);
    assert.equal(
      (
        await context.runner.run(
          ["show-ref", "--verify", "--quiet", `refs/heads/${environment.taskBranch}`],
          { cwd: context.repositoryRoot },
        )
      ).exitCode,
      0,
    );
  });

  await t.test("finalized worktree cleanup retains final branch", async () => {
    const context = await createGitTestContext();
    trackRoot(context.root);
    const environment = await context.gitService.prepare(context.task.id);
    await writeFile(
      join(environment.taskWorktreePath, "final.txt"),
      "final change\n",
      "utf8",
    );
    const finalized = await context.gitService.finalize(context.task.id, {
      commitMessage: "Final task change",
    });
    const cleaned = await context.gitService.cleanup(context.task.id, {});
    assert.equal(cleaned.status, "CLEANED");
    assert.equal(await pathIsMissing(environment.taskWorktreePath), true);
    assert.equal(
      (
        await context.runner.runChecked(
          ["rev-parse", `refs/heads/${environment.taskBranch}`],
          { cwd: context.repositoryRoot },
        )
      ).stdout.trim(),
      finalized.finalCommit,
    );
  });
});

test("invalid persisted Git metadata fails clearly", async () => {
  const context = await createGitTestContext();
  trackRoot(context.root);
  await context.gitService.prepare(context.task.id);
  await writeFile(
    join(context.runtimeRoot, "tasks", context.task.id, "git.json"),
    "{invalid-json",
    "utf8",
  );
  const restartedStore = new GitEnvironmentStore(context.runtimeRoot);
  await restartedStore.initialize();
  await assert.rejects(
    () => restartedStore.get(context.task.id),
    (error: unknown) =>
      error instanceof ServerError && error.code === "PERSISTENCE_ERROR",
  );
});

test("synthetic M2 flow squashes checkpoints and never changes or pushes the original branch", async () => {
  const context = await createGitTestContext();
  trackRoot(context.root);
  const bareRemote = join(context.root, "remote.git");
  await mkdir(bareRemote);
  await context.runner.runChecked(["init", "--bare"], { cwd: bareRemote });
  await context.runner.runChecked(["remote", "add", "origin", bareRemote], {
    cwd: context.repositoryRoot,
  });

  const inspection = await context.gitService.inspect(context.task.id);
  assert.equal(inspection.status.isClean, true);
  const environment = await context.gitService.prepare(context.task.id);
  const originalBranchBefore = (
    await context.runner.runChecked(["rev-parse", "main"], {
      cwd: context.repositoryRoot,
    })
  ).stdout.trim();
  const readme = join(environment.taskWorktreePath, "README.md");

  await writeFile(readme, "checkpoint one\n", "utf8");
  const checkpointOne = await context.gitService.checkpoint(context.task.id, {
    label: "implementation-1",
  });
  await writeFile(readme, "checkpoint two\n", "utf8");
  await context.gitService.checkpoint(context.task.id, {
    label: "implementation-2",
  });
  assert.equal(
    (
      await context.runner.runChecked(
        ["rev-list", "--count", `${context.baseCommit}..HEAD`],
        { cwd: environment.taskWorktreePath },
      )
    ).stdout.trim(),
    "2",
  );

  await context.gitService.rollback(context.task.id, {
    target: checkpointOne.checkpoint.id,
  });
  assert.equal(
    (await readFile(readme, "utf8")).replace(/\r\n/g, "\n"),
    "checkpoint one\n",
  );
  await writeFile(readme, "final synthetic change\n", "utf8");
  await writeFile(
    join(environment.taskWorktreePath, "feature.txt"),
    "feature result\n",
    "utf8",
  );

  const finalized = await context.gitService.finalize(context.task.id, {
    commitMessage: "Complete synthetic task",
  });
  assert.equal(finalized.status, "FINALIZED");
  assert.equal(
    (
      await context.runner.runChecked(
        ["rev-list", "--count", `${context.baseCommit}..${environment.taskBranch}`],
        { cwd: context.repositoryRoot },
      )
    ).stdout.trim(),
    "1",
  );
  assert.equal(
    (
      await context.runner.runChecked(
        ["rev-parse", `${environment.taskBranch}^`],
        { cwd: context.repositoryRoot },
      )
    ).stdout.trim(),
    context.baseCommit,
  );
  assert.equal(
    (
      await context.runner.runChecked(["rev-parse", "main"], {
        cwd: context.repositoryRoot,
      })
    ).stdout.trim(),
    originalBranchBefore,
  );
  assert.equal(
    (
      await context.runner.runChecked(["symbolic-ref", "--short", "HEAD"], {
        cwd: context.repositoryRoot,
      })
    ).stdout.trim(),
    "main",
  );
  assert.equal(
    (
      await context.runner.runChecked(["status", "--porcelain"], {
        cwd: context.repositoryRoot,
      })
    ).stdout,
    "",
  );
  assert.equal(
    await readFile(join(context.repositoryRoot, "README.md"), "utf8"),
    "initial\n",
  );
  assert.equal(
    (
      await context.runner.run(["show-ref", "--heads", "--quiet"], {
        cwd: bareRemote,
      })
    ).exitCode,
    1,
  );

  const cleaned = await context.gitService.cleanup(context.task.id, {});
  assert.equal(cleaned.status, "CLEANED");
  assert.equal(await pathIsMissing(environment.taskWorktreePath), true);
  assert.equal(
    (
      await context.runner.runChecked(
        ["rev-parse", `refs/heads/${environment.taskBranch}`],
        { cwd: context.repositoryRoot },
      )
    ).stdout.trim(),
    finalized.finalCommit,
  );
});

test("M2 HTTP endpoints expose inspection, preparation, status, and cleanup", async () => {
  const context = await createGitTestContext();
  trackRoot(context.root);
  const server = createUnityAiServer(context.taskService, context.gitService);

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const healthResponse = await fetch(`${baseUrl}/health`);
    assert.equal(healthResponse.status, 200);

    const missingEnvironmentResponse = await fetch(
      `${baseUrl}/tasks/${context.task.id}/git`,
    );
    assert.equal(missingEnvironmentResponse.status, 404);
    const missingEnvironment = (await missingEnvironmentResponse.json()) as {
      error: { code: string };
    };
    assert.equal(
      missingEnvironment.error.code,
      "GIT_ENVIRONMENT_NOT_PREPARED",
    );

    const inspectResponse = await fetch(
      `${baseUrl}/tasks/${context.task.id}/git/inspect`,
      { method: "POST" },
    );
    assert.equal(inspectResponse.status, 200);
    const inspectBody = (await inspectResponse.json()) as {
      inspection: {
        currentBranch: string;
        status: { isClean: boolean };
      };
    };
    const { inspection } = inspectBody;
    assert.equal(inspection.currentBranch, "main");
    assert.equal(inspection.status.isClean, true);

    const prepareResponse = await fetch(
      `${baseUrl}/tasks/${context.task.id}/git/prepare`,
      { method: "POST" },
    );
    assert.equal(prepareResponse.status, 200);
    const prepareBody = (await prepareResponse.json()) as {
      environment: GitTaskEnvironment;
    };
    const { environment: prepared } = prepareBody;
    assert.equal(prepared.taskBranch, `ai/${context.task.id}`);

    const statusResponse = await fetch(
      `${baseUrl}/tasks/${context.task.id}/git/status`,
    );
    assert.equal(statusResponse.status, 200);
    const status = (await statusResponse.json()) as {
      status: { isClean: boolean };
    };
    assert.equal(status.status.isClean, true);

    const environmentResponse = await fetch(
      `${baseUrl}/tasks/${context.task.id}/git`,
    );
    assert.equal(environmentResponse.status, 200);

    const cleanupResponse = await fetch(
      `${baseUrl}/tasks/${context.task.id}/git/cleanup`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    assert.equal(cleanupResponse.status, 200);
    const cleanupBody = (await cleanupResponse.json()) as {
      environment: GitTaskEnvironment;
    };
    const { environment: cleaned } = cleanupBody;
    assert.equal(cleaned.status, "CLEANED");
    assert.equal(await pathIsMissing(prepared.taskWorktreePath), true);
  } finally {
    server.close();
    await once(server, "close");
  }
});
