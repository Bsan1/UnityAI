import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { ServerError } from "./errors.js";
import { GitCommandRunner } from "./gitCommandRunner.js";

export type ProjectId = `PROJECT-${string}`;

export interface ProjectRecord {
  readonly id: ProjectId;
  readonly displayName: string;
  readonly path: string;
  readonly unityEditorPath?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastUsedAt?: string;
}

interface ProjectRegistryData {
  readonly schemaVersion: 1;
  readonly projects: readonly ProjectRecord[];
}

const idPattern = /^PROJECT-\d{4,}$/;

const isMissing = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error as NodeJS.ErrnoException).code === "ENOENT";

const pathKey = (path: string): string =>
  process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;

const requireRecord = (value: unknown, name: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ServerError("VALIDATION_ERROR", `${name} must be an object.`, 400);
  }
  return value as Record<string, unknown>;
};

const requireString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ServerError("VALIDATION_ERROR", `${name} must be a non-empty string.`, 400);
  }
  return value.trim();
};

const parseTimestamp = (value: unknown, name: string): string => {
  const candidate = requireString(value, name);
  if (Number.isNaN(Date.parse(candidate))) {
    throw new ServerError("VALIDATION_ERROR", `${name} must be a timestamp.`, 400);
  }
  return candidate;
};

const parseProject = (value: unknown): ProjectRecord => {
  const input = requireRecord(value, "project");
  const id = requireString(input.id, "project.id");
  if (!idPattern.test(id)) {
    throw new ServerError(
      "VALIDATION_ERROR",
      "project.id must use the PROJECT-0001 format.",
      400,
    );
  }
  const lastUsedAt = input.lastUsedAt === undefined
    ? undefined
    : parseTimestamp(input.lastUsedAt, "project.lastUsedAt");
  const unityEditorPath = input.unityEditorPath === undefined
    ? undefined
    : requireString(input.unityEditorPath, "project.unityEditorPath");
  return {
    id: id as ProjectId,
    displayName: requireString(input.displayName, "project.displayName"),
    path: requireString(input.path, "project.path"),
    ...(unityEditorPath === undefined ? {} : { unityEditorPath }),
    createdAt: parseTimestamp(input.createdAt, "project.createdAt"),
    updatedAt: parseTimestamp(input.updatedAt, "project.updatedAt"),
    ...(lastUsedAt === undefined ? {} : { lastUsedAt }),
  };
};

const parseRegistry = (value: unknown): ProjectRegistryData => {
  const input = requireRecord(value, "project registry");
  if (input.schemaVersion !== 1 || !Array.isArray(input.projects)) {
    throw new ServerError(
      "PROJECT_REGISTRY_INVALID",
      "Project registry must use schemaVersion 1 with a projects array.",
      500,
    );
  }
  const projects = input.projects.map(parseProject);
  if (new Set(projects.map((project) => project.id)).size !== projects.length) {
    throw new ServerError(
      "PROJECT_REGISTRY_INVALID",
      "Project registry contains duplicate project IDs.",
      500,
    );
  }
  if (new Set(projects.map((project) => pathKey(project.path))).size !== projects.length) {
    throw new ServerError(
      "PROJECT_REGISTRY_INVALID",
      "Project registry contains duplicate project paths.",
      500,
    );
  }
  return { schemaVersion: 1, projects };
};

export class ProjectRegistry {
  private readonly path: string;
  private readonly runner: GitCommandRunner;
  private data: ProjectRegistryData = { schemaVersion: 1, projects: [] };
  private nextSequence = 1;
  private initialized = false;

