import * as React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  GlobalSettings,
  HealthResponse,
  ProjectRecord,
  Task,
  TaskContract,
  TaskDetailsResponse,
} from "@unityai/shared";

import { ApiError, api, userMessageForError } from "./api.js";

type ConnectionState =
  | { status: "checking" }
  | { status: "connected"; health: HealthResponse }
  | { status: "unavailable" };

const displayTime = (timestamp: string): string =>
  new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));

const stateLabel = (state: Task["state"]): string =>
  state.replaceAll("_", " ").toLocaleLowerCase("en-US").replace(/^./u, (letter) => letter.toUpperCase());

const lines = (value: string): readonly string[] =>
  value
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly hint?: string;
}) {
  return (
    <label className="toggle-row">
      <span>
        <strong>{label}</strong>
        {hint === undefined ? null : <small>{hint}</small>}
      </span>
      <button
        type="button"
        className={`toggle ${checked ? "on" : "off"}`}
        aria-pressed={checked}
        onClick={() => onChange(!checked)}
      >
        {checked ? "ON" : "OFF"}
      </button>
    </label>
  );
}

function ProjectForm({
  onAdd,
  busy,
}: {
  readonly onAdd: (displayName: string, path: string) => Promise<void>;
  readonly busy: boolean;
}) {
  const [displayName, setDisplayName] = useState("");
  const [path, setPath] = useState("");
  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        void onAdd(displayName, path).then(() => {
          setDisplayName("");
          setPath("");
        });
      }}
    >
      <label>
        Project name
        <input
          required
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="Tower Defense"
        />
      </label>
      <label>
        Project path
        <input
          required
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="D:\\Games\\TowerDefense"
        />
      </label>
      <button className="primary" disabled={busy} type="submit">
        Add project
      </button>
    </form>
  );
}

function ContractEditor({
  contract,
  busy,
  onCancel,
  onSave,
}: {
  readonly contract: TaskContract;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSave: (patch: unknown) => Promise<void>;
}) {
  const [explicit, setExplicit] = useState(contract.understoodExplicitRequirements.join("\n"));
  const [inferred, setInferred] = useState(contract.inferredRequirements.join("\n"));
  const [prerequisites, setPrerequisites] = useState(contract.prerequisites.join("\n"));
  const [scope, setScope] = useState(contract.implementationScope.join("\n"));
  const [nonGoals, setNonGoals] = useState(contract.nonGoals.join("\n"));
  const [criteria, setCriteria] = useState(
    (contract.acceptanceCriteriaDetails ?? []).map((entry) => entry.description).join("\n"),
  );
  const [tests, setTests] = useState(
    (contract.testRequirementDetails ?? []).map((entry) => `${entry.category}: ${entry.description}`).join("\n"),
  );

  const submit = async () => {
    const criterionLines = lines(criteria);
    const testLines = lines(tests);
    await onSave({
      understoodExplicitRequirements: lines(explicit),
      inferredRequirements: lines(inferred),
      prerequisites: lines(prerequisites),
      implementationScope: lines(scope),
      nonGoals: lines(nonGoals),
      acceptanceCriteriaDetails: criterionLines.map((description, index) => ({
        id: `AC-${String(index + 1).padStart(3, "0")}`,
        description,
        evidenceExpectation:
          contract.acceptanceCriteriaDetails?.[index]?.evidenceExpectation ?? [
            "Retain concrete evidence that demonstrates this behavior.",
          ],
      })),
      testRequirementDetails: testLines.map((entry, index) => {
        const match = /^(STATIC|STRUCTURAL|RUNTIME|GAMEPLAY):\s*(.+)$/u.exec(entry);
        return {
          id: `TEST-${String(index + 1).padStart(3, "0")}`,
          category: match?.[1] ?? "STATIC",
          description: match?.[2] ?? entry,
        };
      }),
    });
  };

  return (
    <section className="panel stack" aria-labelledby="contract-editor-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Editable until approval</p>
          <h2 id="contract-editor-title">Edit Task Contract</h2>
        </div>
      </div>
      {[
        ["Explicit requirements", explicit, setExplicit],
        ["Inferred requirements", inferred, setInferred],
        ["Prerequisites", prerequisites, setPrerequisites],
        ["Implementation scope", scope, setScope],
        ["Non-goals", nonGoals, setNonGoals],
        ["Acceptance criteria (one per line)", criteria, setCriteria],
        ["Tests (CATEGORY: description)", tests, setTests],
      ].map(([label, value, setter]) => (
        <label key={label as string}>
          {label as string}
          <textarea
            rows={4}
            value={value as string}
            onChange={(event) => (setter as (value: string) => void)(event.target.value)}
          />
        </label>
      ))}
      <div className="actions">
        <button className="primary" disabled={busy} type="button" onClick={() => void submit()}>
          Save contract
        </button>
        <button disabled={busy} type="button" onClick={onCancel}>
          Cancel edit
        </button>
      </div>
    </section>
  );
}

