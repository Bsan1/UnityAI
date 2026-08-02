using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;

namespace UnityAI.EditorBridge
{
    internal sealed class CompilationTracker : IDisposable
    {
        private const int MaximumMessages = 500;
        private const int MaximumMessageCharacters = 8192;
        private readonly string resultPath;
        private BridgeProtocol.CompilationResult current;

        internal CompilationTracker(string projectRoot)
        {
            resultPath = Path.Combine(projectRoot, "Library", "UnityAI", "compilation-result.json");
            current = Load();
            if (current != null && !current.completed && !EditorApplication.isCompiling)
            {
                current.completed = true;
                current.completedAt = DateTime.UtcNow.ToString("o");
                Persist();
            }
            CompilationPipeline.assemblyCompilationFinished += OnAssemblyCompilationFinished;
            CompilationPipeline.compilationFinished += OnCompilationFinished;
        }

        public void Dispose()
        {
            CompilationPipeline.assemblyCompilationFinished -= OnAssemblyCompilationFinished;
            CompilationPipeline.compilationFinished -= OnCompilationFinished;
        }

        internal string Begin()
        {
            current = new BridgeProtocol.CompilationResult
            {
                requestId = Guid.NewGuid().ToString("N"),
                requestedAt = DateTime.UtcNow.ToString("o"),
                completed = false,
                completedAt = string.Empty,
                errorCount = 0,
                warningCount = 0,
                messagesTruncated = false,
                messages = Array.Empty<BridgeProtocol.CompilationMessage>()
            };
            Persist();
            return current.requestId;
        }

        internal BridgeProtocol.CompilationResult Snapshot()
        {
            return current;
        }

        private void OnAssemblyCompilationFinished(string assemblyPath, CompilerMessage[] compilerMessages)
        {
            if (current == null || current.completed)
            {
                return;
            }
            var messages = new List<BridgeProtocol.CompilationMessage>(current.messages ?? Array.Empty<BridgeProtocol.CompilationMessage>());
            foreach (var compilerMessage in compilerMessages ?? Array.Empty<CompilerMessage>())
            {
                if (compilerMessage.type == CompilerMessageType.Error)
                {
                    current.errorCount += 1;
                }
                else if (compilerMessage.type == CompilerMessageType.Warning)
                {
                    current.warningCount += 1;
                }
                if (messages.Count >= MaximumMessages)
                {
                    current.messagesTruncated = true;
                    continue;
                }
                messages.Add(new BridgeProtocol.CompilationMessage
                {
                    severity = compilerMessage.type == CompilerMessageType.Error ? "error" : "warning",
                    message = Bound(compilerMessage.message),
                    file = compilerMessage.file ?? string.Empty,
                    line = compilerMessage.line,
                    column = compilerMessage.column
                });
            }
            current.messages = messages.ToArray();
            Persist();
        }

        private void OnCompilationFinished(object context)
        {
            if (current == null || current.completed)
            {
                return;
            }
            current.completed = true;
            current.completedAt = DateTime.UtcNow.ToString("o");
            Persist();
        }

        private BridgeProtocol.CompilationResult Load()
        {
            try
            {
                if (!File.Exists(resultPath))
                {
                    return null;
                }
                return JsonUtility.FromJson<BridgeProtocol.CompilationResult>(File.ReadAllText(resultPath));
            }
            catch
            {
                return null;
            }
        }

        private void Persist()
        {
            if (current == null)
            {
                return;
            }
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(resultPath));
                var temporary = resultPath + ".tmp";
                File.WriteAllText(temporary, JsonUtility.ToJson(current));
                if (File.Exists(resultPath))
                {
                    File.Delete(resultPath);
                }
                File.Move(temporary, resultPath);
            }
            catch (Exception exception)
            {
                Debug.LogWarning("UnityAI could not persist compilation evidence: " + exception.Message);
            }
        }

        private static string Bound(string value)
        {
            if (string.IsNullOrEmpty(value) || value.Length <= MaximumMessageCharacters)
            {
                return value ?? string.Empty;
            }
            return value.Substring(0, MaximumMessageCharacters) + "...[truncated]";
        }
    }
}
