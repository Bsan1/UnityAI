# Roadmap

**M1 - Core Task and State Pipeline is complete. M2 - Git Safety Layer is next.** Milestones describe bounded increments; completing one does not authorize implementation of the next.

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

## M2 - Git Safety Layer (next)

**Goal:** Add a safe native-Git boundary for external target repositories.

**Major deliverables:** Repository discovery and status inspection; base commit recording; task branch/worktree setup; single-writer ownership; checkpoints, diffs, rollback primitives, and safe cleanup; Git integration tests in temporary repositories.

**Explicit non-goals:** AI implementation, Unity integration, feasibility, Task Contracts, QA, and automatic final workflow decisions.

**Completion criteria:** Supported repository states are detected; one writer is enforced; task isolation and rollback are verified; unrelated changes are preserved; nothing pushes remotely.

## M3 - AI Provider and Agent Abstraction

**Goal:** Execute provider-neutral agent definitions using replaceable model routing.

**Major deliverables:** Concrete agent definition format; provider-neutral request/result boundary; Codex adapter; Claude adapter or a clearly isolated unavailable-provider state; configuration-backed routing; structured-output validation.

**Explicit non-goals:** Full feasibility/contract pipeline, autonomous code changes, Unity communication, QA loop, dynamic escalation, and additional provider marketplace behavior.

**Completion criteria:** The same test agent runs through configured providers without definition changes; every documented routing case resolves; provider errors remain adapter-local; no runtime escalation occurs.

## M4 - Analysis, Feasibility and Task Contract Pipeline

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
