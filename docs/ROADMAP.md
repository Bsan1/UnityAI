# Roadmap

**M6 - Unity Project Adapter and Unity Bridge is complete. M7 - QA and Automatic Fix Loop is next.** Milestones describe bounded increments; completing one does not authorize implementation of the next.

## M0 - Foundation (completed)

**Goal:** Establish a clean, project-independent TypeScript application foundation and record fixed product decisions.

**Major deliverables:** npm workspaces; strict TypeScript baseline; minimal local health server; minimal React/Vite connectivity page; core/shared packages; config/runtime locations; repository guidance and product, architecture, decisions, routing, and roadmap documents.

**Explicit non-goals:** Task state, Git automation, AI agents/providers, project analysis, Task Contracts, Unity communication, QA, automatic fixes, and production UI.

**Completion criteria:** Dependencies install; all workspaces type-check and build; the server returns a successful `/health` response; the web production build succeeds; documentation reflects fixed decisions; changes are captured in one local commit when safe.

## M1 - Core Task and State Pipeline (completed)

**Goal:** Represent tasks and their local lifecycle with simple JSON-backed state.

**Major deliverables:** Task identifiers and records; lifecycle states and legal transitions; task strength and binary option values; pause/resume, blocked-task actions, cancellation, feasibility-result and Task Contract schemas; approval gating; event history; JSON persistence with safe writes and boundary validation; minimal HTTP API; focused domain and persistence tests.

**Explicit non-goals:** Git mutations, AI calls, real interpretation or feasibility analysis, AI-generated Task Contracts, implementation execution, Unity access, full UI, and QA execution.

**Completion criteria:** Tasks can be created, loaded, updated through valid transitions, paused, resumed, rechecked, and cancelled; prerequisite drafts remain editable and inactive; contract approval gates implementation readiness; invalid transitions and persisted data are rejected; restart persistence and ID continuation are tested.

## M2 - Git Safety Layer (completed)

**Goal:** Add a safe native-Git boundary for external target repositories.

**Major deliverables:** Repository discovery and clean/dirty inspection; base branch/commit recording; deterministic task branch/worktree setup; persisted single-task write ownership; status/diff reporting; checkpoint commits; path-guarded rollback; one-commit task-branch finalization; guarded worktree cleanup; JSON metadata validation; isolated Git integration tests.

**Explicit non-goals:** AI/provider/agent execution, model routing execution, Unity integration, feasibility execution, QA, automatic task implementation/fixes, original-branch merge, push, pull request, remote management, automatic stash, and production Git UI.

**Completion criteria:** Supported repository states are detected; dirty originals are rejected untouched; one task owns each managed worktree; prepare is safely idempotent; status/diff, checkpoints, rollback, final squash, cleanup, and metadata reload are verified in temporary repositories; original branches/worktrees remain unchanged; nothing merges or pushes.

## M3 - AI Provider and Agent Abstraction (completed)

**Goal:** Execute provider-neutral agent definitions using replaceable model routing.

**Major deliverables:** File-backed agent definition format; minimal read-only/worktree-write metadata; replaceable provider/model/routing configuration; provider registry; real non-interactive Codex and Claude CLI adapters; safe process runner; explicit AgentExecutor; JSON Schema validation; timeout/cancellation; bounded redacted run artifacts; minimal discovery/execution API; deterministic provider fakes and process tests.

**Explicit non-goals:** Task interpretation, feasibility/contract generation, task-strength model selection, automatic routing/escalation, cross-review or implementation orchestration, Unity communication, QA/fix loops, provider marketplace behavior, and production AI UI.

**Completion criteria:** The same test agent runs through two providers without definition changes; configured models resolve providers and all documented routes validate; CLI arguments remain adapter-local; structured success/failure, provider/process failures, timeout/cancellation, log bounding/redaction, and artifacts are deterministic; available local providers pass one minimal read-only smoke; no task pipeline or runtime escalation exists.

## M4 - Analysis, Feasibility and Task Contract Pipeline (completed)

**Goal:** Turn a user request and current target state into an honest, reviewable Task Contract.

**Major deliverables:** Production read-only Interpreter and Feasibility agents; two-call first analysis; deterministic preliminary/final strength; configured feasibility selection; persisted routing snapshot; deterministic evidence-oriented Task Contract; editable unapproved planning content; technical failure records; per-task concurrency guard; current-target read-only verification; one-call feasibility recheck; existing prerequisite, pause, and cancel behavior.

