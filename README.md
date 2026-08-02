# UnityAI

UnityAI is the foundation of a standalone, local AI development orchestrator for Unity game projects. A single UnityAI installation will eventually operate on different external projects selected by filesystem path; it is not embedded in a particular game.

## Current status

The repository has completed **M4 - Analysis, Feasibility and Task Contract Pipeline**. It currently provides:

- an npm workspace;
- a strict core task model with explicit lifecycle transitions and audit history;
- JSON-backed task persistence with restart-safe `TASK-0001` IDs;
- a native-Git safety layer for clean external target repositories;
- dedicated `ai/TASK-0001` branches and managed task worktrees;
- status/diff inspection, checkpoints, guarded rollback, squash finalization, and safe cleanup;
- file-loaded agent definitions that are independent of model/provider configuration;
- replaceable model aliases and documented routing records in configuration;
- provider-neutral execution through local Codex and Claude Code CLI adapters;
- structured-output validation, process timeout/cancellation, and bounded execution artifacts;
- production read-only Task Interpreter and Feasibility agents;
- a two-call first-analysis flow and one-call blocked recheck;
- deterministic preliminary/final strength, routing snapshots, and evidence-oriented Task Contracts;
- editable unapproved contracts, approval gating, technical analysis failures, and per-task concurrency protection;
- validated task analysis artifacts linked to bounded M3 execution runs;
- a minimal Node.js/TypeScript HTTP server with health, task, Git, M3 development AI, and M4 analysis APIs;
- a minimal React/Vite page that checks server reachability;
- small `core` and `shared` TypeScript packages; and
- product and architecture documentation.

M1's manually supplied feasibility/contract routes remain development support. M2 can prepare and manage a safe Git environment. M3 can explicitly execute a selected development agent/model. M4 now connects task states to real interpretation and current-target feasibility, but stops after contract approval at `READY_FOR_IMPLEMENTATION`. Git preparation after approval, implementation/review/QA orchestration, cross-review execution, Unity integration, automatic fixes, dependency installation, merging, pushing, and the production task UI are intentionally not implemented. M5 is next.

## Requirements

- Node.js 22.12 or newer
- npm 10 or newer

## Get started

```bash
npm install
npm run typecheck
npm test
npm run build
```

For local development, run these in separate terminals:

```bash
npm run dev:server
npm run dev:web
```

The server listens on `http://127.0.0.1:3000` by default. The Vite development server proxies `/health` to it. Set `UNITYAI_PORT` to change the server port, `UNITYAI_RUNTIME_PATH` to use a different runtime-data directory, or `UNITYAI_CONFIG_PATH` to load different task defaults. M3 also supports `UNITYAI_AGENTS_PATH`, `UNITYAI_MODELS_CONFIG_PATH`, and `UNITYAI_PROVIDERS_CONFIG_PATH`; configuration changes require a restart.

## Task and M4 analysis API

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/tasks` | Create a task in `CREATED`; requires `originalRequest`; M4 analysis also requires `targetProjectPath` |
| `GET` | `/tasks` | List persisted tasks |
| `GET` | `/tasks/:id` | Read one task |
| `PATCH` | `/tasks/:id/draft` | Edit an editable prerequisite `DRAFT` |
| `POST` | `/tasks/:id/submit` | Submit a `DRAFT` into `CREATED` |
| `POST` | `/tasks/:id/analyze` | Run Interpreter, Feasibility, deterministic routing, and contract planning |
| `GET` | `/tasks/:id/analysis` | Read normalized interpretation, feasibility, routing, contract, or failure artifacts |
| `PATCH` | `/tasks/:id/contract` | Edit allowed user-facing fields of an unapproved M4 contract |
| `POST` | `/tasks/:id/feasibility` | Store a supplied M1 feasibility result (development/test support only) |
| `POST` | `/tasks/:id/contract` | Store a supplied M1 Task Contract (development/test support only) |
| `POST` | `/tasks/:id/approve` | Approve the stored contract and become implementation-ready |
| `POST` | `/tasks/:id/pause` | Pause an active task |
| `POST` | `/tasks/:id/resume` | Resume its recorded prior state |
| `POST` | `/tasks/:id/recheck` | Reuse valid interpretation and rerun Feasibility against current target state |
| `POST` | `/tasks/:id/cancel` | Logically cancel a task |
| `POST` | `/tasks/:id/prerequisite-draft` | Create an editable prerequisite draft without executing it |

Task strengths are `LIGHT`, `STANDARD`, and `STRONG`. An optional create-time strength is only an initial value; M4 deterministically records the final strength before approval. Defaults in `config/defaults.json` set Cross Review and Automatic Fixes to `true`; each task persists its copied values.

The supplied feasibility and `POST` contract endpoints are explicitly M1 development mechanisms. Production analysis uses `POST /analyze`. A normal first analysis invokes exactly Interpreter and Feasibility; no third model generates or summarizes the contract. A normal blocked recheck invokes only Feasibility. Technical provider failure is stored as `FAILED` analysis rather than fabricated feasibility, and no stronger model is retried.

## M2 Git API

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/tasks/:id/git` | Read persisted Git environment metadata and current status |
| `POST` | `/tasks/:id/git/inspect` | Inspect the external target repository without mutation |
| `POST` | `/tasks/:id/git/prepare` | Create the dedicated task branch and managed worktree |
| `GET` | `/tasks/:id/git/status` | Read machine-parsed worktree status |
| `GET` | `/tasks/:id/git/diff` | Read changed paths, summary, and textual diff from the base commit |
| `POST` | `/tasks/:id/git/checkpoint` | Commit all managed-worktree changes as an internal checkpoint |
| `POST` | `/tasks/:id/git/rollback` | Roll back only the verified managed worktree to `BASE` or a checkpoint ID |
| `POST` | `/tasks/:id/git/finalize` | Squash net task changes into one local task commit |
| `POST` | `/tasks/:id/git/cleanup` | Remove only the registered managed worktree while retaining its branch |