  constructor(runtimeRoot: string, runner = new GitCommandRunner()) {
    this.path = join(runtimeRoot, "projects.json");
    this.runner = runner;
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      this.data = parseRegistry(value);
    } catch (error: unknown) {
      if (isMissing(error)) {
        await this.persist();
      } else if (error instanceof ServerError) {
        throw error;
      } else {
        const message = error instanceof Error ? error.message : "Unknown error";
        throw new ServerError(
          "PROJECT_REGISTRY_INVALID",
          `Could not load project registry: ${message}`,
          500,
        );
      }
    }
    this.nextSequence = this.data.projects.reduce(
      (maximum, project) => Math.max(maximum, Number(project.id.slice(8))),
      0,
    ) + 1;
    this.initialized = true;
  }

  list(): readonly ProjectRecord[] {
    this.assertInitialized();
    return [...this.data.projects].sort((left, right) =>
      left.displayName.localeCompare(right.displayName),
    );
  }

  get(id: string): ProjectRecord {
    this.assertInitialized();
    if (!idPattern.test(id)) {
      throw new ServerError("VALIDATION_ERROR", "Project ID is invalid.", 400);
    }
    const project = this.data.projects.find((candidate) => candidate.id === id);
    if (project === undefined) {
      throw new ServerError("PROJECT_NOT_FOUND", `Project ${id} was not found.`, 404);
    }
    return project;
  }

  async create(value: unknown): Promise<ProjectRecord> {
    this.assertInitialized();
    const input = requireRecord(value, "project input");
    const displayName = requireString(input.displayName, "project input.displayName");
    const repositoryRoot = await this.validateGitPath(
      requireString(input.path, "project input.path"),
    );
    this.assertUniquePath(repositoryRoot);
    const timestamp = new Date().toISOString();
    const project: ProjectRecord = {
      id: `PROJECT-${String(this.nextSequence).padStart(4, "0")}`,
      displayName,
      path: repositoryRoot,
      ...(input.unityEditorPath === undefined
        ? {}
        : {
            unityEditorPath: requireString(
              input.unityEditorPath,
              "project input.unityEditorPath",
            ),
          }),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.nextSequence += 1;
    this.data = { ...this.data, projects: [...this.data.projects, project] };
    await this.persist();
    return project;
  }

  async update(id: string, value: unknown): Promise<ProjectRecord> {
    const current = this.get(id);
    const input = requireRecord(value, "project patch");
    const keys = Object.keys(input);
    if (
      keys.length === 0 ||
      keys.some(
        (key) =>
          key !== "displayName" &&
          key !== "path" &&
          key !== "unityEditorPath",
      )
    ) {
      throw new ServerError(
        "VALIDATION_ERROR",
        "Project patch may contain only displayName, path, and unityEditorPath.",
        400,
      );
    }
    const displayName = input.displayName === undefined
      ? current.displayName
      : requireString(input.displayName, "project patch.displayName");
    const projectPath = input.path === undefined
      ? current.path
      : await this.validateGitPath(requireString(input.path, "project patch.path"));
    const unityEditorPath = input.unityEditorPath === undefined
      ? current.unityEditorPath
      : input.unityEditorPath === null
        ? undefined
        : requireString(input.unityEditorPath, "project patch.unityEditorPath");
    this.assertUniquePath(projectPath, current.id);
    const { unityEditorPath: _previousUnityEditorPath, ...currentWithoutEditorPath } = current;
    const updated: ProjectRecord = {
      ...currentWithoutEditorPath,
      displayName,
      path: projectPath,
      ...(unityEditorPath === undefined ? {} : { unityEditorPath }),
      updatedAt: new Date().toISOString(),
    };
    this.data = {
      ...this.data,
      projects: this.data.projects.map((project) =>
        project.id === current.id ? updated : project,
      ),
    };
    await this.persist();
    return updated;
  }

  async remove(id: string): Promise<ProjectRecord> {
    const project = this.get(id);
    this.data = {
      ...this.data,
      projects: this.data.projects.filter((candidate) => candidate.id !== project.id),
    };
    await this.persist();
    return project;
  }

  async markUsed(id: string): Promise<ProjectRecord> {
    const current = this.get(id);
    const timestamp = new Date().toISOString();
    const updated: ProjectRecord = {
      ...current,
      lastUsedAt: timestamp,
      updatedAt: timestamp,
    };
    this.data = {
      ...this.data,
      projects: this.data.projects.map((project) =>
        project.id === current.id ? updated : project,
      ),
    };
    await this.persist();
    return updated;
  }

  findByPath(path: string | undefined): ProjectRecord | undefined {
    if (path === undefined) {
      return undefined;
    }
    const key = pathKey(resolve(path));
    return this.data.projects.find((project) => pathKey(resolve(project.path)) === key);
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new ServerError(
        "PROJECT_REGISTRY_INVALID",
        "Project registry must be initialized before use.",
        500,
      );
    }
  }

  private assertUniquePath(path: string, exceptId?: ProjectId): void {
    const duplicate = this.data.projects.find(
      (project) => project.id !== exceptId && pathKey(project.path) === pathKey(path),
    );
    if (duplicate !== undefined) {
      throw new ServerError(
        "PROJECT_ALREADY_REGISTERED",
        `Project path is already registered as ${duplicate.displayName}.`,
        409,
      );
    }
  }

  private async validateGitPath(path: string): Promise<string> {
    const absolutePath = resolve(path);
    let info;
    try {
      info = await stat(absolutePath);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new ServerError(
        "INVALID_PROJECT_PATH",
        `Project path is not accessible: ${message}`,
        422,
      );
    }
    if (!info.isDirectory()) {
      throw new ServerError("INVALID_PROJECT_PATH", "Project path must be a directory.", 422);
    }
    const root = await this.runner.run(["rev-parse", "--show-toplevel"], { cwd: absolutePath });
    if (root.exitCode !== 0 || root.stdout.trim().length === 0) {
      throw new ServerError(
        "NOT_A_GIT_REPOSITORY",
        "The selected project path is not inside a Git repository.",
        422,
      );
    }
    const repositoryRoot = resolve(root.stdout.trim());
    try {
      await access(repositoryRoot);
      return await realpath(repositoryRoot);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new ServerError(
        "INVALID_PROJECT_PATH",
        `Resolved repository root is not accessible: ${message}`,
        422,
      );
    }
  }

  private async persist(): Promise<void> {
    const destination = this.path;
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(destination), { recursive: true });
    try {
      await writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temporary, destination);
    } catch (error: unknown) {
      await rm(temporary, { force: true }).catch(() => undefined);
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new ServerError(
        "PROJECT_REGISTRY_PERSISTENCE_ERROR",
        `Could not save project registry: ${message}`,
        500,
      );
    }
  }
}
