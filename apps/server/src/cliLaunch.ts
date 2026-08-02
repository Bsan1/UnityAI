import { stat } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join } from "node:path";

export interface ProviderLaunch {
  readonly executable: string;
  readonly argumentPrefix: readonly string[];
}

const isFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

const findOnPath = async (name: string): Promise<string | undefined> => {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) {
      continue;
    }
    const candidate = join(directory, name);
    if (await isFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
};

const isExplicitExecutable = (executable: string): boolean =>
  isAbsolute(executable) || dirname(executable) !== "." || extname(executable) !== "";

const windowsTarget = ():
  | { readonly packageSuffix: string; readonly triple: string }
  | undefined => {
  if (process.arch === "x64") {
    return {
      packageSuffix: "win32-x64",
      triple: "x86_64-pc-windows-msvc",
    };
  }
  if (process.arch === "arm64") {
    return {
      packageSuffix: "win32-arm64",
      triple: "aarch64-pc-windows-msvc",
    };
  }
  return undefined;
};

export const resolveCodexLaunch = async (
  executable: string,
): Promise<ProviderLaunch> => {
  if (process.platform !== "win32" || isExplicitExecutable(executable)) {
    return { executable, argumentPrefix: [] };
  }
  const wrapper = await findOnPath(`${executable}.cmd`);
  const target = windowsTarget();
  if (wrapper !== undefined && target !== undefined) {
    const nativeExecutable = join(
      dirname(wrapper),
      "node_modules",
      "@openai",
      "codex",
      "node_modules",
      "@openai",
      `codex-${target.packageSuffix}`,
      "vendor",
      target.triple,
      "bin",
      "codex.exe",
    );
    if (await isFile(nativeExecutable)) {
      return { executable: nativeExecutable, argumentPrefix: [] };
    }
    const nodeEntrypoint = join(
      dirname(wrapper),
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    if (await isFile(nodeEntrypoint)) {
      return {
        executable: process.execPath,
        argumentPrefix: [nodeEntrypoint],
      };
    }
  }
  return { executable, argumentPrefix: [] };
};

export const resolveClaudeLaunch = async (
  executable: string,
): Promise<ProviderLaunch> => {
  if (process.platform !== "win32" || isExplicitExecutable(executable)) {
    return { executable, argumentPrefix: [] };
  }
  const wrapper = await findOnPath(`${executable}.cmd`);
  if (wrapper !== undefined) {
    const nativeExecutable = join(
      dirname(wrapper),
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe",
    );
    if (await isFile(nativeExecutable)) {
      return { executable: nativeExecutable, argumentPrefix: [] };
    }
  }
  return { executable, argumentPrefix: [] };
};
