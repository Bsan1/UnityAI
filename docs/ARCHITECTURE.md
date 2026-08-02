# Architecture

## Current M7 state

UnityAI remains a small npm workspace with six independently named workspaces:

```text
apps/web       React + Vite local project/task workflow
apps/server    Local HTTP server, JSON stores, orchestration, and concrete Git/AI/Unity lifecycle adapters
apps/unity-mcp Focused MCP stdio facade over the shared Unity bridge client
packages/core  Pure task/Git/agent/model/analysis/orchestration/QA types, validation, and rules
packages/shared Shared HTTP contract types
packages/unity Unity project metadata, Editor resolution, bridge protocol, client, and validation
```

The browser provides project registration, task creation/history, analysis and blocked actions, Task Contract editing/approval, implementation start, polling progress, implementation/review results, M7 QA/fix progress, batch reports, gameplay-pending status, and finalized commit details. Vite proxies local API paths to the server. The server still uses Node's built-in HTTP module; no backend framework or database is present.

`packages/core` owns the `Task` entity, state rules/actions, feasibility and Task Contract schemas, pure Git environment metadata, agent definitions, model aliases, reasoning effort, declarative routing schemas, and M7 QA session/result/finding/evidence/fix schemas. M4 adds pure interpretation/feasibility classifiers and deterministic planning; M7 adds explicit QA/fix transitions and validation without importing filesystem, child-process, concrete Git/provider, or Unity mechanics. Agent definitions contain behavior and access metadata but no model or provider invocation. Task JSON remains the task source of truth; event history is an audit aid, not event sourcing.

`apps/server` owns the concrete task/Git stores and services. The native Git runner passes argument arrays directly to the installed `git` executable with no shell. Repository inspection resolves the selected external worktree, current branch, base commit, common Git directory, and machine-readable status. Data uses this layout:

```text
runtime/tasks/TASK-0001/task.json
runtime/tasks/TASK-0001/git.json
runtime/tasks/TASK-0001/unity.json
runtime/tasks/TASK-0001/qa/cycle-001/session.json
runtime/tasks/TASK-0001/qa/cycle-001/report.json
runtime/tasks/TASK-0001/qa/cycle-001/evidence/EVID-0001.json
runtime/tasks/TASK-0001/fixes/fix-001/result.json
runtime/tasks/TASK-0002/task.json
runtime/worktrees/TASK-0001/
```

Preparation requires a clean original external worktree, then creates `ai/TASK-0001` in the deterministic managed worktree path. The persisted write owner is the task ID. A repeated prepare returns the same environment only after revalidation; unrelated existing branches or paths are never reused.

Every destructive rollback, cleanup-discard, or task-branch history rewrite derives its target path from persisted metadata and verifies exact canonical managed path, task/write ownership, original-versus-managed separation, repository common directory, current task branch, and target repository identity. The original worktree is never reset or cleaned. Finalization rewrites only the dedicated task branch to one commit on its recorded base. Cleanup retains that branch. The layer contains no merge or push operation.

`config/defaults.json` contains the two boolean defaults copied into new tasks. M1's supplied feasibility and contract endpoints remain clearly separated development mechanisms only. The production `/tasks/:id/analyze` path now runs M4 analysis, while `/tasks/:id/recheck` performs current-target feasibility again.

M3 adds three explicitly separate concepts:

```text
AgentDefinition -> behavior, instructions, permission, tools, context, schema
ModelDefinition -> stable alias, provider ID, provider model name, supported effort
AIProvider      -> local external-system invocation
```

`agents/*.json` contains the production Interpreter, Feasibility, Implementation, Review, QA, and Fix definitions plus two small development probes. `config/models.json` contains replaceable model aliases and the documented routing table; `config/providers.json` contains CLI names, timeout, log bounds, and the native Windows Codex sandbox selection. `AgentExecutor` supports ordinary configured model resolution and exact execution from a persisted approved plan. It canonicalizes the working directory, assembles the provider-neutral request, invokes the provider, validates structured output with JSON Schema, and stores the normalized run. Internal callers may attach a validated provider-neutral stdio MCP configuration; its executable/arguments are never accepted by the development HTTP endpoint or persisted in run artifacts.

The provider registry contains concrete Codex and Claude adapters. Both use a shared process runner with `shell: false`, executable/argument arrays, prompt stdin, bounded capture, timeout, AbortSignal cancellation, exit status, and spawn diagnostics. On Windows, startup resolves installed npm CLI wrappers to their native executable or safe Node entry point instead of passing prompts through `cmd.exe`. Provider-specific flags remain inside their adapter.