function ContractView({ details }: { readonly details: TaskDetailsResponse }) {
  const { task, analysis } = details;
  const contract = task.taskContract;
  if (contract === undefined) {
    return null;
  }
  const routing = contract.executionPlan;
  return (
    <div className="contract-grid">
      <section className="panel span-two">
        <p className="eyebrow">Task</p>
        <h2>{contract.originalTaskSummary ?? task.originalRequest}</h2>
      </section>
      <section className="panel">
        <h3>What I understood</h3>
        <h4>Explicit</h4>
        <BulletList items={contract.understoodExplicitRequirements} />
        <h4>Inferred</h4>
        <BulletList items={contract.inferredRequirements} />
      </section>
      <section className="panel">
        <h3>Project / feasibility</h3>
        <p>{analysis?.feasibility?.result.summary ?? task.feasibility?.summary}</p>
        <BulletList items={analysis?.feasibility?.result.existingCapabilities ?? []} />
        {analysis?.feasibility?.result.evidence.map((item) => (
          <p className="evidence" key={`${item.location}-${item.observation}`}>
            <code>{item.location}</code> {item.observation}
          </p>
        ))}
      </section>
      <section className="panel">
        <h3>Implementation</h3>
        <BulletList items={contract.implementationScope} />
        <h4>Non-goals</h4>
        <BulletList items={contract.nonGoals} />
      </section>
      <section className="panel">
        <h3>Acceptance criteria</h3>
        {(contract.acceptanceCriteriaDetails ?? []).map((criterion) => (
          <article className="criterion" key={criterion.id}>
            <strong>{criterion.id}</strong> {criterion.description}
            <small>Evidence: {criterion.evidenceExpectation.join(" · ")}</small>
          </article>
        ))}
      </section>
      <section className="panel">
        <h3>Test plan</h3>
        {(contract.testRequirementDetails ?? []).map((test) => (
          <p key={test.id}>
            <span className="tag">{test.category}</span> {test.description}
          </p>
        ))}
      </section>
      <section className="panel execution-card">
        <h3>Execution plan</h3>
        <p><strong>Strength</strong> <span className="strength">{contract.taskStrength}</span></p>
        <p><strong>Implementation</strong><br />{routing?.implementation.providerId} / {routing?.implementation.modelId} · {routing?.implementation.effort}</p>
        <p><strong>Review</strong><br />{routing?.review.enabled ? `${routing.review.plan.providerId} / ${routing.review.plan.modelId} · ${routing.review.plan.effort ?? "not configured"}` : "OFF"}</p>
        <p><strong>QA plan</strong><br />{routing?.qa.providerId} / {routing?.qa.modelId} · {routing?.qa.effort}</p>
      </section>
    </div>
  );
}

function BulletList({ items }: { readonly items: readonly string[] }) {
  if (items.length === 0) {
    return <p className="muted">None</p>;
  }
  return <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>;
}

