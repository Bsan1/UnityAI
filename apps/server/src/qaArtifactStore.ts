import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  parseFixResult,
  parseQAReport,
  parseQASession,
  parseQATechnicalFailure,
  parseTaskId,
} from "@unityai/core";
import type {
  FixResult,
  QAReport,
  QASession,
  QATechnicalFailure,
  TaskId,
  TaskQAArtifacts,
} from "@unityai/core";

import { ServerError } from "./errors.js";

const cyclePattern = /^cycle-(\d{3,})$/u;
const fixPattern = /^fix-(\d{3,})$/u;

const missing = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error as NodeJS.ErrnoException).code === "ENOENT";

const sequence = (name: string, pattern: RegExp): number | undefined => {
  const match = pattern.exec(name);
  const value = match?.[1] === undefined ? undefined : Number(match[1]);
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
};

export class QAArtifactStore {
  private readonly tasksRoot: string;

  constructor(runtimeRoot: string) {
    this.tasksRoot = join(runtimeRoot, "tasks");
  }

  async initialize(): Promise<void> {
    await mkdir(this.tasksRoot, { recursive: true });
  }

  async nextCycle(taskId: TaskId): Promise<{
    readonly cycleNumber: number;
    readonly sessionId: string;
  }> {
    const id = parseTaskId(taskId);
    const qaRoot = join(this.tasksRoot, id, "qa");
    await mkdir(qaRoot, { recursive: true });
    const entries = await readdir(qaRoot, { withFileTypes: true });
    const maximum = entries.reduce((current, entry) => {
      if (!entry.isDirectory()) {
        return current;
      }
      return Math.max(current, sequence(entry.name, cyclePattern) ?? 0);
    }, 0);
    return {
      cycleNumber: maximum + 1,
      sessionId: `QA-${randomUUID().toUpperCase()}`,
    };
  }

  async nextFixNumber(taskId: TaskId): Promise<number> {
    const id = parseTaskId(taskId);
    const root = join(this.tasksRoot, id, "fixes");
    await mkdir(root, { recursive: true });
    const entries = await readdir(root, { withFileTypes: true });
    return entries.reduce((current, entry) => {
      if (!entry.isDirectory()) {
        return current;
      }
      return Math.max(current, sequence(entry.name, fixPattern) ?? 0);
    }, 0) + 1;
  }

  async saveSession(taskId: TaskId, value: QASession): Promise<QASession> {
    const id = parseTaskId(taskId);
    const session = parseQASession(value);
    if (session.taskId !== id) {
      throw new ServerError("QA_ARTIFACT_INVALID", "QA session task ID does not match its storage path.", 500);
    }
    const root = this.cycleRoot(id, session.cycleNumber);
    await this.atomicWrite(join(root, "session.json"), session);
    await Promise.all(session.evidence.map((evidence) =>
      this.atomicWrite(join(root, "evidence", `${evidence.id}.json`), evidence),
    ));
    return session;
  }

  async saveReport(taskId: TaskId, value: QAReport): Promise<QAReport> {
    const id = parseTaskId(taskId);
    const report = parseQAReport(value);
    if (report.taskId !== id) {
      throw new ServerError("QA_ARTIFACT_INVALID", "QA report task ID does not match its storage path.", 500);
    }
    await this.atomicWrite(join(this.cycleRoot(id, report.cycleNumber), "report.json"), report);
    return report;
  }

  async saveFix(taskId: TaskId, value: FixResult): Promise<FixResult> {
    const id = parseTaskId(taskId);
    const fix = parseFixResult(value);
    if (fix.taskId !== id) {
      throw new ServerError("QA_ARTIFACT_INVALID", "Fix task ID does not match its storage path.", 500);
    }
    const numeric = Number(fix.fixId.replace(/^FIX-/u, ""));
    if (!Number.isSafeInteger(numeric) || numeric < 1) {
      throw new ServerError("QA_ARTIFACT_INVALID", "Fix ID must use FIX-<sequence>.", 500);
    }
    await this.atomicWrite(
      join(this.tasksRoot, id, "fixes", `fix-${String(numeric).padStart(3, "0")}`, "result.json"),
      fix,
    );
    return fix;
  }

  async saveFailure(taskId: TaskId, value: QATechnicalFailure): Promise<QATechnicalFailure> {
    const id = parseTaskId(taskId);
    const failure = parseQATechnicalFailure(value);
    await this.atomicWrite(join(this.tasksRoot, id, "qa", "failure.json"), failure);
    return failure;
  }

