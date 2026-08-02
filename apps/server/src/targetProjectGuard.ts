import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { ServerError } from "./errors.js";

const excludedDirectories = new Set([
  ".git",
  "Library",
  "Temp",
  "Logs",
  "obj",
]);
const maximumContentBytes = 64 * 1024 * 1024;
const maximumEntries = 20_000;

export interface TargetProjectSnapshot {
  readonly canonicalPath: string;
  readonly fingerprint: string;
  readonly entries: number;
  readonly contentBytesHashed: number;
  readonly bounded: boolean;
}

const hashFile = async (
  hash: ReturnType<typeof createHash>,
  path: string,
): Promise<void> =>
  new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: string | Buffer) => {
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });

export class TargetProjectGuard {
  async capture(path: string): Promise<TargetProjectSnapshot> {
    let canonicalPath: string;
    try {
      const information = await stat(path);
      if (!information.isDirectory()) {
        throw new Error("Path is not a directory.");
      }
      canonicalPath = await realpath(path);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new ServerError(
        "INVALID_TARGET_PROJECT",
        `Target project path is not usable: ${message}`,
        422,
      );
    }

    const hash = createHash("sha256");
    let entries = 0;
    let contentBytesHashed = 0;
    let bounded = false;

    const walk = async (directory: string): Promise<void> => {
      const children = (await readdir(directory, { withFileTypes: true })).sort(
        (left, right) => left.name.localeCompare(right.name),
      );
      for (const child of children) {
        if (entries >= maximumEntries) {
          bounded = true;
          return;
        }
        if (child.isDirectory() && excludedDirectories.has(child.name)) {
          continue;
        }
        const absolutePath = resolve(directory, child.name);
        const relativePath = relative(canonicalPath, absolutePath).replaceAll("\\", "/");
        const information = await lstat(absolutePath);
        entries += 1;
        hash.update(`${child.isDirectory() ? "d" : child.isFile() ? "f" : "l"}\0${relativePath}\0${information.size}\0${information.mtimeMs}\0`);
        if (child.isDirectory()) {
          await walk(absolutePath);
          continue;
        }
        if (
          child.isFile() &&
          contentBytesHashed + information.size <= maximumContentBytes
        ) {
          await hashFile(hash, absolutePath);
          contentBytesHashed += information.size;
        } else if (child.isFile()) {
          bounded = true;
        }
      }
    };

    try {
      await walk(canonicalPath);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new ServerError(
        "TARGET_PROJECT_INSPECTION_FAILED",
        `Could not fingerprint target project read-only state: ${message}`,
        500,
      );
    }

    return {
      canonicalPath,
      fingerprint: hash.digest("hex"),
      entries,
      contentBytesHashed,
      bounded,
    };
  }

  assertUnchanged(
    before: TargetProjectSnapshot,
    after: TargetProjectSnapshot,
  ): void {
    if (
      before.canonicalPath !== after.canonicalPath ||
      before.fingerprint !== after.fingerprint ||
      before.entries !== after.entries
    ) {
      throw new ServerError(
        "TARGET_PROJECT_MODIFIED_DURING_ANALYSIS",
        "Read-only analysis changed the target project. The change was not reverted automatically.",
        409,
      );
    }
  }
}