function Progress({ details }: { readonly details: TaskDetailsResponse }) {
  return (
    <section className="panel progress-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Pipeline progress</p>
          <h2>{details.task.id} — {details.task.title ?? "Untitled task"}</h2>
        </div>
        {details.progress.active ? <span className="live-pill">Running</span> : null}
      </div>
      <ol className="pipeline">
        {details.progress.steps.map((entry) => (
          <li data-step-status={entry.status} key={entry.id}>
            <span aria-hidden="true">
              {entry.status === "COMPLETE" ? "✓" : entry.status === "CURRENT" ? "●" : entry.status === "FAILED" ? "!" : "○"}
            </span>
            {entry.label}
            {entry.status === "SKIPPED" ? <small>OFF</small> : null}
          </li>
        ))}
      </ol>
      <div className="event-log" aria-label="Task events">
        {details.progress.events.slice(-10).reverse().map((event, index) => (
          <p key={`${event.timestamp}-${event.type}-${index}`}>
            <time>{displayTime(event.timestamp)}</time>
            {event.type.replaceAll("_", " ").toLocaleLowerCase("en-US")}
          </p>
        ))}
      </div>
    </section>
  );
}

export function App() {
  const [connection, setConnection] = useState<ConnectionState>({ status: "checking" });
  const [projects, setProjects] = useState<readonly ProjectRecord[]>([]);
  const [tasks, setTasks] = useState<readonly Task[]>([]);
  const [settings, setSettings] = useState<GlobalSettings>({
    crossReviewEnabled: true,
    automaticFixesEnabled: true,
  });
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>();
  const [details, setDetails] = useState<TaskDetailsResponse | undefined>();
  const [taskRequest, setTaskRequest] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [showContractEditor, setShowContractEditor] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const refreshLists = useCallback(async () => {
    const [nextProjects, nextTasks, nextSettings] = await Promise.all([
      api.listProjects(),
      api.listTasks(),
      api.getSettings(),
    ]);
    setProjects(nextProjects);
    setTasks(nextTasks);
    setSettings(nextSettings);
    setSelectedProjectId((current) =>
      current.length > 0 && nextProjects.some((project) => project.id === current)
        ? current
        : nextProjects[0]?.id ?? "",
    );
  }, []);

  const loadDetails = useCallback(async (id: string) => {
    const next = await api.getDetails(id);
    setDetails(next);
    setTasks((current) => current.map((task) => task.id === next.task.id ? next.task : task));
    return next;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void api.health()
      .then((health) => {
        if (!controller.signal.aborted) {
          setConnection({ status: "connected", health });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setConnection({ status: "unavailable" });
        }
      });
    void refreshLists().catch((caught) => setError(userMessageForError(caught)));
    return () => controller.abort();
  }, [refreshLists]);

  useEffect(() => {
    if (selectedTaskId === undefined) {
      setDetails(undefined);
      return;
    }
    void loadDetails(selectedTaskId).catch((caught) => setError(userMessageForError(caught)));
  }, [loadDetails, selectedTaskId]);

  useEffect(() => {
    if (
      selectedTaskId === undefined ||
      (details?.progress.active !== true &&
        details?.task.state !== "IMPLEMENTING" &&
        details?.task.state !== "REVIEWING")
    ) {
      return;
    }
    const interval = window.setInterval(() => {
      void loadDetails(selectedTaskId).then(() => refreshLists()).catch((caught) => {
        setError(userMessageForError(caught));
      });
    }, 1500);
    return () => window.clearInterval(interval);
  }, [details?.progress.active, details?.task.state, loadDetails, refreshLists, selectedTaskId]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId),
    [projects, selectedProjectId],
  );

  const run = async (action: () => Promise<unknown>, refresh = true) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      if (refresh) {
        await refreshLists();
        if (selectedTaskId !== undefined) {
          await loadDetails(selectedTaskId);
        }
      }
    } catch (caught: unknown) {
      setError(userMessageForError(caught));
    } finally {
      setBusy(false);
    }
  };

  const addProject = async (displayName: string, path: string) => {
    await run(async () => {
      const project = await api.createProject({ displayName, path });
      await refreshLists();
      setSelectedProjectId(project.id);
      setShowProjectForm(false);
    }, false);
  };

  const createTask = async () => {
    if (selectedProject === undefined) {
      setError("Add and select a Git project first.");
      return;
    }
    await run(async () => {
      const task = await api.createTask({
        projectId: selectedProject.id,
        originalRequest: taskRequest,
        ...(taskTitle.trim().length === 0 ? {} : { title: taskTitle.trim() }),
      });
      setTaskRequest("");
      setTaskTitle("");
      await refreshLists();
      setSelectedTaskId(task.id);
    }, false);
  };

  const setDefault = async (patch: Partial<GlobalSettings>) => {
    await run(async () => setSettings(await api.updateSettings(patch)), false);
  };

  const selectedState = details?.task.state;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <header className="brand">
          <div className="brand-mark">U</div>
          <div>
            <h1>UnityAI</h1>
            <p>Local development orchestrator</p>
          </div>
        </header>
        <div className={`connection ${connection.status}`}>
          <span /> Server {connection.status === "connected" ? "Connected" : connection.status === "checking" ? "Checking" : "Unavailable"}
          {connection.status === "connected" ? <small>{connection.health.milestone}</small> : null}
        </div>
        <section className="sidebar-section">
          <div className="sidebar-heading">
            <span>Project</span>
            <button className="text-button" type="button" onClick={() => setShowProjectForm((value) => !value)}>Manage</button>
          </div>
          <select
            aria-label="Selected project"
            value={selectedProjectId}
            onChange={(event) => setSelectedProjectId(event.target.value)}
          >
            {projects.length === 0 ? <option value="">No projects</option> : null}
            {projects.map((project) => <option value={project.id} key={project.id}>{project.displayName}</option>)}
          </select>
        </section>
        <section className="sidebar-section task-history">
          <div className="sidebar-heading">
            <span>Task history</span>
            <button className="text-button" type="button" onClick={() => setSelectedTaskId(undefined)}>New</button>
          </div>
          <nav aria-label="Task history">
            {[...tasks].reverse().map((task) => (
              <button
                className={selectedTaskId === task.id ? "task-link selected" : "task-link"}
                key={task.id}
                type="button"
                onClick={() => setSelectedTaskId(task.id)}
              >
                <span><strong>{task.id}</strong><small>{stateLabel(task.state)}</small></span>
                <em>{task.title ?? task.originalRequest}</em>
                <time>{displayTime(task.updatedAt)}</time>
              </button>
            ))}
          </nav>
        </section>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{selectedProject?.displayName ?? "No project selected"}</p>
            <h2>{details?.task.title ?? (selectedTaskId === undefined ? "Create a development task" : details?.task.id ?? "Loading task")}</h2>
          </div>
          {details === undefined ? null : <span className={`state-badge state-${details.task.state.toLocaleLowerCase()}`}>{stateLabel(details.task.state)}</span>}
        </header>

        {error === undefined ? null : (
          <div className="error-banner" role="alert">
            <strong>Action needed</strong>
            <span>{error}</span>
            <button type="button" onClick={() => setError(undefined)}>Dismiss</button>
          </div>
        )}

        {showProjectForm || projects.length === 0 ? (
          <section className="panel project-manager">
            <div className="section-heading"><div><p className="eyebrow">Project registry</p><h2>Add a Git project</h2></div></div>
            <ProjectForm onAdd={addProject} busy={busy} />
            {projects.map((project) => (
              <div className="project-row" key={project.id}>
                <span><strong>{project.displayName}</strong><small>{project.path}</small></span>
                <button className="danger-text" type="button" onClick={() => void run(() => api.deleteProject(project.id))}>Remove record</button>
              </div>
            ))}
            <p className="notice">Removing a project here deletes only UnityAI metadata. Project files are never deleted.</p>
          </section>
        ) : null}

        {selectedTaskId === undefined ? (
          <div className="new-task-layout">
            <section className="panel task-composer">
              <p className="eyebrow">New task</p>
              <h2>What should UnityAI build?</h2>
              <label>
                Optional title
                <input value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} placeholder="Archer Tower" />
              </label>
              <label>
                Development task
                <textarea
                  rows={8}
                  required
                  value={taskRequest}
                  onChange={(event) => setTaskRequest(event.target.value)}
                  placeholder="Add a placeable Archer Tower that costs 100 gold and cannot overlap other buildings."
                />
              </label>
              <button
                className="primary large"
                disabled={busy || taskRequest.trim().length === 0 || selectedProject === undefined}
                type="button"
                onClick={() => void createTask()}
              >
                Create task
              </button>
            </section>
            <section className="panel settings-card">
              <p className="eyebrow">New task defaults</p>
              <h2>Simple controls</h2>
              <Toggle label="Cross Review" checked={settings.crossReviewEnabled} onChange={(checked) => void setDefault({ crossReviewEnabled: checked })} hint="Independent review after implementation" />
              <Toggle label="Automatic Fixes" checked={settings.automaticFixesEnabled} onChange={(checked) => void setDefault({ automaticFixesEnabled: checked })} hint="Will apply in the future QA/fix workflow" />
              <p className="notice">Existing tasks keep the settings they were created with.</p>
            </section>
          </div>
        ) : null}

        {details !== undefined ? (
          <>
            <Progress details={details} />

            {details.task.state === "DRAFT" ? (
              <DraftEditor
                task={details.task}
                busy={busy}
                onSave={(patch) => run(() => api.updateDraft(details.task.id, patch))}
                onSubmit={() => run(() => api.submitDraft(details.task.id))}
              />
            ) : null}

            {details.task.state === "CREATED" || (details.task.state === "FAILED" && details.task.analysisFailure !== undefined) ? (
              <section className="panel action-panel">
                <p className="eyebrow">Ready to plan</p>
                <h2>{details.task.originalRequest}</h2>
                <p>Analysis uses the Task Interpreter and one read-only Feasibility pass, then builds the contract deterministically.</p>
                <div className="actions">
                  <button className="primary" disabled={busy} type="button" onClick={() => void run(() => api.analyze(details.task.id))}>Analyze task</button>
                  <button disabled={busy} type="button" onClick={() => void run(() => api.cancel(details.task.id))}>Cancel</button>
                </div>
              </section>
            ) : null}

            {details.task.state === "ANALYZING" ? <section className="panel action-panel"><h2>Analyzing the current project…</h2><p>The project is being inspected read-only. No implementation has started.</p></section> : null}

            {details.task.state === "BLOCKED" || (details.task.state === "PAUSED" && details.task.pause?.previousState === "BLOCKED") ? (
              <BlockedView
                details={details}
                busy={busy}
                onPrerequisite={() => void run(async () => {
                  const draft = await api.prerequisiteDraft(details.task.id);
                  await refreshLists();
                  setSelectedTaskId(draft.id);
                }, false)}
                onPause={() => void run(() => api.pause(details.task.id))}
                onRecheck={() => void run(() => api.recheck(details.task.id))}
                onCancel={() => void run(() => api.cancel(details.task.id))}
              />
            ) : null}

            {details.task.state === "WAITING_FOR_APPROVAL" && details.task.taskContract !== undefined ? (
              showContractEditor ? (
                <ContractEditor
                  contract={details.task.taskContract}
                  busy={busy}
                  onCancel={() => setShowContractEditor(false)}
                  onSave={async (patch) => {
                    await run(() => api.editContract(details.task.id, patch));
                    setShowContractEditor(false);
                  }}
                />
              ) : (
                <>
                  <ContractView details={details} />
                  <section className="panel contract-actions">
                    <div><strong>Implementation is locked until you approve.</strong><small>Approval freezes this contract and routing snapshot.</small></div>
                    <div className="actions">
                      <button className="primary" disabled={busy} type="button" onClick={() => void run(() => api.approve(details.task.id))}>Approve &amp; continue</button>
                      <button disabled={busy} type="button" onClick={() => setShowContractEditor(true)}>Edit contract</button>
                      <button disabled={busy} type="button" onClick={() => void run(() => api.cancel(details.task.id))}>Cancel</button>
                    </div>
                  </section>
                </>
              )
            ) : null}

            {selectedState === "READY_FOR_IMPLEMENTATION" ? (
              <>
                {details.orchestration.failure === undefined ? null : (
                  <section className="panel failure-card">
                    <p className="eyebrow">Start stopped safely · {details.orchestration.failure.code}</p>
                    <h2>Resolve this issue, then retry</h2>
                    <p>{userMessageForError(new ApiError(details.orchestration.failure.code, details.orchestration.failure.message))}</p>
                  </section>
                )}
                <section className="panel action-panel">
                  <p className="eyebrow">Approved and frozen</p>
                  <h2>Ready to implement safely</h2>
                  <p>Starting will verify the original worktree is clean, create the managed task worktree, and run the exact approved implementation route.</p>
                  <div className="actions">
                    <button className="primary" disabled={busy} type="button" onClick={() => void run(() => api.startImplementation(details.task.id))}>Start implementation</button>
                    <button disabled={busy} type="button" onClick={() => void run(() => api.cancel(details.task.id))}>Cancel</button>
                  </div>
                </section>
              </>
            ) : null}

            {selectedState === "IMPLEMENTING" || selectedState === "REVIEWING" ? (
              <section className="panel action-panel">
                <h2>{selectedState === "IMPLEMENTING" ? "Implementation is running" : "Cross Review is running"}</h2>
                <p>The managed worktree is preserved if this execution is interrupted. No Git finalization, merge, or push will occur.</p>
                <div className="actions">
                  <button disabled={busy} type="button" onClick={() => void run(() => api.pause(details.task.id))}>Pause safely</button>
                  <button disabled={busy} type="button" onClick={() => void run(() => api.cancel(details.task.id))}>Cancel execution</button>
                </div>
              </section>
            ) : null}

            {selectedState === "PAUSED" && details.task.pause?.previousState !== "BLOCKED" ? (
              <section className="panel action-panel">
                <p className="eyebrow">Paused safely</p>
                <h2>{details.task.pause?.previousState === "IMPLEMENTING" || details.task.pause?.previousState === "REVIEWING" ? "The provider process was stopped" : "Task state was preserved"}</h2>
                <p>{details.task.pause?.previousState === "IMPLEMENTING" || details.task.pause?.previousState === "REVIEWING" ? "The managed worktree and all changes were preserved. Resuming returns to a recorded technical failure for inspection; it does not suspend and revive the old process." : "Resume when you are ready to continue from the saved state."}</p>
                <div className="actions">
                  <button className="primary" disabled={busy || details.progress.active} type="button" onClick={() => void run(() => api.resume(details.task.id))}>Resume task</button>
                  <button disabled={busy} type="button" onClick={() => void run(() => api.cancel(details.task.id))}>Cancel task</button>
                </div>
              </section>
            ) : null}

            {selectedState === "FAILED" && details.task.executionFailure !== undefined ? (
              <section className="panel failure-card">
                <p className="eyebrow">Technical failure · {details.task.executionFailure.phase}</p>
                <h2>Execution stopped safely</h2>
                <p>{details.task.executionFailure.message}</p>
                <p className="notice">The managed worktree and provider artifacts were preserved. UnityAI did not escalate models, finalize Git, merge, or push.</p>
              </section>
            ) : null}

            {selectedState === "READY_FOR_QA" ? <ReadyForQa details={details} /> : null}

            <details className="debug-details">
              <summary>Technical details</summary>
              <dl>
                <dt>Target</dt><dd>{details.task.targetProjectPath}</dd>
                <dt>Task branch</dt><dd>{details.git.environment?.taskBranch ?? "Not prepared"}</dd>
                <dt>Managed worktree</dt><dd>{details.git.environment?.taskWorktreePath ?? "Not prepared"}</dd>
                <dt>Implementation run</dt><dd>{details.orchestration.implementation?.runId ?? "Not run"}</dd>
                <dt>Review run</dt><dd>{details.orchestration.review?.runId ?? "Not run"}</dd>
              </dl>
            </details>
          </>
        ) : null}
      </main>
    </div>
  );
}

