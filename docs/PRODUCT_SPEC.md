# Product specification

## Product intent

UnityAI is intended to become a standalone local AI development orchestrator for Unity game projects. Users will select an external Unity project by filesystem path and submit a development task. The same UnityAI installation must be reusable across unrelated games.

The eventual product will help a user move safely from an imprecise request to an approved, implemented, tested, and committed change. It is intended to interpret the request, inspect the selected repository, analyze feasibility, surface missing prerequisites, present an approval contract, establish a safe Git task environment, implement the work, run broad QA, batch failures, optionally fix them, rerun QA, and create a final commit only after success.

These are product goals, not claims about the current implementation.

## Intended workflow

1. The user selects a Unity project and submits a task.
2. UnityAI interprets explicit and inferred requirements.
3. Feasibility analysis inspects the current project and identifies missing dependencies or architecture.
4. UnityAI produces a Task Contract covering understood and inferred requirements, scope, prerequisites, acceptance criteria, and tests.
5. The user reviews and approves the contract before implementation.
6. UnityAI prepares a safe Git task environment and assigns one writing agent.
7. The selected implementation agent makes the change.
8. Optional cross-model review and a complete available QA session run.
9. Detected failures are reported together; when Automatic Fixes is enabled, eligible failures may be fixed and the complete QA session rerun.
10. A final commit is produced only after successful validation.

## Product principles

- **Project independence:** UnityAI is not part of a specific game repository.
- **Truthful feasibility:** Missing architecture is reported, not hidden behind a local workaround.
- **Approval before implementation:** An approved Task Contract is required.
- **Evidence-based QA:** Behavioral claims should be supported by compiler, Unity, runtime, screenshot, input, object-state, or probe evidence where possible.
- **Failure batching:** QA attempts every test that can reasonably continue and returns the discovered failures together.
- **Git safety:** Repository state, task isolation, checkpoints, diffs, rollback, and controlled final commits are fundamental.
- **Simple local operation:** Prefer a readable local TypeScript application over unnecessary infrastructure.

## User-facing controls

Task strength has exactly three values: `LIGHT`, `STANDARD`, and `STRONG`. It is selected before implementation and does not escalate after failure.

Cross Review and Automatic Fixes each have exactly two states: `ON` and `OFF`. Both default to `ON`.

When feasibility blocks a task, the eventual user actions are:

- **CREATE PREREQUISITE TASK:** create an editable, prefilled draft without executing it;
- **PAUSE:** retain current task state;
- **RECHECK:** rerun feasibility against the current repository state; and
- **CANCEL:** terminate safely according to the future task and Git state rules.

## QA levels

- **QA0:** static checks, compilation, and obvious structural problems.
- **QA1:** Unity/project structure, including scenes, prefabs, components, serialized references, configuration, and Input System setup.
- **QA2:** runtime interaction testing in Unity Play Mode.
- **QA3:** player-like validation of the requested gameplay behavior.

## Current M4 scope

M1 establishes the task entity, state pipeline, schemas, history, and JSON persistence. M2 adds conservative inspection and isolated local Git task environments for external targets. M3 adds independently configured agents, model aliases, and Codex/Claude CLI providers behind a common explicit executor. M4 connects that executor to real read-only task interpretation and current-project feasibility analysis. Deterministic application code selects task strength, snapshots future model routing, and constructs an editable, evidence-oriented Task Contract for approval. Blocked recheck reuses a valid interpretation and inspects the current target again.

M4 stops at `READY_FOR_IMPLEMENTATION` after approval. It does not prepare a Git implementation worktree, modify the target, run an implementation/review/QA/fix workflow, install dependencies, connect to Unity, or provide the production task UI. See [ROADMAP.md](ROADMAP.md) for staged delivery.
