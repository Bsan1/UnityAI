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
  CompletedTask,
  ProjectUnityStatus,
  QAProgressView,
  QAResultView,
  ReadyForQa,
  ReadyForGameplayQA,
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
    qa: { sessions: [], reports: [], fixes: [] },
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
    qa: { sessions: [], reports: [], fixes: [] },
    blockedActions: [],
  };
  const markup = renderToStaticMarkup(
    <ReadyForQa details={details} busy={false} onRunQA={() => undefined} />,
  );
  assert.match(markup, /does not mean this task passed QA/u);
  assert.match(markup, /Automatic Fixes: ON/u);
  assert.match(markup, />Run QA</u);
  assert.match(markup, /REVIEW-001/u);
  assert.match(markup, /not been finalized, merged, or pushed/u);
});

test("M7 QA UI renders progress, a complete evidence-backed batch, gameplay pending, and final commit state", () => {
  const timestamp = new Date().toISOString();
  const baseTask = parseTask({
    id: "TASK-8003",
    title: "QA fixture",
    originalRequest: "Add a QA fixture.",
    targetProjectPath: "C:/project",
    strength: "STANDARD",
    state: "FAILED",
    createdAt: timestamp,
    updatedAt: timestamp,
    crossReviewEnabled: false,
    automaticFixesEnabled: false,
    taskContract: {
      understoodExplicitRequirements: ["Add the fixture."],
      inferredRequirements: [],
      prerequisites: [],
      implementationScope: ["Assets/Fixture.cs"],
      nonGoals: ["No player input."],
      acceptanceCriteria: ["Fixture initializes."],
      testRequirements: ["RUNTIME: Fixture initializes."],
      approved: true,
      approvedAt: timestamp,
    },
    prerequisiteDraftIds: [],
    events: [{ timestamp, type: "TASK_CREATED" }],
  });
  const evidence = {
    id: "EVID-0001",
    kind: "PLAY_MODE" as const,
    summary: "Runtime object was missing.",
    capturedAt: timestamp,
  };
  const result = {
    testId: "TEST-001",
    category: "RUNTIME" as const,
    status: "FAIL" as const,
    summary: "Fixture did not initialize.",
    expected: "Fixture object is active.",
    observed: "Fixture object was absent.",
    evidence: [evidence.id],
    likelyArea: ["Assets/Fixture.cs"],
  };
  const finding = {
    id: "FAIL-001",
    severity: "blocking" as const,
    title: "Fixture initialization failed",
    description: "The required runtime object was not present.",
    relatedAcceptanceCriteria: ["AC-001"],
    relatedTests: [result.testId],
    reproduction: ["Enter Play Mode."],
    expected: result.expected,
    observed: result.observed,
    evidence: [evidence.id],
    suspectedArea: ["Assets/Fixture.cs"],
    source: "RUNTIME" as const,
  };
  const session = {
    schemaVersion: 1 as const,
    sessionId: "QA-UI",
    taskId: baseTask.id,
    cycleNumber: 1,
    startedAt: timestamp,
    completedAt: timestamp,
    status: "FAIL" as const,
    plannedTests: [{
      id: result.testId,
      category: result.category,
      description: "Fixture initializes.",
      required: true as const,
      source: "CONTRACT" as const,
    }],
    results: [result],
    findings: [finding],
    blockedTests: [],
    evidence: [evidence],
    summary: { text: "One failure.", passed: 0, failed: 1, blocked: 0, notRun: 0, gameplayPending: 0 },
  };
  const report = {
    schemaVersion: 1 as const,
    sessionId: session.sessionId,
    taskId: baseTask.id,
    cycleNumber: 1,
    outcome: "FAIL" as const,
    summary: session.summary,
    results: [result],
    findings: [finding],
    blockedTests: [],
    generatedAt: timestamp,
    manualFixAvailable: true,
  };
  const details: TaskDetailsResponse = {
    task: baseTask,
    git: {},
    orchestration: {},
    progress: {
      taskId: baseTask.id,
      state: baseTask.state,
      active: false,
      steps: [],
      events: baseTask.events,
      reviewFindingCount: 0,
      qaCycle: 1,
      qaSummary: { passed: 0, failed: 1, blocked: 0, gameplayPending: 0 },
    },
    qa: {
      sessions: [session],
      reports: [report],
      fixes: [],
      latestSession: session,
      latestReport: report,
    },
    blockedActions: [],
  };

  const failureMarkup = renderToStaticMarkup(
    <QAResultView
      details={details}
      busy={false}
      onFixAndRetest={() => undefined}
      onPause={() => undefined}
      onCancel={() => undefined}
    />,
  );
  assert.match(failureMarkup, /Complete QA failure batch/u);
  assert.match(failureMarkup, /FAIL-001/u);
  assert.match(failureMarkup, /Expected: Fixture object is active/u);
  assert.match(failureMarkup, /EVID-0001: Runtime object was missing/u);
  assert.match(failureMarkup, /Fix &amp; retest/u);

  const testingDetails = {
    ...details,
    task: { ...baseTask, state: "TESTING" as const },
  };
  const progressMarkup = renderToStaticMarkup(
    <QAProgressView
      details={testingDetails}
      busy={false}
      onPause={() => undefined}
      onCancel={() => undefined}
    />,
  );
  assert.match(progressMarkup, /Running static, structural, and runtime QA/u);
  assert.match(progressMarkup, /No chain-of-thought/u);

  const pendingSession = {
    ...session,
    status: "INCOMPLETE_GAMEPLAY" as const,
    summary: { text: "M7 passed.", passed: 3, failed: 0, blocked: 0, notRun: 1, gameplayPending: 1 },
  };
  const pendingMarkup = renderToStaticMarkup(
    <ReadyForGameplayQA
      details={{
        ...details,
        task: { ...baseTask, state: "READY_FOR_GAMEPLAY_QA" },
        qa: { ...details.qa, latestSession: pendingSession },
      }}
    />,
  );
  assert.match(pendingMarkup, /1 required player-level gameplay test/u);
  assert.match(pendingMarkup, /Run gameplay QA/u);

  const completedMarkup = renderToStaticMarkup(
    <CompletedTask
      details={{
        ...details,
        task: { ...baseTask, state: "COMPLETED" },
        git: {
          environment: {
            schemaVersion: 1,
            taskId: baseTask.id,
            repositoryRoot: "C:/project",
            originalWorktreePath: "C:/project",
            gitCommonDirectory: "C:/project/.git",
            baseBranch: "main",
            baseCommit: "base",
            taskBranch: "ai/TASK-8003",
            taskWorktreePath: "C:/runtime/TASK-8003",
            writeOwnerTaskId: baseTask.id,
            status: "FINALIZED",
            createdAt: timestamp,
            finalizedAt: timestamp,
            finalCommit: "final-commit",
            checkpoints: [],
          },
        },
      }}
    />,
  );
  assert.match(completedMarkup, /All required QA passed/u);
  assert.match(completedMarkup, /final-commit/u);
  assert.match(completedMarkup, /Merged: No/u);
  assert.match(completedMarkup, /Pushed: No/u);
});

test("dirty-worktree errors are translated into actionable UI copy", () => {
  const message = userMessageForError(
    new ApiError("TARGET_WORKTREE_DIRTY", "dirty"),
  );
  assert.match(message, /will not modify or stash/u);
  assert.match(message, /Commit or clean/u);
});

test("M8 gameplay safety errors explain blocked input and unsafe OS focus", () => {
  assert.match(
    userMessageForError(new ApiError("INPUT_BINDING_UNSUPPORTED", "unsupported")),
    /remains blocked/u,
  );
  assert.match(
    userMessageForError(new ApiError("OS_INPUT_FOCUS_UNSAFE", "unsafe")),
    /refused to send operating-system input/u,
  );
  assert.match(
    userMessageForError(new ApiError("SCREENSHOT_CAPTURE_FAILED", "failed")),
    /technical failure/u,
  );
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
