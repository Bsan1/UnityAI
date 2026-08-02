# Architecture

## Current M1 state

M1 remains a small npm workspace with four independently named workspaces:

```text
apps/web       React + Vite connectivity page
apps/server    Local Node.js HTTP server, JSON task store, and task API
packages/core  Task domain, state transitions, actions, and schema validation
packages/shared Shared HTTP contract types
```

The browser still provides only the M0 connectivity page. During development, Vite proxies `/health` to the local server. The server uses Node's built-in HTTP module and exposes direct task commands. No backend framework or database is present.

`packages/core` owns the `Task` entity, a small fixed state set, legal transition rules, pause/resume and blocked-task actions, feasibility and Task Contract schemas, approval gating, and runtime validation. The task JSON is the source of truth; its event history is only an audit aid, not event sourcing.

`apps/server` owns a concrete local `TaskStore` and `TaskService`. The store scans persisted IDs at startup, validates every task, and performs same-directory temporary-file/rename writes. Data uses this layout:

```text
runtime/tasks/TASK-0001/task.json
runtime/tasks/TASK-0002/task.json
```

`config/defaults.json` contains the two boolean defaults copied into new tasks. M1's supplied feasibility and contract endpoints are development mechanisms only. They do not claim that an agent ran. Recheck moves an eligible task to `ANALYZING`, clears its stale current analysis result, and records the request for M4.

This current structure deliberately contains no AI/provider execution, Git task automation, Unity connection, implementation execution, QA, automatic fix execution, or production task UI.

## Planned architecture

The following boundaries guide later milestones. Only the M1 portions described above are implemented.

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

Filesystem and native Git CLI adapters will inspect and safely modify the selected repository. A later Unity adapter and reusable Unity-side bridge will expose project structure, editor state, Play Mode, and test evidence. Exactly one writing agent may own a writable worktree; read-only reviewers may run independently.

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
