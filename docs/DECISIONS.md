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

**Implementation note:** M1 originally recorded a state-only recheck request. M4 now reuses a valid interpretation, reruns Feasibility against the current target, and rebuilds only unapproved planning data. It still never trusts prerequisite-task completion by itself.

## D-009: QA is layered, comprehensive, and evidence-based

**Decision:** QA levels are QA0 static, QA1 Unity/project structure, QA2 Play Mode interaction, and QA3 player-like gameplay validation. M7 implements QA0-QA2; M8 owns QA3. A QA session attempts every check that can reasonably continue after a failure and batches all discovered failures.

Acceptance criteria should use evidence such as compiler and Unity console output, runtime state, Game View screenshots, input history, object/component state, and custom probes. Code appearance alone is not sufficient evidence for behavioral criteria.

## D-010: Git is a safety boundary

**Decision:** Git behavior includes repository-state detection, base commit recording, dedicated task branches/worktrees, checkpoints, diffs, guarded rollback, and squashed final task commits. Only one writing task may own a writable worktree at a time; read-only reviewers may operate independently. M2 implements these local primitives but never merges or pushes.

## D-011: Provider-neutral system

**Decision:** Initial providers will be Codex and Claude. Future providers may include DeepSeek, Gemini, local models, and others. The rest of the system must not depend directly on one concrete provider implementation.

## D-012: Prefer simplicity

**Decision:** Use simple, readable TypeScript. Do not add plugin marketplaces, complicated dependency graphs, distributed workers, cloud infrastructure, microservices, event sourcing frameworks, elaborate permission engines, large persistence frameworks, or speculative patterns without a later concrete requirement.

## D-013: Conservative original-worktree policy

**Decision:** UnityAI refuses to prepare a task Git environment when the selected external repository's original worktree has staged, unstaged, or untracked changes. It does not stash, commit, reset, copy, exclude, or automatically include those changes. The user must resolve them manually and retry.

Destructive Git operations are permitted only in the exact persisted UnityAI-managed task worktree after canonical path, repository, branch, task, and write-owner validation. Finalization may rewrite only the dedicated task branch. Cleanup retains the branch, and no M2 operation merges or pushes.

## D-014: Explicit local provider execution boundary

**Decision:** Agent behavior, model configuration, and provider invocation are separate. M3 callers explicitly select an agent, model alias, reasoning effort, and existing working directory; the executor does not infer task strength, choose a route, or escalate after failure.

Codex and Claude use their installed non-interactive CLIs through provider-local argument construction and normal local authentication. Processes receive executable/argument arrays, bounded output capture, timeouts, and cancellation. Provider flags and arbitrary executables are not exposed by HTTP. Development execution metadata is stored under `runtime/ai/runs`; raw input and authentication state are not persisted, and diagnostic logs are redacted and size-bounded.

## D-015: Cost-conscious deterministic analysis planning

**Decision:** A normal first M4 analysis uses exactly two AI calls: Task Interpreter, then Feasibility. Preliminary strength is deterministic code used only to select the configured feasibility route. Final strength, the immutable proposed routing snapshot, and the Task Contract are also deterministic application code; there is no third contract/summarization call and no failure-based model escalation.

A normal blocked-task recheck reuses a valid persisted interpretation and invokes only Feasibility against the current external target. Interpretation is rerun only when its persisted result is missing or invalid. Analysis is read-only, accepts the target's current dirty state without cleaning it, and never prepares an implementation worktree.

## D-016: M5 stops before QA and Git finalization

**Decision:** Approved implementation begins only after an explicit user start. One in-process orchestration run owns the task, prepares the existing M2 environment, runs the approved Implementation route inside the verified managed worktree, and records an internal implementation checkpoint. Cross Review runs only when the task's binary setting is on, uses its approved route read-only, and never applies fixes.

The concrete terminal M5 state is `READY_FOR_QA`. It means implementation and optional review finished; it is not QA success, task completion, or permission to finalize, merge, or push Git history. Provider failure, cancellation, or restart interruption preserves the managed worktree and never escalates the model.

## D-017: Unity integration is temporary, explicit, and loopback-only

