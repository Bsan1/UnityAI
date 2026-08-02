# UnityAI

UnityAI is the foundation of a standalone, local AI development orchestrator for Unity game projects. A single UnityAI installation will eventually operate on different external projects selected by filesystem path; it is not embedded in a particular game.

## Current status

The repository is at **M0 - Foundation**. It currently provides only:

- an npm workspace;
- a minimal Node.js/TypeScript HTTP server with `GET /health`;
- a minimal React/Vite page that checks server reachability;
- small `core` and `shared` TypeScript packages; and
- product and architecture documentation.

Task orchestration, AI providers, Git automation, Unity integration, Task Contracts, and QA flows are intentionally not implemented yet.

## Requirements

- Node.js 22.12 or newer
- npm 10 or newer

## Get started

```bash
npm install
npm run typecheck
npm run build
```

For local development, run these in separate terminals:

```bash
npm run dev:server
npm run dev:web
```

The server listens on `http://127.0.0.1:3000` by default. The Vite development server proxies `/health` to it. Set `UNITYAI_PORT` to change the server port; if that port changes, update the development proxy configuration accordingly.

## Documentation

- [Product specification](docs/PRODUCT_SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Product decisions](docs/DECISIONS.md)
- [Model routing](docs/MODEL_ROUTING.md)
- [Roadmap](docs/ROADMAP.md)