**Explicit non-goals:** Git environment preparation after approval; implementation/review/QA/fix execution; cross-review orchestration; dependency installation; polished UI; Unity runtime bridge; automatic fixes; and player-level QA.

**Completion criteria:** First analysis runs Interpreter then Feasibility without a contract-generator call; current target evidence and missing architecture determine `WAITING_FOR_APPROVAL` or `BLOCKED`; deterministic strength/routing/contract artifacts persist and reload; approval alone unlocks implementation readiness; recheck reads current state while reusing valid interpretation; technical failures remain failures; read-only and concurrency invariants are tested.

## M5 - Basic User Interface and End-to-End Orchestrator Flow (completed)

**Goal:** Provide a usable local interface for project selection through approved implementation and result review.

**Major deliverables:** Persistent external Git project registry; binary default controls; task history/editor; contract and blocked-task views; polling progress/events; background approval-gated Implementation execution in the M2 worktree; implementation checkpoint; optional read-only Cross Review; persisted phase results; explicit `READY_FOR_QA` state and result view.

**Explicit non-goals:** Unity-specific deep inspection or communication; QA execution; automatic or review-fix loops; Git finalization/merge/push; advanced visual design; authentication; database; and cloud deployment.

**Completion criteria:** A user can register/select a Git target, analyze and edit/approve a contract, run one implementation only in its managed worktree, checkpoint changes, optionally receive a read-only cross-model review, inspect progress/results, and stop at `READY_FOR_QA`; dirty originals and failures remain safe, no model escalates, and no history is finalized, merged, or pushed.

## M6 - Unity Project Adapter and Unity Bridge (completed)

**Goal:** Add reusable, project-independent Unity inspection and control capabilities.

**Major deliverables:** Bounded Unity project/version/package inspection; optional per-project Editor override and exact Hub resolution; reusable temporary embedded Editor bridge with ownership marker; authenticated loopback protocol and main-thread queue; explicit Editor/compile/Play Mode/console/scene/hierarchy/object commands; reusable Node client; owned Editor launch/stop and restart revalidation; JSON lifecycle metadata; minimal HTTP/UI status controls; explicit stdio Unity MCP tools.

**Explicit non-goals:** QA planning or pass/fail decisions; automatic fixes; input injection; screenshots/vision; runtime probe framework; player-like gameplay testing; arbitrary C#/reflection/menu/filesystem/shell execution; asset/scene editing; package/Editor downloading; final Git commit, merge, or push.

**Completion criteria:** Valid/invalid projects and Editors resolve deterministically; bridge setup/removal can target only marker-verified M2 worktrees; original worktrees remain untouched; descriptors authenticate and cannot cross projects or use non-loopback hosts; fake transport/process/MCP coverage passes; the Editor package compiles and all commands, Play Mode transitions, and MCP ping/status succeed in one disposable live Unity project; temporary tooling is excluded from checkpoints and removed safely.

## M7 - QA and Automatic Fix Loop

**Goal:** Run complete available QA sessions, batch failures, and optionally perform controlled fixes and reruns.

**Major deliverables:** QA0-QA2 planning/execution; evidence records; continue-when-reasonable behavior; batched failure reports; `ON`/`OFF` Automatic Fixes; localized fix eligibility; full-session rerun; final commit gating.

**Explicit non-goals:** Broad QA3 player cognition, silent architectural changes, runtime model escalation, and unlimited retry loops.

**Completion criteria:** Multiple independent failures are collected in one run; fixes use the selected implementation model/effort; ambiguous or repeated failures return control; successful complete reruns can authorize a final local commit.

## M8 - Player-Level Gameplay QA

**Goal:** Validate requested gameplay behavior from a player-like perspective using observable evidence.

**Major deliverables:** QA3 scenario plans derived from acceptance criteria; input-driving support; Game View capture; runtime probes and state correlation; gameplay evidence reports; clear limits for unsupported judgments.

**Explicit non-goals:** General game-playing intelligence, unbounded autonomous exploration, replacing human creative judgment, and cloud test farms.

**Completion criteria:** Representative gameplay tasks can be exercised through inputs; outcomes are tied to acceptance criteria and evidence; inconclusive results are reported honestly; QA3 participates in the existing batched QA/fix flow.
