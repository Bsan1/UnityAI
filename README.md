# UnityAI

UnityAI is the foundation of a standalone, local AI development orchestrator for Unity game projects. A single UnityAI installation will eventually operate on different external projects selected by filesystem path; it is not embedded in a particular game.

## Current status

The repository has completed **M3 - AI Provider and Agent Abstraction**. It currently provides:

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
- a minimal Node.js/TypeScript HTTP server with health, task, Git, and M3 development AI APIs;
- a minimal React/Vite page that checks server reachability;
- small `core` and `shared` TypeScript packages; and
- product and architecture documentation.

M1 can store supplied feasibility results and Task Contracts so the state pipeline can be tested. M2 can prepare and manage a safe Git environment. M3 can explicitly execute a selected development agent/model through either configured provider, but it is not connected to task states. Real interpretation/feasibility, Task Contract generation, task-strength routing, implementation/review/QA orchestration, Unity integration, automatic fixes, merging, pushing, and the production task UI are intentionally not implemented. M4 is next.

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

## M1 task API

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/tasks` | Create a task in `CREATED`; requires `originalRequest` and `strength` |
| `GET` | `/tasks` | List persisted tasks |
| `GET` | `/tasks/:id` | Read one task |
| `PATCH` | `/tasks/:id/draft` | Edit an editable prerequisite `DRAFT` |
| `POST` | `/tasks/:id/submit` | Submit a `DRAFT` into `CREATED` |
| `POST` | `/tasks/:id/analyze` | Request the `ANALYZING` state without running AI |
| `POST` | `/tasks/:id/feasibility` | Store a supplied M1 feasibility result |
| `POST` | `/tasks/:id/contract` | Store a supplied, unapproved Task Contract |
| `POST` | `/tasks/:id/approve` | Approve the stored contract and become implementation-ready |
| `POST` | `/tasks/:id/pause` | Pause an active task |
| `POST` | `/tasks/:id/resume` | Resume its recorded prior state |
| `POST` | `/tasks/:id/recheck` | Request fresh analysis for a blocked task |
| `POST` | `/tasks/:id/cancel` | Logically cancel a task |
| `POST` | `/tasks/:id/prerequisite-draft` | Create an editable prerequisite draft without executing it |

Task strengths are `LIGHT`, `STANDARD`, and `STRONG`. Defaults in `config/defaults.json` set Cross Review and Automatic Fixes to `true`; each task persists its copied values.

The feasibility and contract endpoints are explicitly M1 development mechanisms. M4 will connect these state changes to real analysis agents. Recheck clears the stale current result, records the request in history, and returns to `ANALYZING`; it does not claim that feasibility ran.

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

Tasks are stored as `runtime/tasks/TASK-0001/task.json`; M2 Git metadata is stored separately as `runtime/tasks/TASK-0001/git.json`. Writes use a temporary file followed by a same-directory rename. Persisted content is validated on read, and invalid metadata fails clearly.

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

## Documentation

- [Product specification](docs/PRODUCT_SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Product decisions](docs/DECISIONS.md)
- [Model routing](docs/MODEL_ROUTING.md)
- [Roadmap](docs/ROADMAP.md)