Codex uses non-interactive `codex exec`, ephemeral JSONL/final-message output, native output schemas, an explicit model and reasoning effort, an explicit working directory, and a sandbox derived from the agent's permission. Claude uses non-interactive print mode, JSON/schema output, explicit model/effort, no session persistence, and restricted permission/tool flags. Availability checks call only CLI version and local auth-status commands. They report CLI presence separately from confirmed authentication and discard auth-status details beyond the boolean state.

Development runs use this layout:

```text
runtime/ai/runs/RUN-<UUID>/request.json
runtime/ai/runs/RUN-<UUID>/result.json
runtime/ai/runs/RUN-<UUID>/stdout.log
runtime/ai/runs/RUN-<UUID>/stderr.log
```

The request record omits raw input/context and stores only character counts and a digest. Provider environment/authentication is never serialized. Result and diagnostic text is redacted before persistence; stdout/stderr use a configured byte bound. The `/ai/execute` endpoint is development-only and accepts no executable or provider flags.

M4 adds production `task-interpreter` and `feasibility` definitions. Both are provider/model-independent and `READ_ONLY`. A first analysis performs exactly two calls:

```text
CREATED -> ANALYZING
  -> Interpreter (configured ALL route)
  -> deterministic preliminary strength
  -> Feasibility (configured preliminary-strength route, current target directory)
  -> deterministic final strength
  -> deterministic routing snapshot
  -> deterministic Task Contract when READY
  -> WAITING_FOR_APPROVAL or BLOCKED
```

The Interpreter does not inspect project files. Feasibility receives the interpretation and inspects only relevant current target files through the provider's read-only policy. M4 does not require a clean target: it observes the user's current state without stashing, cleaning, committing, installing, or preparing an M2 worktree. A bounded before/after source fingerprint, excluding Git and Unity-generated directories, detects practical read-only violations; UnityAI reports a failure and never performs destructive cleanup.

Preliminary and final strength are explicit pure rules. Preliminary strength selects only the single Feasibility invocation. Final strength resolves a snapshot containing Implementation, QA, identical Fix, and optional configured Review plans. The task's persisted Cross Review and Automatic Fixes booleans control those plans. No route escalates after failure.

Task Contracts merge Interpreter and Feasibility planning data in stable order, remove obvious duplicates, assign stable `AC-001`/`TEST-001` IDs, and retain evidence expectations plus relevant static, structural, runtime, or gameplay test categories. An unapproved contract can edit only user-facing planning fields. Strength, routing, run IDs, evidence, and approval timestamps cannot be patched. Approval persists the selected snapshot and transitions only to `READY_FOR_IMPLEMENTATION`.

M4 analysis data uses:

```text
runtime/tasks/TASK-0001/task.json
runtime/tasks/TASK-0001/analysis/interpretation.json
runtime/tasks/TASK-0001/analysis/feasibility.json
runtime/tasks/TASK-0001/analysis/routing.json
runtime/tasks/TASK-0001/analysis/contract.json
runtime/tasks/TASK-0001/analysis/failure.json  (only on technical failure)
```

Interpretation and feasibility records retain their global M3 `RUN-<UUID>` references; provider stdout/stderr remain only in bounded global execution artifacts. Analysis JSON is validated on read and written by temporary-file rename. One in-process task guard rejects simultaneous analysis mutation. A normal blocked recheck reuses valid interpretation, clears stale proposed planning, reruns Feasibility once against the current target, and rebuilds strength/routing/contract. Missing or invalid interpretation is the only reason recheck invokes Interpreter again.

M5 adds an explicit post-approval orchestration boundary:

```text
READY_FOR_IMPLEMENTATION
  -> prepare verified M2 branch/worktree
  -> IMPLEMENTING (approved route, WORKTREE_WRITE)
  -> implementation checkpoint
  -> REVIEWING when Cross Review is ON (approved route, READ_ONLY)
  -> READY_FOR_QA
```

`ProjectRegistry` stores canonical external Git roots without deep Unity validation. `SettingsStore` persists only Cross Review and Automatic Fixes defaults; each new task copies them. `ImplementationOrchestrator` uses a per-task in-process guard and background `AbortController`, coordinates existing M1-M4 services, persists phase records, and never puts workflow logic in route handlers. It verifies the M2 write owner and managed path before launching Implementation, verifies real Git changes and unchanged task-branch history before checkpointing, and fingerprints the worktree before/after Review to enforce read-only behavior.

