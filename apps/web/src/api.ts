import type {
  ApiErrorPayload,
  GlobalSettings,
  HealthResponse,
  ProjectRecord,
  Task,
  TaskDetailsResponse,
  TaskProgress,
  TaskQAArtifacts,
  UnityProjectInspectionResponse,
  UnityTaskStatusResponse,
} from "@unityai/shared";

export class ApiError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const error = payload as Partial<ApiErrorPayload>;
    throw new ApiError(
      error.error?.code ?? "REQUEST_FAILED",
      error.error?.message ?? `Request failed with status ${response.status}.`,
      error.error?.details,
    );
  }
  return payload as T;
};

const json = (method: string, value?: unknown): RequestInit => ({
  method,
  ...(value === undefined ? {} : { body: JSON.stringify(value) }),
});

export const api = {
  health: () => request<HealthResponse>("/health"),
  listProjects: async () =>
    (await request<{ projects: readonly ProjectRecord[] }>("/projects")).projects,
  createProject: async (input: {
    displayName: string;
    path: string;
    unityEditorPath?: string;
  }) =>
    (await request<{ project: ProjectRecord }>("/projects", json("POST", input))).project,
  deleteProject: (id: string) => request(`/projects/${id}`, json("DELETE")),
  inspectUnityProject: (id: string) =>
    request<UnityProjectInspectionResponse>(`/projects/${id}/unity`),
  getSettings: async () =>
    (await request<{ settings: GlobalSettings }>("/settings")).settings,
  updateSettings: async (input: Partial<GlobalSettings>) =>
    (await request<{ settings: GlobalSettings }>("/settings", json("PATCH", input))).settings,
  listTasks: async () =>
    (await request<{ tasks: readonly Task[] }>("/tasks")).tasks,
  createTask: async (input: {
    projectId: string;
    originalRequest: string;
    title?: string;
  }) => (await request<{ task: Task }>("/tasks", json("POST", input))).task,
  getTask: async (id: string) =>
    (await request<{ task: Task }>(`/tasks/${id}`)).task,
  getDetails: (id: string) => request<TaskDetailsResponse>(`/tasks/${id}/details`),
  getProgress: async (id: string) =>
    (await request<{ progress: TaskProgress }>(`/tasks/${id}/progress`)).progress,
  analyze: (id: string) => request<TaskDetailsResponse>(`/tasks/${id}/analyze`, json("POST")),
  recheck: (id: string) => request<TaskDetailsResponse>(`/tasks/${id}/recheck`, json("POST")),
  approve: (id: string) => request(`/tasks/${id}/approve`, json("POST")),
  editContract: (id: string, patch: unknown) =>
    request(`/tasks/${id}/contract`, json("PATCH", patch)),
  pause: (id: string) => request(`/tasks/${id}/pause`, json("POST", {})),
  resume: (id: string) => request(`/tasks/${id}/resume`, json("POST")),
  cancel: (id: string) => request(`/tasks/${id}/cancel`, json("POST", {})),
  startImplementation: (id: string) =>
    request(`/tasks/${id}/start-implementation`, json("POST")),
  getTaskUnity: (id: string) =>
    request<UnityTaskStatusResponse>(`/tasks/${id}/unity`),
  prepareTaskUnity: (id: string) =>
    request(`/tasks/${id}/unity`, json("POST")),
  startUnityEditor: (id: string) =>
    request<UnityTaskStatusResponse>(`/tasks/${id}/unity/editor/start`, json("POST")),
  stopUnityEditor: (id: string) =>
    request<UnityTaskStatusResponse>(`/tasks/${id}/unity/editor/stop`, json("POST")),
  waitForUnityIdle: (id: string) =>
    request(`/tasks/${id}/unity/editor/wait-idle`, json("POST", {})),
  removeUnityBridge: (id: string) =>
    request<UnityTaskStatusResponse>(`/tasks/${id}/unity/bridge/remove`, json("POST")),
  getTaskQA: async (id: string) =>
    (await request<{ qa: TaskQAArtifacts }>(`/tasks/${id}/qa`)).qa,
  startQA: (id: string) => request(`/tasks/${id}/qa/start`, json("POST")),
  startGameplayQA: (id: string) => request(`/tasks/${id}/gameplay-qa/start`, json("POST")),
  cancelGameplayQA: (id: string) => request(`/tasks/${id}/gameplay-qa/cancel`, json("POST")),
  fixAndRetest: (id: string) =>
    request(`/tasks/${id}/qa/fix-and-retest`, json("POST")),
  cancelQA: (id: string) => request(`/tasks/${id}/qa/cancel`, json("POST")),
  prerequisiteDraft: async (id: string) =>
    (await request<{ prerequisiteDraft: Task }>(
      `/tasks/${id}/prerequisite-draft`,
      json("POST", {}),
    )).prerequisiteDraft,
  updateDraft: async (id: string, patch: unknown) =>
    (await request<{ task: Task }>(`/tasks/${id}/draft`, json("PATCH", patch))).task,
  submitDraft: async (id: string) =>
    (await request<{ task: Task }>(`/tasks/${id}/submit`, json("POST"))).task,
};

