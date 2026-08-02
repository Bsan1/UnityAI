# UnityAI

UnityAI is the foundation of a standalone, local AI development orchestrator for Unity game projects. A single UnityAI installation will eventually operate on different external projects selected by filesystem path; it is not embedded in a particular game.

## Current status

The repository has completed **M1 - Core Task and State Pipeline**. It currently provides:

- an npm workspace;
- a strict core task model with explicit lifecycle transitions and audit history;
- JSON-backed task persistence with restart-safe `TASK-0001` IDs;
- a minimal Node.js/TypeScript HTTP server with health and task APIs;
- a minimal React/Vite page that checks server reachability;
- small `core` and `shared` TypeScript packages; and
- product and architecture documentation.

M1 can store supplied feasibility results and Task Contracts so the state pipeline can be tested. It does not perform real interpretation or feasibility analysis. AI providers, Git automation, Unity integration, implementation execution, QA, automatic fixes, and the production task UI are intentionally not implemented yet. M2 is the next milestone.

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

The server listens on `http://127.0.0.1:3000` by default. The Vite development server proxies `/health` to it. Set `UNITYAI_PORT` to change the server port, `UNITYAI_RUNTIME_PATH` to use a different runtime-data directory, or `UNITYAI_CONFIG_PATH` to load different task defaults.

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

## Persistence

Tasks are stored as `runtime/tasks/TASK-0001/task.json`. Writes use a temporary file followed by a same-directory rename. Persisted content is validated on read, and an invalid task prevents the store from silently starting with bad data.

## Documentation

- [Product specification](docs/PRODUCT_SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Product decisions](docs/DECISIONS.md)
- [Model routing](docs/MODEL_ROUTING.md)
- [Roadmap](docs/ROADMAP.md)
