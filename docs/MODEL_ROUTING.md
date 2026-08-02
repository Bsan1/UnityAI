# Model routing

Model routing is replaceable configuration. Agent definitions remain stable when provider, model, or effort assignments change. There is no runtime escalation after failure and no Economy/Balanced/Quality cost policy.

## Initial intended routing

| Agent/work | Task strength | Provider/model | Effort |
| --- | --- | --- | --- |
| Interpreter | All | GPT-5.6 Terra | Medium |
| Feasibility | LIGHT | GPT-5.6 Terra | Medium |
| Implementation | LIGHT | GPT-5.6 Terra | High |
| QA reasoning | LIGHT | GPT-5.6 Terra | Medium |
| Feasibility | STANDARD | GPT-5.6 Terra | High |
| Implementation | STANDARD | GPT-5.6 Sol | Medium |
| QA reasoning | STANDARD | GPT-5.6 Sol | Medium |
| Feasibility | STRONG | GPT-5.6 Sol | High |
| Implementation | STRONG | GPT-5.6 Sol | High |
| QA reasoning | STRONG | GPT-5.6 Sol | High |

Fix work uses the exact implementation model and effort selected for the task.

When Cross Review is `ON`, the initial intended reviewer is Claude Sonnet through a future Claude provider. Cross Review defaults to `ON` and has no third mode.

## Configuration rule

These values will eventually live in configuration loaded by the orchestrator. They must not be copied into agent prompts or spread across application conditionals. Model availability changes are handled by manually revising routing configuration, not by changing agent identity or escalating during a task.

The repository records this decision, but M1 does not implement model loading, providers, agents, or routing.