  async clearFailure(taskId: TaskId): Promise<void> {
    const id = parseTaskId(taskId);
    await rm(join(this.tasksRoot, id, "qa", "failure.json"), { force: true });
  }

  async get(taskId: TaskId): Promise<TaskQAArtifacts> {
    const id = parseTaskId(taskId);
    const [sessions, reports, fixes, persistedFailure] = await Promise.all([
      this.readCycles(id, "session.json", parseQASession),
      this.readCycles(id, "report.json", parseQAReport),
      this.readFixes(id),
      this.readOptional(
        join(this.tasksRoot, id, "qa", "failure.json"),
        parseQATechnicalFailure,
      ),
    ]);
    const latestSession = sessions.at(-1);
    const latestReport = reports.at(-1);
    const latestFailure = persistedFailure ?? latestSession?.technicalFailure;
    return {
      sessions,
      reports,
      fixes,
      ...(latestSession === undefined ? {} : { latestSession }),
      ...(latestReport === undefined ? {} : { latestReport }),
      ...(latestFailure === undefined ? {} : { latestFailure }),
    };
  }

  async getCycle(taskId: TaskId, cycle: number): Promise<{
    readonly session: QASession;
    readonly report?: QAReport;
  }> {
    const id = parseTaskId(taskId);
    if (!Number.isSafeInteger(cycle) || cycle < 1) {
      throw new ServerError("VALIDATION_ERROR", "QA cycle must be a positive integer.", 400);
    }
    const root = this.cycleRoot(id, cycle);
    const session = await this.readRequired(join(root, "session.json"), parseQASession);
    const report = await this.readOptional(join(root, "report.json"), parseQAReport);
    return { session, ...(report === undefined ? {} : { report }) };
  }

  private cycleRoot(taskId: TaskId, cycle: number): string {
    return join(this.tasksRoot, taskId, "qa", `cycle-${String(cycle).padStart(3, "0")}`);
  }

  private async readCycles<T>(
    taskId: TaskId,
    file: string,
    parse: (value: unknown) => T,
  ): Promise<readonly T[]> {
    const root = join(this.tasksRoot, taskId, "qa");
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error: unknown) {
      if (missing(error)) {
        return [];
      }
      throw error;
    }
    const directories = entries
      .filter((entry) => entry.isDirectory() && sequence(entry.name, cyclePattern) !== undefined)
      .sort((left, right) => (sequence(left.name, cyclePattern) ?? 0) - (sequence(right.name, cyclePattern) ?? 0));
    const values: T[] = [];
    for (const directory of directories) {
      const value = await this.readOptional(join(root, directory.name, file), parse);
      if (value !== undefined) {
        values.push(value);
      }
    }
    return values;
  }

  private async readFixes(taskId: TaskId): Promise<readonly FixResult[]> {
    const root = join(this.tasksRoot, taskId, "fixes");
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error: unknown) {
      if (missing(error)) {
        return [];
      }
      throw error;
    }
    const fixes: FixResult[] = [];
    for (const directory of entries
      .filter((entry) => entry.isDirectory() && sequence(entry.name, fixPattern) !== undefined)
      .sort((left, right) => (sequence(left.name, fixPattern) ?? 0) - (sequence(right.name, fixPattern) ?? 0))) {
      fixes.push(await this.readRequired(join(root, directory.name, "result.json"), parseFixResult));
    }
    return fixes;
  }

  private async readOptional<T>(path: string, parse: (value: unknown) => T): Promise<T | undefined> {
    try {
      await access(path);
    } catch (error: unknown) {
      if (missing(error)) {
        return undefined;
      }
      throw error;
    }
    return this.readRequired(path, parse);
  }

  private async readRequired<T>(path: string, parse: (value: unknown) => T): Promise<T> {
    try {
      return parse(JSON.parse(await readFile(path, "utf8")) as unknown);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new ServerError("QA_ARTIFACT_INVALID", `QA artifact ${path} is invalid: ${message}`, 500);
    }
  }

  private async atomicWrite(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temporary, path);
    } catch (error: unknown) {
      await rm(temporary, { force: true }).catch(() => undefined);
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new ServerError("QA_PERSISTENCE_ERROR", `Could not write QA artifact ${path}: ${message}`, 500);
    }
  }
}
