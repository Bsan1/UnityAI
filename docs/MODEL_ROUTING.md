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

When Cross Review is `ON`, the initial intended reviewer is Claude Sonnet through the configured Claude provider. M3 supplies the provider capability only; the cross-review workflow remains future work. Cross Review defaults to `ON` and has no third mode.

## Configuration rule

These values now live in `config/models.json` as model aliases plus declarative routing records. Provider executable settings live separately in `config/providers.json`, and agent behavior lives under `agents/`. Changing `providerModelName` or a routing record does not require changing an agent definition.

M3 validates and exposes routing records but does not execute them or choose a model from task strength. The `/ai/execute` development endpoint requires an explicit model ID and effort. M4 will consume the configuration when it adds interpretation and feasibility orchestration; there is still no runtime escalation or automatic cost policy.
