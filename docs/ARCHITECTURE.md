# Architecture

## Current M2 state

M2 remains a small npm workspace with four independently named workspaces:

```text
apps/web       React + Vite connectivity page
apps/server    Local HTTP server, JSON stores, task API, and native-Git safety layer
packages/core  Task domain plus pure task/Git metadata schema validation
packages/shared Shared HTTP contract types
```

The browser still provides only the M0 connectivity page. During development, Vite proxies `/health` to the local server. The server uses Node's built-in HTTP module and exposes direct task commands. No backend framework or database is present.

`packages/core` owns the `Task` entity, state rules/actions, feasibility and Task Contract schemas, and pure Git environment metadata schema. It has no filesystem, child-process, or concrete Git command dependency. Task JSON remains the task source of truth; event history is an audit aid, not event sourcing.

`apps/server` owns the concrete task/Git stores and services. The native Git runner passes argument arrays directly to the installed `git` executable with no shell. Repository inspection resolves the selected external worktree, current branch, base commit, common Git directory, and machine-readable status. Data uses this layout:

```text
runtime/tasks/TASK-0001/task.json
runtime/tasks/TASK-0001/git.json
runtime/tasks/TASK-0002/task.json
runtime/worktrees/TASK-0001/
```

Preparation requires a clean original external worktree, then creates `ai/TASK-0001` in the deterministic managed worktree path. The persisted write owner is the task ID. A repeated prepare returns the same environment only after revalidation; unrelated existing branches or paths are never reused.

Every destructive rollback, cleanup-discard, or task-branch history rewrite derives its target path from persisted metadata and verifies exact canonical managed path, task/write ownership, original-versus-managed separation, repository common directory, current task branch, and target repository identity. The original worktree is never reset or cleaned. Finalization rewrites only the dedicated task branch to one commit on its recorded base. Cleanup retains that branch. The layer contains no merge or push operation.

`config/defaults.json` contains the two boolean defaults copied into new tasks. M1's supplied feasibility and contract endpoints are development mechanisms only. They do not claim that an agent ran. Recheck moves an eligible task to `ANALYZING`, clears its stale current analysis result, and records the request for M4.

This current structure deliberately contains no AI/provider/agent execution, model routing execution, task implementation, Unity connection, QA, automatic fix execution, merge/push/remote management, or production Git UI.

## Planned architecture

The following boundaries guide later milestones. Only the M0-M2 portions described above are implemented.

### Local application boundary

UnityAI runs as its own local application. A selected Unity game is an external target identified by an absolute filesystem path. Target-specific state must not leak into global application definitions. A reusable Unity-side package or bridge may be added later without embedding the orchestrator in a game.

### Web application

The React application will eventually present project selection, task drafting, strength selection, contract approval, blocked-task actions, progress, QA evidence, and results. It sends commands over ordinary HTTP. Server-sent events may later deliver progress updates if needed.

### Local server

The server will coordinate application use cases, persistence, process execution, and external adapters. It remains a lightweight local Node.js service rather than a cloud or microservice system.

### Core domain

Core types and rules now describe tasks, lifecycle state, Task Contracts, feasibility results, and approval. Later milestones may add QA results and configuration-independent agent roles when required. Domain code does not import a concrete AI provider, Unity bridge, web framework, filesystem, or Git implementation.

### Agent and model boundary

An agent definition owns role, instructions, permissions, tools, context rules, and expected output schema. Separately replaceable configuration assigns a provider, model, and effort to that agent for a selected task strength. Provider adapters will translate provider-neutral requests to Codex, Claude, and possible future providers.

### Target project adapters

The filesystem/native-Git adapter now inspects external repositories and safely modifies only verified managed task worktrees. A later Unity adapter and reusable Unity-side bridge will expose project structure, editor state, Play Mode, and test evidence. M2 records one task as the write owner; later orchestration will enforce that only its writing agent uses the worktree, while read-only reviewers may inspect independently.

### Persistence and configuration

Task persistence now uses plain JSON files under a local runtime-data location. Model routing and other replaceable settings belong in configuration rather than repeated conditionals. A database is not planned until demonstrated need justifies one.

## Dependency direction

Later code should keep dependencies pointing inward:

```text
web -> shared contracts
server -> core domain + shared contracts
provider/Git/Unity adapters -> core-defined use cases
core domain -> no concrete adapter
```

This is a boundary guideline, not a request to create empty interfaces before a milestone needs them.

## Simplicity constraints

Do not introduce plugin marketplaces, distributed workers, cloud infrastructure, microservices, event sourcing, elaborate permission engines, large persistence frameworks, or speculative design patterns. Add an abstraction only when current milestone behavior needs it.
