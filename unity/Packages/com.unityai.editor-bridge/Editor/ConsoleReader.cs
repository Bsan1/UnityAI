using System;
using System.Collections.Generic;
using UnityEngine;

namespace UnityAI.EditorBridge
{
    internal sealed class ConsoleReader : IDisposable
    {
        private const int Capacity = 1000;
        private const int MaximumMessageCharacters = 8192;
        private const int MaximumStackCharacters = 16384;
        private readonly object gate = new object();
        private readonly List<BridgeProtocol.ConsoleEntry> entries = new List<BridgeProtocol.ConsoleEntry>();
        private long sequence;

        internal ConsoleReader()
        {
            Application.logMessageReceivedThreaded += OnLog;
        }

        public void Dispose()
        {
            Application.logMessageReceivedThreaded -= OnLog;
        }

        internal BridgeProtocol.ConsoleResult Read(int requestedOffset, int requestedLimit)
        {
            var offset = Math.Max(0, requestedOffset);
            var limit = Math.Max(1, Math.Min(requestedLimit <= 0 ? 100 : requestedLimit, 200));
            lock (gate)
            {
                var available = entries.Count;
                var start = Math.Min(offset, available);
                var count = Math.Min(limit, available - start);
                var result = new BridgeProtocol.ConsoleEntry[count];
                for (var index = 0; index < count; index++)
                {
                    result[index] = entries[start + index];
                }

                return new BridgeProtocol.ConsoleResult
                {
                    complete = false,
                    offset = offset,
                    count = count,
                    totalAvailable = available,
                    entries = result
                };
            }
        }

        private void OnLog(string condition, string stackTrace, LogType type)
        {
            var entry = new BridgeProtocol.ConsoleEntry
            {
                severity = Severity(type),
                message = Bound(condition, MaximumMessageCharacters),
                stackTrace = Bound(stackTrace, MaximumStackCharacters),
                timestamp = DateTime.UtcNow.ToString("o"),
                sequence = System.Threading.Interlocked.Increment(ref sequence)
            };
            lock (gate)
            {
                entries.Add(entry);
                if (entries.Count > Capacity)
                {
                    entries.RemoveRange(0, entries.Count - Capacity);
                }
            }
        }

        private static string Severity(LogType type)
        {
            switch (type)
            {
                case LogType.Error:
                case LogType.Exception:
                case LogType.Assert:
                    return "error";
                case LogType.Warning:
                    return "warning";
                default:
                    return "log";
            }
        }

        private static string Bound(string value, int maximum)
        {
            if (string.IsNullOrEmpty(value) || value.Length <= maximum)
            {
                return value ?? string.Empty;
            }
            return value.Substring(0, maximum) + "…[truncated]";
        }
    }
}
