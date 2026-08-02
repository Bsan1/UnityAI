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

M4 now consumes these routing records. The Interpreter always uses its `ALL` route. Deterministic preliminary strength selects exactly one configured Feasibility model/effort. After feasibility, deterministic final strength produces a per-task execution snapshot for Implementation, QA, Fix, and optional Cross Review. Fix is copied exactly from Implementation. Cross Review is present only when the task's persisted boolean is `true`.

The snapshot is planning data only; M4 does not execute those future phases. A blocked recheck may replace the unapproved proposed snapshot. Approval persists the task's snapshot, so later global configuration changes do not silently rewrite the approved plan. There is still no runtime escalation, automatic cost policy, or model selection outside these explicit records.
