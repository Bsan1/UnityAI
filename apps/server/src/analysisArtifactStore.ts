import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  parseAnalysisFailureArtifact,
  parseExecutionRoutingSnapshot,
  parseFeasibilityArtifact,
  parseInterpretationArtifact,
  parseTaskContract,
  parseTaskId,
} from "@unityai/core";
import type {
  AnalysisFailureArtifact,
  ExecutionRoutingSnapshot,
  FeasibilityArtifact,
  InterpretationArtifact,
  TaskAnalysisArtifacts,
  TaskContract,
  TaskId,
} from "@unityai/core";

import { ServerError } from "./errors.js";

type ArtifactName =
  | "interpretation.json"
  | "feasibility.json"
  | "routing.json"
  | "contract.json"
  | "failure.json";

const isMissing = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error as NodeJS.ErrnoException).code === "ENOENT";

export class AnalysisArtifactStore {
  private readonly tasksRoot: string;

  constructor(runtimeRoot: string) {
    this.tasksRoot = join(runtimeRoot, "tasks");
  }

  async initialize(): Promise<void> {
    await mkdir(this.tasksRoot, { recursive: true });
  }

  async resetForInitialAnalysis(id: TaskId): Promise<void> {
    const directory = this.analysisDirectory(parseTaskId(id));
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
  }

  async resetForRecheck(
    id: TaskId,
    preserveInterpretation: boolean,
  ): Promise<void> {
    const validId = parseTaskId(id);
    const directory = this.analysisDirectory(validId);
    await mkdir(directory, { recursive: true });
    const names: ArtifactName[] = [
      "feasibility.json",
      "routing.json",
      "contract.json",
      "failure.json",
      ...(preserveInterpretation ? [] : ["interpretation.json" as const]),
    ];
    await Promise.all(names.map((name) => rm(join(directory, name), { force: true })));
  }

  saveInterpretation(id: TaskId, artifact: InterpretationArtifact): Promise<void> {
    return this.writeValidated(
      parseTaskId(id),
      "interpretation.json",
      parseInterpretationArtifact(artifact),
    );
  }

  saveFeasibility(id: TaskId, artifact: FeasibilityArtifact): Promise<void> {
    return this.writeValidated(
      parseTaskId(id),
      "feasibility.json",
      parseFeasibilityArtifact(artifact),
    );
  }

  saveRouting(id: TaskId, routing: ExecutionRoutingSnapshot): Promise<void> {
    return this.writeValidated(
      parseTaskId(id),
      "routing.json",
      parseExecutionRoutingSnapshot(routing),
    );
  }

  saveContract(id: TaskId, contract: TaskContract): Promise<void> {
    return this.writeValidated(
      parseTaskId(id),
      "contract.json",
      parseTaskContract(contract),
    );
  }

  saveFailure(id: TaskId, failure: AnalysisFailureArtifact): Promise<void> {
    return this.writeValidated(
      parseTaskId(id),
      "failure.json",
      parseAnalysisFailureArtifact(failure),
    );
  }

  async getInterpretationForRecheck(
    id: TaskId,
  ): Promise<InterpretationArtifact | undefined> {
    try {
      return await this.readOptional(
        parseTaskId(id),
        "interpretation.json",
        parseInterpretationArtifact,
      );
    } catch (error: unknown) {
      if (error instanceof ServerError && error.code === "ANALYSIS_ARTIFACT_INVALID") {
        return undefined;
      }
      throw error;
    }
  }

  async get(id: TaskId): Promise<TaskAnalysisArtifacts | undefined> {
    const validId = parseTaskId(id);
    const [interpretation, feasibility, routing, contract, failure] =
      await Promise.all([
        this.readOptional(validId, "interpretation.json", parseInterpretationArtifact),
        this.readOptional(validId, "feasibility.json", parseFeasibilityArtifact),
        this.readOptional(validId, "routing.json", parseExecutionRoutingSnapshot),
        this.readOptional(validId, "contract.json", parseTaskContract),
        this.readOptional(validId, "failure.json", parseAnalysisFailureArtifact),
      ]);
    if (
      interpretation === undefined &&
      feasibility === undefined &&
      routing === undefined &&
      contract === undefined &&
      failure === undefined
    ) {
      return undefined;
    }
    return {
      ...(interpretation === undefined ? {} : { interpretation }),
      ...(feasibility === undefined ? {} : { feasibility }),
      ...(routing === undefined ? {} : { routing }),
      ...(contract === undefined ? {} : { contract }),
      ...(failure === undefined ? {} : { failure }),
    };
  }

  private analysisDirectory(id: TaskId): string {
    return join(this.tasksRoot, id, "analysis");
  }

  private async writeValidated(
    id: TaskId,
    name: ArtifactName,
    value: unknown,
  ): Promise<void> {
    const directory = this.analysisDirectory(id);
    const destination = join(directory, name);
    const temporary = join(
      directory,
      `.${name}.${process.pid}.${randomUUID()}.tmp`,
    );
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
        "ANALYSIS_PERSISTENCE_ERROR",
        `Could not write ${name} for ${id}: ${message}`,
        500,
      );
    }
  }

  private async readOptional<T>(
    id: TaskId,
    name: ArtifactName,
    parse: (value: unknown) => T,
  ): Promise<T | undefined> {
    const path = join(this.analysisDirectory(id), name);
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
        "ANALYSIS_ARTIFACT_INVALID",
        `Persisted analysis artifact ${path} is invalid: ${message}`,
        500,
      );
    }
  }
}
