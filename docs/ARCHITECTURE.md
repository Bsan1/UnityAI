# Architecture

## Current M0 state

M0 is a small npm workspace with four independently named workspaces:

```text
apps/web       React + Vite connectivity page
apps/server    Local Node.js HTTP server with GET /health
packages/core  Application identity and core product metadata
packages/shared Shared HTTP contract types
```

The browser calls `/health`. During development, Vite proxies that request to the local server. The server uses Node's built-in HTTP module; no backend framework or database is present. `config/` documents the future home of replaceable configuration. `runtime/` reserves a Git-ignored location for future local mutable state.

This current structure deliberately contains no AI, Git, Unity, task execution, state pipeline, or QA implementation.

## Planned architecture

The following boundaries guide later milestones but are not implemented in M0.

### Local application boundary

UnityAI runs as its own local application. A selected Unity game is an external target identified by an absolute filesystem path. Target-specific state must not leak into global application definitions. A reusable Unity-side package or bridge may be added later without embedding the orchestrator in a game.

### Web application

The React application will eventually present project selection, task drafting, strength selection, contract approval, blocked-task actions, progress, QA evidence, and results. It sends commands over ordinary HTTP. Server-sent events may later deliver progress updates if needed.

### Local server

The server will coordinate application use cases, persistence, process execution, and external adapters. It remains a lightweight local Node.js service rather than a cloud or microservice system.

### Core domain

Core types and rules will describe tasks, lifecycle state, Task Contracts, feasibility results, approval, QA results, and configuration-independent agent roles. Domain code must not import a concrete AI provider, Unity bridge, web framework, or Git process implementation.

### Agent and model boundary

An agent definition owns role, instructions, permissions, tools, context rules, and expected output schema. Separately replaceable configuration assigns a provider, model, and effort to that agent for a selected task strength. Provider adapters will translate provider-neutral requests to Codex, Claude, and possible future providers.

### Target project adapters

Filesystem and native Git CLI adapters will inspect and safely modify the selected repository. A later Unity adapter and reusable Unity-side bridge will expose project structure, editor state, Play Mode, and test evidence. Exactly one writing agent may own a writable worktree; read-only reviewers may run independently.

### Persistence and configuration

Initial persistence will use plain JSON files under a local runtime-data location. Model routing and other replaceable settings belong in configuration rather than repeated conditionals. A database is not planned until demonstrated need justifies one.

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
