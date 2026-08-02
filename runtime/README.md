# Runtime data

M1 stores local task state under `tasks/TASK-0001/task.json`. M2 stores validated Git ownership/environment metadata beside it as `tasks/TASK-0001/git.json` and places the external project's dedicated linked worktree under `worktrees/TASK-0001/`.

M3 development executions are stored under `ai/runs/RUN-<UUID>/` with metadata-only `request.json`, normalized `result.json`, and bounded/redacted `stdout.log` and `stderr.log`. Raw prompts, context, provider environment variables, and authentication credentials are not persisted.

M4 stores validated analysis records under `tasks/TASK-0001/analysis/`: `interpretation.json`, `feasibility.json`, `routing.json`, `contract.json`, and `failure.json` when analysis fails technically. Interpretation and feasibility records retain the corresponding global AI run IDs without duplicating raw provider logs into task state.

Generated runtime contents remain ignored by Git.

Set `UNITYAI_RUNTIME_PATH` to redirect runtime data, including for isolated development and test sessions.
