import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";

import {
  createTask,
  parseTask,
  recordFeasibilityResult,
  transitionTask,
} from "@unityai/core";
import type { TaskDetailsResponse } from "@unityai/shared";
import { renderToStaticMarkup } from "react-dom/server";

import {
  BlockedView,
  ProjectUnityStatus,
  ReadyForQa,
  UnityTooling,
} from "../src/App.js";
import { ApiError, userMessageForError } from "../src/api.js";

const settings = {
  crossReviewEnabled: true,
  automaticFixesEnabled: true,
};

test("blocked task UI renders all four simple actions without raw JSON", () => {
  const created = createTask(
    "TASK-8001",
    {
      originalRequest: "Add a placeable Archer Tower.",
      targetProjectPath: "C:/project",
    },
    settings,
  );
  const blocked = recordFeasibilityResult(
    transitionTask(created, "ANALYZING"),
    {
      status: "BLOCKED_ARCHITECTURE",
      summary: "Building Placement System is missing.",
      missingCapabilities: ["Reusable Building Placement System"],
      suggestedPrerequisite: "Create a reusable Building Placement System.",
    },
  );
  const details: TaskDetailsResponse = {
    task: blocked,
    git: {},
    orchestration: {},
    progress: {
      taskId: blocked.id,
      state: blocked.state,
      active: false,
      steps: [],
      events: blocked.events,
      reviewFindingCount: 0,
    },
    blockedActions: [
      "CREATE_PREREQUISITE_TASK",
      "PAUSE",
      "RECHECK",
      "CANCEL",
    ],
  };
  const markup = renderToStaticMarkup(
    <BlockedView
      details={details}
      busy={false}
      onPrerequisite={() => undefined}
      onPause={() => undefined}
      onRecheck={() => undefined}
      onCancel={() => undefined}
    />,
  );
  assert.match(markup, /Create prerequisite task/u);
  assert.match(markup, />Pause</u);
  assert.match(markup, />Recheck</u);
  assert.match(markup, />Cancel</u);
  assert.doesNotMatch(markup, /\{&quot;status&quot;/u);
});

test("READY_FOR_QA UI states that QA has not passed and surfaces review findings", () => {
  const timestamp = new Date().toISOString();
  const task = parseTask({
    id: "TASK-8002",
    title: "Feature status",
    originalRequest: "Add feature-status.txt.",
    targetProjectPath: "C:/project",
    strength: "LIGHT",
    state: "READY_FOR_QA",
    createdAt: timestamp,
    updatedAt: timestamp,
    crossReviewEnabled: true,
    automaticFixesEnabled: true,
    taskContract: {
      understoodExplicitRequirements: ["Add the file."],
      inferredRequirements: [],
      prerequisites: [],
      implementationScope: ["Create feature-status.txt."],
      nonGoals: [],
      acceptanceCriteria: ["File contains ready."],
      testRequirements: ["STATIC: Inspect the file."],
      approved: true,
      approvedAt: timestamp,
    },
    prerequisiteDraftIds: [],
    events: [{ timestamp, type: "TASK_CREATED" }],
  });
  const details: TaskDetailsResponse = {
    task,
    git: {
      environment: {
        schemaVersion: 1,
        taskId: task.id,
        repositoryRoot: "C:/project",
        originalWorktreePath: "C:/project",
        gitCommonDirectory: "C:/project/.git",
        baseBranch: "main",
        baseCommit: "base",
        taskBranch: "ai/TASK-8002",
        taskWorktreePath: "C:/runtime/TASK-8002",
        writeOwnerTaskId: task.id,
        status: "ACTIVE",
        createdAt: timestamp,
        checkpoints: [],
      },
    },
    orchestration: {
      implementation: {
        schemaVersion: 1,
        runId: "RUN-1",
        providerId: "codex",
        modelId: "codex-terra",
        effort: "high",
        status: "SUCCEEDED",
        summary: "Added the file.",
        changedFiles: ["feature-status.txt"],
        implementationNotes: ["Kept scope minimal."],
        sanityChecks: ["Inspected the file."],
        warnings: [],
        startedAt: timestamp,
        finishedAt: timestamp,
        checkpointId: "CHECKPOINT-0001",
        checkpointCommit: "checkpoint",
      },
      review: {
        schemaVersion: 1,
        runId: "RUN-2",
        providerId: "claude",
        modelId: "claude-sonnet",
        effort: "medium",
        status: "FINDINGS",
        summary: "One future QA focus.",
        findings: [
          {
            id: "REVIEW-001",
            severity: "warning",
            title: "Verify runtime use",
            description: "The review is static.",
            evidence: "No runtime evidence exists yet.",
            relatedFiles: ["feature-status.txt"],
          },
        ],
        qaFocus: ["Verify runtime use."],
        startedAt: timestamp,
        finishedAt: timestamp,
      },
    },
    progress: {
      taskId: task.id,
      state: task.state,
      active: false,
      steps: [],
      events: task.events,
      reviewFindingCount: 1,
    },
    blockedActions: [],
  };
  const markup = renderToStaticMarkup(<ReadyForQa details={details} />);
  assert.match(markup, /does not mean this task passed QA/u);
  assert.match(markup, /REVIEW-001/u);
  assert.match(markup, /not been finalized, merged, or pushed/u);
});

test("dirty-worktree errors are translated into actionable UI copy", () => {
  const message = userMessageForError(
    new ApiError("TARGET_WORKTREE_DIRTY", "dirty"),
  );
  assert.match(message, /will not modify or stash/u);
  assert.match(message, /Commit or clean/u);
});

test("M6 project and task tooling UI renders Unity status without claiming QA", () => {
  const projectMarkup = renderToStaticMarkup(
    <ProjectUnityStatus
      error={undefined}
      inspection={{
        projectId: "PROJECT-0001",
        metadata: {
          schemaVersion: 1,
          isUnityProject: true,
          projectRoot: "C:/project",
          unityVersion: "6000.3.11f1",
          projectVersionFile: "C:/project/ProjectSettings/ProjectVersion.txt",
          manifestFile: "C:/project/Packages/manifest.json",
          packageLockPresent: true,
          packages: [{ name: "com.unity.inputsystem", version: "1.11.2" }],
          inputSystem: { packagePresent: true, activeInputHandling: "NEW" },
          scripting: {},
          inspectedAt: new Date().toISOString(),
        },
        editor: {
          found: true,
          requestedVersion: "6000.3.11f1",
          executablePath: "C:/Unity/Editor/Unity.exe",
          resolutionMethod: "UNITY_HUB_EXACT_VERSION",
        },
      }}
    />,
  );
  assert.match(projectMarkup, /Unity 6000\.3\.11f1/u);
  assert.match(projectMarkup, /Package present/u);

  const toolingMarkup = renderToStaticMarkup(
    <UnityTooling
      status={{
        bridge: "CONNECTED",
        editor: "RUNNING",
        ownedEditor: true,
        editorStatus: {
          isPlaying: true,
          isPaused: false,
          isCompiling: false,
          isUpdating: false,
          activeScene: "SampleScene",
          activePlatform: "StandaloneWindows64",
        },
      }}
      busy={false}
      onPrepare={() => undefined}
      onStart={() => undefined}
      onWaitIdle={() => undefined}
      onStop={() => undefined}
      onRemove={() => undefined}
    />,
  );
  assert.match(toolingMarkup, /M6 Unity tooling/u);
  assert.match(toolingMarkup, /Playing/u);
  assert.match(toolingMarkup, /do not run QA or decide whether the task passes/u);
  assert.match(toolingMarkup, /original project is never used for installation/u);
});