The approved per-task routing snapshot is authoritative. Implementation and Review are executed with its provider model name and effort even if current global configuration changes; there is no failure escalation. Provider failure, cancellation, or restart interruption is stored as a technical phase failure while preserving the worktree. Review findings are retained as QA focus and do not trigger a fix loop.

M5 data extends the runtime layout without duplicating M3 logs:

```text
runtime/projects.json
runtime/settings.json
runtime/tasks/TASK-0001/implementation/result.json
runtime/tasks/TASK-0001/review/result.json
runtime/tasks/TASK-0001/orchestration/failure.json
runtime/tasks/TASK-0001/orchestration/git-status.json
```

The browser polls normalized progress/events; no chat transcript, chain-of-thought, WebSocket, queue, or distributed worker exists. `READY_FOR_QA` means implementation plus optional review completed. It is not `COMPLETED`, does not represent QA evidence, and does not finalize, merge, or push Git history.

M6 adds a project-independent Unity capability layer without changing task workflow state:

```text
UnityAI server / Unity MCP
          -> shared UnityBridgeClient
          -> authenticated newline-delimited JSON on 127.0.0.1
          -> Editor-only UnityAI bridge package
          -> queued Unity main-thread commands
```

`UnityProjectAdapter` performs bounded structural inspection of `Assets`, `Packages`, `ProjectSettings/ProjectVersion.txt`, package manifests, Input System indicators, and safely available scripting metadata. `UnityEditorResolver` honors an optional project-specific executable override, otherwise selects an exact project-version match from common Unity Hub locations. It never downloads an Editor or initializes a project.

The reusable source package lives at `unity/Packages/com.unityai.editor-bridge`. `UnityEnvironmentService` copies it only to the exact M2-managed worktree as an embedded package. A task-specific ownership marker and source fingerprint make installation idempotent and make conflicts/removal fail closed. The original external worktree is rejected as an installation or removal target. Git checkpoint/finalization staging explicitly excludes this temporary package and its sibling `.meta` file; future finalization must remove the package first.

Each Editor session binds an ephemeral port on `127.0.0.1`, generates a cryptographically random token, and writes its descriptor only under `Library/UnityAI/bridge-session.json`. The Node client validates protocol version, loopback host, port, process ID, and exact expected canonical project root before sending the token. Tokens are not copied to `unity.json` or task events. Requests and responses are bounded, time-limited, cancellable, and restricted to known methods. Network work is queued for execution through `EditorApplication.update`, so background listener threads do not manipulate Unity objects.

The explicit bridge command surface is `bridge.ping`, `editor.status`, `editor.requestCompilation`, `play.enter`, `play.exit`, `play.setPaused`, `console.get`, `scene.summary`, `scene.hierarchy`, and `object.snapshot`. General console data is bounded and truthfully reports `complete: false`. Bridge 0.2.0 uses public `CompilationPipeline` callbacks plus a bounded `Library/UnityAI` result to associate error/warning counts with one identified compilation across domain reload; `editor.status` exposes that result without expanding the command/MCP surface. Scene/object inspection is read-only and bounded. There is no arbitrary C#, reflection, menu, filesystem, shell, process, asset, prefab, or scene-editing command.

`UnityEditorProcessManager` launches an argument array with `shell: false` and `-projectPath` set to the registered managed worktree. Stop is allowed only for a process UnityAI launched whose recorded project/session identity still matches; merely connected Editors are not owned. Restart revalidates persisted metadata and the current descriptor instead of trusting an old PID. `waitForUnityIdle` deterministically polls compilation/update state and tolerates the expected short bridge reconnect window caused by Unity domain reload.

`apps/unity-mcp` uses the same `UnityBridgeClient` and exposes ten correspondingly focused stdio tools. It connects to one expected managed project per process and owns no installation, launch, task-state, QA, or pass/fail logic. M7 QA consumes this capability through the provider layer; the MCP server itself still does not decide acceptance, inject input, capture screenshots, or execute fixes.

M7 adds one deterministic `QAOrchestrator` above the existing services:

```text
READY_FOR_QA -> TESTING
  -> validate M2 worktree and M6 environment
  -> deterministic diff + identified compilation preflight
  -> bounded structural/runtime evidence and safe Play Mode lifecycle
  -> QA Agent READ_ONLY with per-run Unity MCP
  -> complete cycle report
  -> FAILED -> FIXING -> bridge-free fix checkpoint -> TESTING (full rerun)
  -> READY_FOR_GAMEPLAY_QA when required GAMEPLAY remains
  -> owned tooling cleanup -> M2 squash -> COMPLETED otherwise
```

