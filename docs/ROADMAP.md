# Roadmap

**M3 - AI Provider and Agent Abstraction is complete. M4 - Analysis, Feasibility and Task Contract Pipeline is next.** Milestones describe bounded increments; completing one does not authorize implementation of the next.

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

## M4 - Analysis, Feasibility and Task Contract Pipeline (next)

**Goal:** Turn a user request and current target state into an honest, reviewable Task Contract.

**Major deliverables:** Interpretation; target inspection inputs; feasibility and prerequisite classification; contract generation; explicit approval gate; editable prerequisite drafts; pause, recheck, and cancel behavior.

**Explicit non-goals:** General implementation execution, polished UI, Unity runtime bridge, automatic fixes, and player-level QA.

**Completion criteria:** Implementation cannot begin without approval; missing architecture is reported rather than bypassed; recheck reads current state; blocked actions preserve intended task state.

## M5 - Basic User Interface and End-to-End Orchestrator Flow

**Goal:** Provide a usable local interface for project selection through approved implementation and result review.

**Major deliverables:** External project selection; task editor; strength and binary settings; contract review/approval; progress transport; orchestration of M1-M4 and Git safety; basic implementation-agent execution; result/diff view.

**Explicit non-goals:** Unity-specific deep inspection, complete QA hierarchy, automatic fix loop, advanced visual design, authentication, and cloud deployment.

**Completion criteria:** A user can select a Git-backed target, approve a contract, run one safe implementation task, inspect its result, and retain full control over finalization without Unity-specific automation.

## M6 - Unity Project Adapter and Unity Bridge

**Goal:** Add reusable, project-independent Unity inspection and control capabilities.

**Major deliverables:** Unity project detection; reusable Unity package/bridge; editor/project metadata and structural inspection; compile and console access; scenes/prefabs/components/configuration queries; documented version compatibility.

**Explicit non-goals:** Complete automatic-fix loop, player-like gameplay testing, arbitrary per-game hacks, and embedding UnityAI in one project.

**Completion criteria:** The same UnityAI installation connects to multiple sample projects; bridge setup is explicit and reusable; structural evidence and compiler results are returned reliably.

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