**Decision:** The reusable UnityAI Editor Bridge is temporary tooling copied as an embedded package only into an exact, ownership-verified M2 task worktree (or a dedicated disposable validation project). UnityAI never automatically installs it into the user's original project worktree. A task/fingerprint marker is required for idempotent install and removal; a name-only match is insufficient. The package and generated metadata are excluded from task checkpoint/finalization staging and must be removed before a future final task commit.

Each Editor session uses a random authenticated descriptor under the non-versioned `Library/UnityAI` area and a TCP listener bound only to numeric loopback. Network work is queued to Unity's main thread. Unity capabilities are a fixed set of bounded, structured commands; arbitrary C# execution, reflection/menu invocation, filesystem, shell, and process access are intentionally absent. The stdio Unity MCP server reuses the same validated Node bridge client/protocol instead of implementing another transport.

M6 supplies inspection and Editor control capabilities only. M7 consumes them for QA0-QA2 decisions and correction, while input injection, visual QA, gameplay probes, and player-like validation remain M8 responsibilities.

## D-018: M7 batches evidence, fixes conservatively, and finalizes only complete work

**Decision:** An M7 QA cycle attempts every STATIC, STRUCTURAL, and RUNTIME test that can reasonably continue before producing one evidence-backed report. Ordinary failures are batched; prerequisite failures block only dependent tests. Review findings are investigation context rather than automatic QA failures. Provider, Editor, bridge, MCP, cancellation, restart, and invalid-output failures are technical failures and are never disguised as game-code findings.

Automatic Fixes remains exactly `ON` or `OFF`. Fix receives the complete latest defect batch only after the test cycle finishes, runs with `WORKTREE_WRITE` only in the M2-managed worktree, and uses exactly the approved Implementation provider/model/effort. It never uses the QA route or escalates. Every successful fix creates a checkpoint without UnityAI bridge tooling and is followed by full QA from the beginning. One orchestration run permits at most three automatic fix executions; this is an internal runaway-safety bound, not a user profile or mode.

M7 executes only QA0 STATIC, QA1 STRUCTURAL, and QA2 RUNTIME. Every required GAMEPLAY test is recorded `NOT_RUN` with `REQUIRES_M8_GAMEPLAY_QA`, transitions the task to `READY_FOR_GAMEPLAY_QA` after the M7 subset passes, and prevents Git finalization or `COMPLETED`. M7 implements no keyboard, mouse, gamepad, Input System injection, screenshot vision, or player-like behavior.

For a task with no remaining required GAMEPLAY checks, `COMPLETED` requires an evidence-backed M7 PASS, safe owned-Editor shutdown, marker-verified temporary bridge removal, a tooling-free meaningful final diff, and one M2-squashed task commit. Internal implementation/fix checkpoints disappear from final task-branch history. Finalization still never merges, pushes, or modifies the original worktree.

## D-019: Player-level QA drives real bindings and shares the existing correction boundary

**Decision:** QA3 uses UnityAI-owned virtual Unity Input System keyboard, mouse, and gamepad devices as its primary gameplay input path. Semantic actions resolve bounded project bindings and then drive those virtual controls; UnityAI never directly invokes gameplay methods or InputAction callbacks to manufacture a pass. A guarded Windows input implementation is an optional orchestrator-only fallback and refuses any process, project, Game View, or focus state it cannot positively verify.

The existing approved QA model performs player-like reasoning; there is no separate gameplay planner, screenshot model, or route. Game View PNGs are bounded, on-demand evidence rather than a stream. Runtime probes read only allowlisted serialized primitive or Transform values and expose no setter, arbitrary getter, method, or reflection surface. QA-owned input is released and virtual devices are removed after tests, failures, cancellation, Play Mode exit, and finalization without touching real devices.

A gameplay cycle attempts every reasonably executable required test before one batch is returned. Product failures use the existing M7 Fix Agent, exact approved Implementation provider/model/effort, shared three-fix task bound, and checkpoint rules. Every fix invalidates old evidence and restarts QA at STATIC before STRUCTURAL, RUNTIME, and GAMEPLAY. `COMPLETED` requires all required QA0-QA3 checks to pass, no blockers or technical failure, removal of bridge/input/screenshot tooling, and one M2-squashed local task commit. Merge, push, and original-worktree mutation remain absent.