M2's V1 policy refuses preparation with `TARGET_WORKTREE_DIRTY` if the original target worktree has staged, unstaged, or untracked changes. UnityAI does not stash, commit, reset, copy, or exclude user changes. The user must clean or commit them manually before retrying.

The task branch is `ai/TASK-0001`; the worktree defaults to `runtime/worktrees/TASK-0001`. Destructive reset/clean and branch-history squash operations run only after exact persisted ownership, canonical path, repository identity, and branch checks. Cleanup of active work requires `{ "discardChanges": true }`. Final task branches are never merged or pushed.

## Persistence

Tasks are stored as `runtime/tasks/TASK-0001/task.json`; M2 Git metadata is stored separately as `runtime/tasks/TASK-0001/git.json`. M4 writes `interpretation.json`, `feasibility.json`, `routing.json`, `contract.json`, or a technical `failure.json` under `runtime/tasks/TASK-0001/analysis/`. Writes use a temporary file followed by a same-directory rename. Persisted content is validated on read, and invalid metadata fails clearly.

## M3 AI development API

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/ai/providers` | Report configured CLI, version, and authentication availability without running a completion |
| `GET` | `/ai/models` | Return configured model aliases and non-executing routing records |
| `GET` | `/ai/agents` | Return loaded agent definitions and access metadata |
| `POST` | `/ai/execute` | Execute one explicit agent/model/effort in an explicit existing directory |

`POST /ai/execute` is development support for M3. It accepts `agentId`, `modelId`, `effort`, `workingDirectory`, `input`, optional `context`, and optional `timeoutMs`. It does not choose a model, classify strength, mutate a task state, run cross-review, or start an implementation pipeline. Provider executables and flags are never accepted from HTTP callers.

Codex runs through non-interactive `codex exec` with JSONL/final-message output, native schema support, an explicit model/effort/directory, ephemeral sessions, and a sandbox derived from agent permission. Claude runs through non-interactive print mode with JSON/schema output, explicit model/effort, no session persistence, and locked-down tool/permission flags. Both use normal local CLI authentication and executable/argument arrays with prompt input over stdin.

M3 execution records use this global development layout until M4 associates runs with tasks:

```text
runtime/ai/runs/RUN-<UUID>/request.json
runtime/ai/runs/RUN-<UUID>/result.json
runtime/ai/runs/RUN-<UUID>/stdout.log
runtime/ai/runs/RUN-<UUID>/stderr.log
```

Request artifacts contain metadata, sizes, and a digest rather than raw input/context. Logs are redacted and bounded by `maximumPersistedLogBytes` in `config/providers.json`. Provider credentials and environment variables are never written to execution records.

## M4 analysis behavior

The production Interpreter reasons from the task request without repository inspection. Deterministic preliminary strength selects one configured Feasibility route. Feasibility runs read-only in the external `targetProjectPath` and inspects the current project state; a dirty target is observed but never cleaned, stashed, committed, or copied. A bounded before/after project fingerprint provides a practical read-only regression guard.

`READY` produces a deterministic unapproved Task Contract and `WAITING_FOR_APPROVAL`. `AUTO_FIXABLE`, `BLOCKED_ARCHITECTURE`, and `BLOCKED_USER` remain `BLOCKED`; M4 installs nothing. Contracts include stable acceptance/test IDs, evidence expectations, test categories, final strength, and a persisted future execution plan. Fix matches Implementation exactly, Cross Review remains a task boolean, and there is no model escalation.

After approval, the task reaches `READY_FOR_IMPLEMENTATION` and M4 stops. Approval does not prepare an M2 worktree or execute any agent. A normal recheck reads the current target and reuses the valid Interpreter artifact, so it costs one Feasibility call. Missing or invalid interpretation causes it to be regenerated.

## Documentation

- [Product specification](docs/PRODUCT_SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Product decisions](docs/DECISIONS.md)
- [Model routing](docs/MODEL_ROUTING.md)
- [Roadmap](docs/ROADMAP.md)