export const userMessageForError = (error: unknown): string => {
  if (!(error instanceof ApiError)) {
    return error instanceof Error ? error.message : "Something went wrong.";
  }
  if (error.code === "TARGET_WORKTREE_DIRTY") {
    return "The selected project contains uncommitted changes. UnityAI will not modify or stash them. Commit or clean your changes, then retry.";
  }
  if (error.code === "PROVIDER_UNAVAILABLE") {
    return `The configured AI provider is unavailable. ${error.message}`;
  }
  if (error.code === "NOT_A_GIT_REPOSITORY") {
    return "The selected path is not a Git repository. UnityAI will not initialize it automatically.";
  }
  if (error.code === "TASK_IMPLEMENTATION_IN_PROGRESS") {
    return "Implementation is already running for this task.";
  }
  if (error.code === "TASK_QA_IN_PROGRESS") {
    return "QA or fixing is already running for this task.";
  }
  if (error.code === "QA_FIX_NOT_AVAILABLE") {
    return "Fix & Retest is available only after a completed evidence-backed QA failure batch.";
  }
  if (error.code === "UNITY_TOOLING_IN_FINAL_DIFF") {
    return "Temporary UnityAI bridge tooling remains in the task diff, so finalization was stopped safely.";
  }
  if (error.code === "INPUT_BINDING_UNSUPPORTED") {
    return "The required gameplay binding could not be mapped safely to a virtual keyboard, mouse, or gamepad control. The test remains blocked rather than being treated as passed.";
  }
  if (error.code === "OS_INPUT_FOCUS_UNSAFE") {
    return "UnityAI could not positively verify the owned Unity Game View and foreground focus, so it refused to send operating-system input.";
  }
  if (error.code === "SCREENSHOT_CAPTURE_FAILED") {
    return "Game View evidence could not be captured safely. The gameplay QA run stopped as a technical failure and preserved the task worktree.";
  }
  if (error.code === "NOT_A_UNITY_PROJECT") {
    return "The selected Git project does not have the required Unity project structure (Assets, Packages, ProjectSettings, and ProjectVersion.txt).";
  }
  if (error.code === "UNITY_EDITOR_NOT_FOUND") {
    return `The matching Unity Editor is not installed or configured. ${error.message}`;
  }
  if (error.code === "UNITY_BRIDGE_CONFLICT") {
    return "The managed worktree already contains a bridge package UnityAI does not own. It was not overwritten or removed.";
  }
  if (error.code === "EDITOR_NOT_OWNED") {
    return "UnityAI did not launch this Editor in the current server session, so it will not terminate it.";
  }
  return error.message;
};
