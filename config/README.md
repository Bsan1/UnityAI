# Configuration

This directory contains version-controlled application defaults. M1 loads `defaults.json` when the local server starts. New tasks copy these values, so later default changes do not rewrite existing tasks.

M3 loads `models.json` and `providers.json` at server startup. `models.json` owns stable model aliases, provider model names, supported effort values, and declarative routing records. `providers.json` owns local CLI executable names, enablement, the default execution timeout, and the persisted-log size limit. M4 consumes the routing table for Interpreter, preliminary-strength Feasibility, and final per-task execution snapshots. Agent definitions remain independent files under `agents/`.

Secrets and machine-specific values must not be committed here.
