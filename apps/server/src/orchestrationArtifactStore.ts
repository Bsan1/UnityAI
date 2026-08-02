import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  parseImplementationResult,
  parseReviewResult,
  parseTaskExecutionFailure,
  parseTaskId,
} from "@unityai/core";
import type {
  ImplementationResult,
  ReviewResult,
  TaskExecutionFailure,
  TaskId,
  TaskOrchestrationArtifacts,
} from "@unityai/core";

import { ServerError } from "./errors.js";

type ArtifactName =
  | "implementation/result.json"
  | "review/result.json"
  | "orchestration/git-status.json"
  | "orchestration/failure.json";

export interface OrchestrationGitSnapshot {
  readonly schemaVersion: 1;
  readonly branch: string;
  readonly headCommit: string;
  readonly isClean: boolean;
  readonly changedFiles: readonly string[];
  readonly stagedFiles: readonly string[];
  readonly unstagedFiles: readonly string[];
  readonly untrackedFiles: readonly string[];
  readonly diffSummary: string;
  readonly recordedAt: string;
}

export interface StoredOrchestrationArtifacts extends TaskOrchestrationArtifacts {
  readonly gitSnapshot?: OrchestrationGitSnapshot;
}

const isMissing = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error as NodeJS.ErrnoException).code === "ENOENT";

export class OrchestrationArtifactStore {
  private readonly tasksRoot: string;

  constructor(runtimeRoot: string) {
    this.tasksRoot = join(runtimeRoot, "tasks");
  }

  async initialize(): Promise<void> {
    await mkdir(this.tasksRoot, { recursive: true });
  }

  saveImplementation(id: TaskId, result: ImplementationResult): Promise<void> {
    return this.write(
      parseTaskId(id),
      "implementation/result.json",
      parseImplementationResult(result),
    );
  }

  saveReview(id: TaskId, result: ReviewResult): Promise<void> {
    return this.write(parseTaskId(id), "review/result.json", parseReviewResult(result));
  }

  saveFailure(id: TaskId, failure: TaskExecutionFailure): Promise<void> {
    return this.write(
      parseTaskId(id),
      "orchestration/failure.json",
      parseTaskExecutionFailure(failure),
    );
  }

  saveGitSnapshot(id: TaskId, snapshot: OrchestrationGitSnapshot): Promise<void> {
    return this.write(
      parseTaskId(id),
      "orchestration/git-status.json",
      parseGitSnapshot(snapshot),
    );
  }

  async clearFailure(id: TaskId): Promise<void> {
    await rm(this.path(parseTaskId(id), "orchestration/failure.json"), {
      force: true,
    });
  }

  async get(id: TaskId): Promise<StoredOrchestrationArtifacts> {
    const validId = parseTaskId(id);
    const [implementation, review, gitSnapshot, failure] = await Promise.all([
      this.read(validId, "implementation/result.json", parseImplementationResult),
      this.read(validId, "review/result.json", parseReviewResult),
      this.read(validId, "orchestration/git-status.json", parseGitSnapshot),
      this.read(validId, "orchestration/failure.json", parseTaskExecutionFailure),
    ]);
    return {
      ...(implementation === undefined ? {} : { implementation }),
      ...(review === undefined ? {} : { review }),
      ...(gitSnapshot === undefined ? {} : { gitSnapshot }),
      ...(failure === undefined ? {} : { failure }),
    };
  }

  private path(id: TaskId, name: ArtifactName): string {
    return join(this.tasksRoot, id, ...name.split("/"));
  }

  private async write(id: TaskId, name: ArtifactName, value: unknown): Promise<void> {
    const destination = this.path(id, name);
    const directory = dirname(destination);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temporary, destination);
    } catch (error: unknown) {
      await rm(temporary, { force: true }).catch(() => undefined);
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new ServerError(
        "ORCHESTRATION_PERSISTENCE_ERROR",
        `Could not write ${name} for ${id}: ${message}`,
        500,
      );
    }
  }

  private async read<T>(
    id: TaskId,
    name: ArtifactName,
    parse: (value: unknown) => T,
  ): Promise<T | undefined> {
    const path = this.path(id, name);
    try {
      await access(path);
    } catch (error: unknown) {
      if (isMissing(error)) {
        return undefined;
      }
      throw error;
    }
    try {
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      return parse(value);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new ServerError(
        "ORCHESTRATION_ARTIFACT_INVALID",
        `Persisted orchestration artifact ${path} is invalid: ${message}`,
        500,
      );
    }
  }
}

const parseGitSnapshot = (value: unknown): OrchestrationGitSnapshot => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ServerError("ORCHESTRATION_ARTIFACT_INVALID", "Git snapshot must be an object.", 500);
  }
  const input = value as Record<string, unknown>;
  const readString = (field: string): string => {
    const candidate = input[field];
    if (typeof candidate !== "string") {
      throw new ServerError("ORCHESTRATION_ARTIFACT_INVALID", `Git snapshot.${field} must be a string.`, 500);
    }
    return candidate;
  };
  const readStrings = (field: string): readonly string[] => {
    const candidate = input[field];
    if (!Array.isArray(candidate) || candidate.some((entry) => typeof entry !== "string")) {
      throw new ServerError("ORCHESTRATION_ARTIFACT_INVALID", `Git snapshot.${field} must be a string array.`, 500);
    }
    return candidate as readonly string[];
  };
  if (input.schemaVersion !== 1 || typeof input.isClean !== "boolean") {
    throw new ServerError("ORCHESTRATION_ARTIFACT_INVALID", "Git snapshot schema is invalid.", 500);
  }
  const recordedAt = readString("recordedAt");
  if (Number.isNaN(Date.parse(recordedAt))) {
    throw new ServerError("ORCHESTRATION_ARTIFACT_INVALID", "Git snapshot.recordedAt must be a timestamp.", 500);
  }
  return {
    schemaVersion: 1,
    branch: readString("branch"),
    headCommit: readString("headCommit"),
    isClean: input.isClean,
    changedFiles: readStrings("changedFiles"),
    stagedFiles: readStrings("stagedFiles"),
    unstagedFiles: readStrings("unstagedFiles"),
    untrackedFiles: readStrings("untrackedFiles"),
    diffSummary: readString("diffSummary"),
    recordedAt,
  };
};
