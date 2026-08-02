# UnityAI agent instructions

- Read `README.md` and the relevant files in `docs/` before implementation.
- Respect the current milestone boundary in `docs/ROADMAP.md`; do not preimplement later milestones.
- Keep UnityAI independent of any individual Unity project. Game projects are external filesystem targets.
- Keep agent definitions separate from model/provider configuration.
- Keep provider-specific CLI arguments inside provider adapters; never expose arbitrary process execution over HTTP.
- Preserve M4's two-call analysis boundary: Interpreter, then Feasibility; strength, routing, and Task Contract construction are deterministic application code.
- Keep target-project analysis read-only and never begin implementation before Task Contract approval and an explicit implementation start.
- Run writing agents only in verified M2-managed task worktrees; reviewers remain read-only.
- M5 stops at `READY_FOR_QA`: do not run QA, automatic fixes, Git finalization, merge, or push.
- Prefer simple, readable TypeScript and avoid speculative abstractions.
- Do not modify unrelated files, discard user work, or rewrite Git history.
- Preserve useful existing code and configuration.
- Run lightweight, relevant validation after changes.
- Never push unless the user explicitly requests it.
- Report unresolved product decisions instead of inventing major behavior.