The QA Agent receives the approved contract, approved QA route, implementation/review context, current diff, deterministic evidence, and only the ten M6 Unity tools. Codex and Claude adapters translate the same internal MCP configuration; no provider-specific flag leaks into orchestration. Each planned STATIC, STRUCTURAL, or RUNTIME result is `PASS`, `FAIL`, `BLOCKED`, or `NOT_RUN`, with PASS/FAIL requiring persisted evidence. Compilation failure blocks dependent runtime work but leaves independent checks attemptable. General console completeness is preserved in evidence and never overstated.

Ordinary defects are batched only after all reasonably executable tests finish. Automatic Fixes is the persisted boolean: `OFF` exposes one manual Fix & Retest action; `ON` invokes the Fix Agent after the full batch. Fix always uses the exact approved Implementation provider/model/effort, works only in the managed worktree, and cannot checkpoint while bridge tooling exists. Every fix starts a new full QA session; the internal automatic bound is three fix executions, with no retry escalation. Editor/provider/MCP/output failures are technical failures and never become fake code findings.

Required GAMEPLAY checks are deterministically `NOT_RUN / REQUIRES_M8_GAMEPLAY_QA`. They lead to `READY_FOR_GAMEPLAY_QA`, never `COMPLETED` or Git finalization. A fully M7-verifiable PASS exits Play Mode, stops only an owned Editor, removes marker-verified bridge tooling, checks the final diff, invokes M2 one-commit squash, then transitions to `COMPLETED`. The task branch remains local; no code path merges or pushes, and the original worktree remains outside every write/fix/finalization operation.

## Planned M8 architecture

The following boundary guides M8. M0-M7 described above are implemented; player-like gameplay QA is not.

### Local application boundary

UnityAI runs as its own local application. A selected Unity game is an external target identified by an absolute filesystem path. Target-specific state must not leak into global application definitions. The reusable Unity-side package is temporary tooling copied into a managed task worktree; it does not embed the orchestrator in a game.

### Web application

The React application presents project selection, task drafting, contract approval, blocked-task actions, implementation progress, Unity tooling, QA evidence/batches, gameplay-pending state, and completed commit details. It sends commands over ordinary HTTP and polls progress. M8 may extend it with player-level evidence without changing the local application boundary.

### Local server

The server will coordinate application use cases, persistence, process execution, and external adapters. It remains a lightweight local Node.js service rather than a cloud or microservice system.

### Core domain

Core types and rules now describe tasks, lifecycle state, Task Contracts, feasibility, approval, QA sessions/results/evidence/findings, and fix results. Domain code does not import a concrete AI provider, Unity bridge, web framework, filesystem, or Git implementation.

### Agent, model, and provider boundary

An agent definition owns role, instructions, permissions, tools, context rules, and expected output schema. Separately replaceable configuration defines provider/model/effort assignments for selected task strengths. M3 provider adapters translate explicit provider-neutral requests to Codex or Claude. M4 consumes routing records without placing model IDs in agent definitions; changing a provider model name does not change agent behavior.

### Target project adapters

The filesystem/native-Git adapter inspects external repositories and safely modifies only verified managed task worktrees. The Unity adapter and reusable Unity-side bridge expose bounded project structure, compilation evidence, Editor state, Play Mode control, console data, and read-only scene/object snapshots. M2 records one task as the write owner. M7 consumes these capabilities for non-input QA; M8 may add player-input and visual evidence without adding arbitrary bridge execution.

### Persistence and configuration

Task and AI execution persistence use plain JSON/log files under a local runtime-data location. Model routing and provider settings live in configuration rather than repeated conditionals. A database is not planned until demonstrated need justifies one.

## Dependency direction

Later code should keep dependencies pointing inward:

```text
web -> shared contracts
server -> core domain + shared contracts + Unity capability package
unity-mcp -> Unity bridge client/protocol
provider/Git adapters -> core-defined types and use cases
core domain -> no concrete adapter
```

This is a boundary guideline, not a request to create empty interfaces before a milestone needs them.

## Simplicity constraints

Do not introduce plugin marketplaces, distributed workers, cloud infrastructure, microservices, event sourcing, elaborate permission engines, large persistence frameworks, or speculative design patterns. Add an abstraction only when current milestone behavior needs it.
