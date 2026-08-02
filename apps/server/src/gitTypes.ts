import type { GitTaskEnvironment } from "@unityai/core";

export interface GitFileStatus {
  readonly path: string;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
}

export interface GitStatusReport {
  readonly branch: string;
  readonly headCommit: string;
  readonly isClean: boolean;
  readonly changedFiles: readonly string[];
  readonly stagedFiles: readonly string[];
  readonly unstagedFiles: readonly string[];
  readonly untrackedFiles: readonly string[];
  readonly entries: readonly GitFileStatus[];
}

export interface GitRepositoryInspection {
  readonly targetPath: string;
  readonly repositoryRoot: string;
  readonly originalWorktreePath: string;
  readonly gitCommonDirectory: string;
  readonly currentBranch: string;
  readonly headCommit: string;
  readonly status: GitStatusReport;
}

export interface GitDiffReport {
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly changedFiles: readonly string[];
  readonly untrackedFiles: readonly string[];
  readonly summary: string;
  readonly diff: string;
}

export interface GitRollbackResult {
  readonly environment: GitTaskEnvironment;
  readonly targetCommit: string;
  readonly status: GitStatusReport;
}