function DraftEditor({
  task,
  busy,
  onSave,
  onSubmit,
}: {
  readonly task: Task;
  readonly busy: boolean;
  readonly onSave: (patch: unknown) => Promise<void>;
  readonly onSubmit: () => Promise<void>;
}) {
  const [title, setTitle] = useState(task.title ?? "");
  const [request, setRequest] = useState(task.originalRequest);
  return (
    <section className="panel stack">
      <p className="eyebrow">Editable prerequisite draft</p>
      <h2>Rewrite this task before submitting</h2>
      <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>Request<textarea rows={7} value={request} onChange={(event) => setRequest(event.target.value)} /></label>
      <div className="actions">
        <button disabled={busy} type="button" onClick={() => void onSave({ title: title.trim() || null, originalRequest: request })}>Save draft</button>
        <button className="primary" disabled={busy || request.trim().length === 0} type="button" onClick={() => void onSubmit()}>Submit as task</button>
      </div>
      <p className="notice">Submitting creates a normal task. It does not run, approve, or resume the blocked parent.</p>
    </section>
  );
}

export function BlockedView({
  details,
  busy,
  onPrerequisite,
  onPause,
  onRecheck,
  onCancel,
}: {
  readonly details: TaskDetailsResponse;
  readonly busy: boolean;
  readonly onPrerequisite: () => void;
  readonly onPause: () => void;
  readonly onRecheck: () => void;
  readonly onCancel: () => void;
}) {
  const feasibility = details.analysis?.feasibility?.result;
  return (
    <section className="panel blocked-card">
      <p className="eyebrow">Blocked · {feasibility?.status ?? details.task.feasibility?.status}</p>
      <h2>{feasibility?.summary ?? details.task.feasibility?.summary}</h2>
      <BulletList items={feasibility?.missingCapabilities ?? details.task.feasibility?.missingCapabilities ?? []} />
      {feasibility?.suggestedPrerequisite === null || feasibility?.suggestedPrerequisite === undefined ? null : (
        <div className="suggestion"><small>Suggested prerequisite</small><strong>{feasibility.suggestedPrerequisite.title}</strong><p>{feasibility.suggestedPrerequisite.request}</p></div>
      )}
      <div className="actions wrap">
        <button className="primary" disabled={busy || feasibility?.suggestedPrerequisite == null} type="button" onClick={onPrerequisite}>Create prerequisite task</button>
        <button disabled={busy || details.task.state === "PAUSED"} type="button" onClick={onPause}>Pause</button>
        <button disabled={busy} type="button" onClick={onRecheck}>Recheck</button>
        <button disabled={busy} type="button" onClick={onCancel}>Cancel</button>
      </div>
      <p className="notice">Recheck reuses the interpretation and performs one new read-only Feasibility pass against the current repository.</p>
    </section>
  );
}

