import { resolve } from "node:path";

import type { TaskId } from "@unityai/core";
import { UnityIntegrationError } from "@unityai/unity";

import { SafeProcessRunner } from "./processRunner.js";
import type { ProcessRunner } from "./processRunner.js";
import type { UnityEditorProcessManager } from "./unityEditorProcessManager.js";

export type WindowsOsInputCommand =
  | { readonly kind: "KEY"; readonly key: keyof typeof WINDOWS_VIRTUAL_KEYS; readonly pressed: boolean }
  | { readonly kind: "MOUSE_MOVE"; readonly x: number; readonly y: number }
  | { readonly kind: "MOUSE_BUTTON"; readonly button: "LEFT" | "RIGHT" | "MIDDLE"; readonly pressed: boolean }
  | { readonly kind: "MOUSE_SCROLL"; readonly delta: number };

export interface WindowsOsInputTarget {
  readonly taskId: TaskId;
  readonly editorProcessId: number;
  readonly managedProjectPath: string;
  readonly projectNameHint: string;
}

export interface WindowsOsInputEvidence {
  readonly inputSource: "WINDOWS_SENDINPUT";
  readonly target: "UNITY_GAME_VIEW";
  readonly editorProcessId: number;
  readonly control: string;
  readonly pressed?: boolean;
  readonly sentAt: string;
  readonly windowTitle: string;
}

export interface WindowsNativeInputBackend {
  send(input: WindowsOsInputTarget & { readonly command: WindowsOsInputCommand }): Promise<{
    readonly windowTitle: string;
  }>;
}

export const WINDOWS_VIRTUAL_KEYS = {
  SPACE: 0x20,
  W: 0x57,
  A: 0x41,
  S: 0x53,
  D: 0x44,
  E: 0x45,
  ESCAPE: 0x1b,
  LEFT_SHIFT: 0x10,
  LEFT_CONTROL: 0x11,
  UP: 0x26,
  DOWN: 0x28,
  LEFT: 0x25,
  RIGHT: 0x27,
} as const;

const fixedNativeScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class UnityAIWindowsInput {
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)] private static extern uint SendInput(uint count, INPUT[] inputs, int size);

  [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint type; public InputUnion union; }
  [StructLayout(LayoutKind.Explicit)] private struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mouse;
    [FieldOffset(0)] public KEYBDINPUT keyboard;
  }
  [StructLayout(LayoutKind.Sequential)] private struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData; public uint flags; public uint time; public UIntPtr extra;
  }
  [StructLayout(LayoutKind.Sequential)] private struct KEYBDINPUT {
    public ushort virtualKey; public ushort scan; public uint flags; public uint time; public UIntPtr extra;
  }

  private static string Title(IntPtr window) {
    var text = new StringBuilder(512);
    GetWindowText(window, text, text.Capacity);
    return text.ToString();
  }

  private static IntPtr FindGameView(uint expectedPid, string projectHint, out string parentTitle) {
    var parents = new List<IntPtr>();
    EnumWindows((window, unused) => {
      uint pid;
      GetWindowThreadProcessId(window, out pid);
      if (pid == expectedPid && IsWindowVisible(window)) parents.Add(window);
      return true;
    }, IntPtr.Zero);
    foreach (var parent in parents) {
      var title = Title(parent);
      if (title.IndexOf("Unity", StringComparison.OrdinalIgnoreCase) < 0 &&
          title.IndexOf(projectHint ?? string.Empty, StringComparison.OrdinalIgnoreCase) < 0) continue;
      IntPtr game = IntPtr.Zero;
      EnumChildWindows(parent, (child, unused) => {
        if (!IsWindowVisible(child)) return true;
        var childTitle = Title(child);
        if (string.Equals(childTitle, "Game", StringComparison.OrdinalIgnoreCase) ||
            childTitle.StartsWith("Game ", StringComparison.OrdinalIgnoreCase)) {
          game = child;
          return false;
        }
        return true;
      }, IntPtr.Zero);
      if (game != IntPtr.Zero) { parentTitle = title; return game; }
    }
    parentTitle = string.Empty;
    return IntPtr.Zero;
  }

  public static string Send(uint pid, string projectHint, string kind, int code, int data, bool pressed, int x, int y) {
    string title;
    var game = FindGameView(pid, projectHint, out title);
    if (game == IntPtr.Zero) throw new InvalidOperationException("Expected Unity Game View window was not positively identified.");
    IntPtr parent = game;
    while (true) {
      var candidate = GetAncestor(parent, 1);
      if (candidate == IntPtr.Zero) break;
      parent = candidate;
    }
    if (!SetForegroundWindow(parent)) throw new InvalidOperationException("Unity Editor could not be brought to the foreground safely.");
    SetFocus(game);
    System.Threading.Thread.Sleep(50);
    uint foregroundPid;
    GetWindowThreadProcessId(GetForegroundWindow(), out foregroundPid);
    if (foregroundPid != pid) throw new InvalidOperationException("Foreground window identity changed before input dispatch.");
    var input = new INPUT();
    if (kind == "KEY") {
      input.type = 1;
      input.union.keyboard.virtualKey = (ushort)code;
      input.union.keyboard.flags = pressed ? 0u : 2u;
    } else {
      input.type = 0;
      input.union.mouse.dx = x;
      input.union.mouse.dy = y;
      input.union.mouse.mouseData = unchecked((uint)data);
      input.union.mouse.flags = (uint)code;
    }
    if (SendInput(1, new [] { input }, Marshal.SizeOf(typeof(INPUT))) != 1)
      throw new InvalidOperationException("Windows SendInput did not accept the guarded input event.");
    return title;
  }

  [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
}
'@
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$title = [UnityAIWindowsInput]::Send(
  [uint32]$request.editorProcessId,
  [string]$request.projectNameHint,
  [string]$request.kind,
  [int]$request.code,
  [int]$request.data,
  [bool]$request.pressed,
  [int]$request.x,
  [int]$request.y
)
@{ windowTitle = $title } | ConvertTo-Json -Compress
`;

const mouseCode = (command: Extract<WindowsOsInputCommand, { readonly kind: "MOUSE_BUTTON" }>): number => {
  if (command.button === "LEFT") return command.pressed ? 0x0002 : 0x0004;
  if (command.button === "RIGHT") return command.pressed ? 0x0008 : 0x0010;
  return command.pressed ? 0x0020 : 0x0040;
};

export class NativeWindowsInputBackend implements WindowsNativeInputBackend {
  private readonly runner: ProcessRunner;

  constructor(runner: ProcessRunner = new SafeProcessRunner()) {
    this.runner = runner;
  }

  async send(input: WindowsOsInputTarget & { readonly command: WindowsOsInputCommand }): Promise<{
    readonly windowTitle: string;
  }> {
    if (process.platform !== "win32") {
      throw new UnityIntegrationError("OS_INPUT_FOCUS_UNSAFE", "Windows SendInput fallback is unavailable on this operating system.");
    }
    const command = input.command;
    const payload = command.kind === "KEY"
      ? { kind: "KEY", code: WINDOWS_VIRTUAL_KEYS[command.key], data: 0, pressed: command.pressed, x: 0, y: 0 }
      : command.kind === "MOUSE_MOVE"
        ? { kind: "MOUSE_MOVE", code: 0x0001, data: 0, pressed: false, x: command.x, y: command.y }
        : command.kind === "MOUSE_SCROLL"
          ? { kind: "MOUSE_SCROLL", code: 0x0800, data: command.delta, pressed: false, x: 0, y: 0 }
          : { kind: "MOUSE_BUTTON", code: mouseCode(command), data: 0, pressed: command.pressed, x: 0, y: 0 };
    const result = await this.runner.run({
      executable: "powershell.exe",
      arguments: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(fixedNativeScript, "utf16le").toString("base64"),
      ],
      workingDirectory: input.managedProjectPath,
      input: JSON.stringify({
        editorProcessId: input.editorProcessId,
        projectNameHint: input.projectNameHint,
        ...payload,
      }),
      timeoutMs: 5_000,
      maximumCaptureBytes: 16_384,
    });
    if (result.status !== "EXITED" || result.exitCode !== 0) {
      throw new UnityIntegrationError(
        "OS_INPUT_FOCUS_UNSAFE",
        `Guarded Windows input was refused: ${result.stderr.trim() || result.spawnError || result.status}`,
      );
    }
    try {
      const parsed = JSON.parse(result.stdout.trim()) as { readonly windowTitle?: unknown };
      if (typeof parsed.windowTitle !== "string" || parsed.windowTitle.length === 0) {
        throw new Error("missing window title");
      }
      return { windowTitle: parsed.windowTitle };
    } catch {
      throw new UnityIntegrationError("OS_INPUT_FOCUS_UNSAFE", "Guarded Windows input returned invalid target evidence.");
    }
  }
}

export class WindowsOsInputFallback {
  private readonly editors: UnityEditorProcessManager;
  private readonly backend: WindowsNativeInputBackend;
  private readonly held = new Map<TaskId, WindowsOsInputCommand[]>();

  constructor(editors: UnityEditorProcessManager, backend: WindowsNativeInputBackend = new NativeWindowsInputBackend()) {
    this.editors = editors;
    this.backend = backend;
  }

  async send(target: WindowsOsInputTarget, command: WindowsOsInputCommand): Promise<WindowsOsInputEvidence> {
    this.assertTarget(target);
    const sent = await this.backend.send({ ...target, command });
    const controls = this.held.get(target.taskId) ?? [];
    if ((command.kind === "KEY" || command.kind === "MOUSE_BUTTON") && command.pressed) {
      controls.push(command);
      this.held.set(target.taskId, controls);
    } else if (command.kind === "KEY" || command.kind === "MOUSE_BUTTON") {
      this.held.set(target.taskId, controls.filter((held) =>
        held.kind !== command.kind ||
        (held.kind === "KEY" && command.kind === "KEY" && held.key !== command.key) ||
        (held.kind === "MOUSE_BUTTON" && command.kind === "MOUSE_BUTTON" && held.button !== command.button),
      ));
    }
    return {
      inputSource: "WINDOWS_SENDINPUT",
      target: "UNITY_GAME_VIEW",
      editorProcessId: target.editorProcessId,
      control: command.kind === "KEY"
        ? command.key
        : command.kind === "MOUSE_BUTTON"
          ? command.button
          : command.kind,
      ...("pressed" in command ? { pressed: command.pressed } : {}),
      sentAt: new Date().toISOString(),
      windowTitle: sent.windowTitle,
    };
  }

  async releaseAll(target: WindowsOsInputTarget): Promise<number> {
    this.assertTarget(target);
    const held = this.held.get(target.taskId) ?? [];
    let released = 0;
    for (const command of held) {
      const release = command.kind === "KEY"
        ? { ...command, pressed: false } as const
        : command.kind === "MOUSE_BUTTON"
          ? { ...command, pressed: false } as const
          : undefined;
      if (release !== undefined) {
        await this.backend.send({ ...target, command: release });
        released++;
      }
    }
    this.held.delete(target.taskId);
    return released;
  }

  private assertTarget(target: WindowsOsInputTarget): void {
    if (
      !this.editors.isOwned(target.taskId, target.editorProcessId) ||
      this.editors.projectPath(target.taskId) === undefined ||
      resolve(this.editors.projectPath(target.taskId) as string) !== resolve(target.managedProjectPath)
    ) {
      throw new UnityIntegrationError(
        "OS_INPUT_FOCUS_UNSAFE",
        "OS input requires a positively identified UnityAI-owned Editor for the exact managed task worktree.",
      );
    }
  }
}
