import type { GitFileStatus, GitStatusReport } from "./gitTypes.js";

const uniqueSorted = (values: readonly string[]): readonly string[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right));

export const parsePorcelainStatus = (
  output: string,
): Omit<GitStatusReport, "branch" | "headCommit"> => {
  const records = output.split("\0");
  const entries: GitFileStatus[] = [];
  const stagedFiles: string[] = [];
  const unstagedFiles: string[] = [];
  const untrackedFiles: string[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length === 0) {
      continue;
    }
    if (record.length < 4 || record[2] !== " ") {
      continue;
    }

    const indexStatus = record[0] ?? " ";
    const worktreeStatus = record[1] ?? " ";
    const path = record.slice(3);
    entries.push({ path, indexStatus, worktreeStatus });

    if (indexStatus === "?" && worktreeStatus === "?") {
      untrackedFiles.push(path);
    } else {
      if (indexStatus !== " " && indexStatus !== "!") {
        stagedFiles.push(path);
      }
      if (worktreeStatus !== " " && worktreeStatus !== "!") {
        unstagedFiles.push(path);
      }
    }

    if (indexStatus === "R" || indexStatus === "C") {
      index += 1;
    }
  }

  const changedFiles = uniqueSorted([
    ...stagedFiles,
    ...unstagedFiles,
    ...untrackedFiles,
  ]);

  return {
    isClean: changedFiles.length === 0,
    changedFiles,
    stagedFiles: uniqueSorted(stagedFiles),
    unstagedFiles: uniqueSorted(unstagedFiles),
    untrackedFiles: uniqueSorted(untrackedFiles),
    entries,
  };
};
