# Fixed product decisions

This file records the fixed decisions that future milestones must preserve. Entries use a compact ADR-like format; a change requires an explicit product decision rather than incidental implementation drift.

## D-001: Standalone, project-independent application

**Decision:** UnityAI is a standalone local application. Unity games are external targets selected by filesystem path. The orchestrator must not be embedded in one specific game. A reusable Unity-side package or bridge may be introduced later.

## D-002: Agents and models are separate

**Decision:** An agent defines its role, instructions, permissions, tools, context rules, and expected output schema. A model is the provider/model/effort assignment for that agent. Changing a model must not require changing the agent definition.

## D-003: Task strength is fixed before implementation

**Decision:** The only task strengths are `LIGHT`, `STANDARD`, and `STRONG`. Strength is selected before implementation. There is no runtime model escalation after failures and no Economy/Balanced/Quality cost policy. Fix work uses the exact implementation model and effort already selected for the task.

## D-004: Routing is replaceable configuration

**Decision:** Initial routing is recorded in [MODEL_ROUTING.md](MODEL_ROUTING.md). Routing must not be hardcoded throughout the application and can be manually revised as models change.

## D-005: Binary review and fix controls

**Decision:** Cross Review has exactly `ON` and `OFF`, defaulting to `ON`. Automatic Fixes also has exactly `ON` and `OFF`, defaulting to `ON`. No Auto, Smart, Hybrid, Manual, Always, profile, or similar modes are permitted.

When Automatic Fixes is on, localized failures may eventually be fixed automatically and QA rerun. Architectural ambiguity, major scope changes, or repeated inability to solve a task must return control to the user.

## D-006: Approved Task Contract gates implementation

**Decision:** Interpretation and feasibility analysis produce a Task Contract containing understood requirements, inferred requirements, implementation scope, prerequisites, acceptance criteria, and test requirements. Implementation must not start before user approval.

## D-007: Feasibility must expose missing architecture

**Decision:** Agents must not hide a missing architectural capability with a narrow workaround. For example, if tower placement is requested but no placement system exists, feasibility reports that prerequisite instead of silently adding arbitrary spawning behavior.

A dependency is safely auto-fixable only when it is simple and approved, such as an official Unity package or explicitly approved dependency. Missing architecture is not an auto-installable dependency. Arbitrary frameworks must not be downloaded to disguise it.

## D-008: Simple blocked-task handling

**Decision:** A blocked task will offer exactly the relevant actions `CREATE PREREQUISITE TASK`, `PAUSE`, `RECHECK`, and `CANCEL`.

- Creating a prerequisite opens an editable, optionally prefilled draft and does not execute it.
- Pausing preserves task state.
- Rechecking inspects the current repository again rather than trusting prior completion.
- Cancelling terminates safely under future Git and state rules.

Do not introduce a dependency graph unless a later demonstrated need requires it.

**M1 implementation note:** Because real feasibility does not exist yet, recheck records the request and returns the task to `ANALYZING` without fabricating a result. M4 will connect that state to current-repository inspection.

## D-009: QA is layered, comprehensive, and evidence-based

**Decision:** Future QA levels are QA0 static, QA1 Unity/project structure, QA2 Play Mode interaction, and QA3 player-like gameplay validation. A QA session attempts every check that can reasonably continue after a failure and batches all discovered failures.

Acceptance criteria should use evidence such as compiler and Unity console output, runtime state, Game View screenshots, input history, object/component state, and custom probes. Code appearance alone is not sufficient evidence for behavioral criteria.

## D-010: Git is a safety boundary

**Decision:** Future Git behavior includes repository-state detection, base commit recording, task branches and/or worktrees, checkpoints, diffs, rollback, and final commits. Only one writing agent may own a writable worktree at a time; read-only reviewers may operate independently. M1 does not automate Git.

## D-011: Provider-neutral system

**Decision:** Initial providers will be Codex and Claude. Future providers may include DeepSeek, Gemini, local models, and others. The rest of the system must not depend directly on one concrete provider implementation.

## D-012: Prefer simplicity

**Decision:** Use simple, readable TypeScript. Do not add plugin marketplaces, complicated dependency graphs, distributed workers, cloud infrastructure, microservices, event sourcing frameworks, elaborate permission engines, large persistence frameworks, or speculative patterns without a later concrete requirement.