export function ReadyForQa({ details }: { readonly details: TaskDetailsResponse }) {
  const implementation = details.orchestration.implementation;
  const review = details.orchestration.review;
  return (
    <section className="panel ready-card">
      <p className="eyebrow">Implementation ready</p>
      <h2>Waiting for QA capability</h2>
      <p className="important">READY FOR QA does not mean this task passed QA or is complete.</p>
      <div className="result-grid">
        <div><small>Task branch</small><strong>{details.git.environment?.taskBranch}</strong></div>
        <div><small>Checkpoint</small><strong>{implementation?.checkpointId}</strong></div>
        <div><small>Changed files</small><strong>{implementation?.changedFiles.length ?? 0}</strong></div>
        <div><small>Review findings</small><strong>{review?.findings.length ?? 0}</strong></div>
      </div>
      <h3>Implementation summary</h3>
      <p>{implementation?.summary}</p>
      <BulletList items={implementation?.implementationNotes ?? []} />
      {review === undefined ? <p className="notice">Cross Review was OFF for this task.</p> : (
        <div className="review-results">
          <h3>Cross Review · {review.status}</h3>
          <p>{review.summary}</p>
          {review.findings.map((finding) => (
            <article className={`finding severity-${finding.severity}`} key={finding.id}>
              <span>{finding.id} · {finding.severity}</span>
              <strong>{finding.title}</strong>
              <p>{finding.description}</p>
              <small>{finding.evidence}</small>
            </article>
          ))}
          {review.qaFocus.length > 0 ? <><h4>Future QA focus</h4><BulletList items={review.qaFocus} /></> : null}
        </div>
      )}
      <p className="notice">The task branch remains local and inspectable. It has not been finalized, merged, or pushed.</p>
    </section>
  );
}
