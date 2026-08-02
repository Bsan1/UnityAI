import type {
  ApiErrorPayload,
  GlobalSettings,
  HealthResponse,
  ProjectRecord,
  Task,
  TaskDetailsResponse,
  TaskProgress,
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
  createProject: async (input: { displayName: string; path: string }) =>
    (await request<{ project: ProjectRecord }>("/projects", json("POST", input))).project,
  deleteProject: (id: string) => request(`/projects/${id}`, json("DELETE")),
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
  return error.message;
};
