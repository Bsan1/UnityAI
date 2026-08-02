# Runtime data

M1 stores local task state under `tasks/TASK-0001/task.json`. M2 stores validated Git ownership/environment metadata beside it as `tasks/TASK-0001/git.json` and places the external project's dedicated linked worktree under `worktrees/TASK-0001/`. Generated contents remain ignored by Git.

Set `UNITYAI_RUNTIME_PATH` to redirect runtime data, including for isolated development and test sessions.
