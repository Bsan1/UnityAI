using System;
using System.Collections.Generic;
using System.Text;
using UnityEngine;

namespace UnityAI.EditorBridge
{
    internal static class BridgeProtocol
    {
        internal const int ProtocolVersion = 1;
        internal const string BridgeVersion = "0.2.0";
        internal const int MaximumRequestBytes = 262144;
        internal const int CommandTimeoutMilliseconds = 15000;

        [Serializable]
        internal sealed class Request
        {
            public string id = string.Empty;
            public string token = string.Empty;
            public int protocolVersion;
            public string method = string.Empty;
            public Parameters @params = new Parameters();
        }

        [Serializable]
        internal sealed class Parameters
        {
            public bool paused;
            public int limit;
            public int offset;
            public int maxDepth;
            public int maxObjects;
            public int instanceId;
            public string hierarchyPath = string.Empty;
            public int maxProperties;
        }

        [Serializable]
        internal sealed class SessionDescriptor
        {
            public int protocolVersion;
            public string bridgeVersion = string.Empty;
            public string projectRoot = string.Empty;
            public string unityVersion = string.Empty;
            public int editorProcessId;
            public string host = string.Empty;
            public int port;
            public string sessionToken = string.Empty;
            public string startedAt = string.Empty;
        }

        [Serializable]
        internal sealed class PingResult
        {
            public int protocolVersion;
            public string bridgeVersion = string.Empty;
            public string unityVersion = string.Empty;
            public string projectPath = string.Empty;
            public int processId;
        }

        [Serializable]
        internal sealed class EditorStatusResult
        {
            public bool isPlaying;
            public bool isPaused;
            public bool isCompiling;
            public bool isUpdating;
            public string activeScene = string.Empty;
            public string activePlatform = string.Empty;
            public CompilationResult lastCompilation;
        }

        [Serializable]
        internal sealed class RequestedResult
        {
            public bool requested;
            public string requestId = string.Empty;
        }

        [Serializable]
        internal sealed class CompilationMessage
        {
            public string severity = string.Empty;
            public string message = string.Empty;
            public string file = string.Empty;
            public int line;
            public int column;
        }

        [Serializable]
        internal sealed class CompilationResult
        {
            public string requestId = string.Empty;
            public string requestedAt = string.Empty;
            public bool completed;
            public string completedAt = string.Empty;
            public int errorCount;
            public int warningCount;
            public bool messagesTruncated;
            public CompilationMessage[] messages = Array.Empty<CompilationMessage>();
        }

        [Serializable]
        internal sealed class PausedResult
        {
            public bool paused;
        }

        [Serializable]
        internal sealed class ConsoleEntry
        {
            public string severity = string.Empty;
            public string message = string.Empty;
            public string stackTrace = string.Empty;
            public string timestamp = string.Empty;
            public long sequence;
        }

        [Serializable]
        internal sealed class ConsoleResult
        {
            public bool complete;
            public int offset;
            public int count;
            public int totalAvailable;
            public ConsoleEntry[] entries = Array.Empty<ConsoleEntry>();
        }

        [Serializable]
        internal sealed class SceneInfo
        {
            public string name = string.Empty;
            public string path = string.Empty;
            public bool isLoaded;
            public bool isDirty;
            public int rootCount;
        }

        [Serializable]
        internal sealed class SceneSummaryResult
        {
            public string activeScene = string.Empty;
            public SceneInfo[] scenes = Array.Empty<SceneInfo>();
        }

        [Serializable]
        internal sealed class TransformSnapshot
        {
            public float[] position = Array.Empty<float>();
            public float[] localPosition = Array.Empty<float>();
            public float[] rotationEuler = Array.Empty<float>();
            public float[] localScale = Array.Empty<float>();
        }

        [Serializable]
        internal class HierarchyObject
        {
            public int instanceId;
            public string hierarchyPath = string.Empty;
            public string name = string.Empty;
            public bool activeSelf;
            public bool activeInHierarchy;
            public string tag = string.Empty;
            public int layer;
            public TransformSnapshot transform = new TransformSnapshot();
            public string[] componentTypeNames = Array.Empty<string>();
        }

        [Serializable]
        internal sealed class HierarchyResult
        {
            public int offset;
            public int count;
            public int maxDepth;
            public bool hasMore;
            public HierarchyObject[] objects = Array.Empty<HierarchyObject>();
        }

        [Serializable]
        internal sealed class SerializedPropertySnapshot
        {
            public string path = string.Empty;
            public string type = string.Empty;
            public string value = string.Empty;
        }

        [Serializable]
        internal sealed class ComponentSnapshot
        {
            public string typeName = string.Empty;
            public SerializedPropertySnapshot[] properties = Array.Empty<SerializedPropertySnapshot>();
        }

        [Serializable]
        internal sealed class ObjectSnapshot : HierarchyObject
        {
            public ComponentSnapshot[] components = Array.Empty<ComponentSnapshot>();
            public bool propertiesComplete;
        }

        internal static Request ParseRequest(string json)
        {
            Request request;
            try
            {
                request = JsonUtility.FromJson<Request>(json);
            }
            catch (Exception exception)
            {
                throw new BridgeCommandException("INVALID_REQUEST", "Request JSON is invalid: " + exception.Message);
            }

            if (request == null || string.IsNullOrEmpty(request.id) || string.IsNullOrEmpty(request.method))
            {
                throw new BridgeCommandException("INVALID_REQUEST", "Request id and method are required.");
            }

            if (request.@params == null)
            {
                request.@params = new Parameters();
            }

            return request;
        }

        internal static string Success(string id, object result)
        {
            return "{\"id\":" + Quote(id) + ",\"ok\":true,\"result\":" + JsonUtility.ToJson(result) + "}";
        }

        internal static string Failure(string id, string code, string message)
        {
            return "{\"id\":" + Quote(id ?? string.Empty) + ",\"ok\":false,\"error\":{\"code\":" +
                   Quote(code) + ",\"message\":" + Quote(message) + "}}";
        }

        private static string Quote(string value)
        {
            var builder = new StringBuilder(value.Length + 2);
            builder.Append('"');
            foreach (var character in value)
            {
                switch (character)
                {
                    case '"': builder.Append("\\\""); break;
                    case '\\': builder.Append("\\\\"); break;
                    case '\b': builder.Append("\\b"); break;
                    case '\f': builder.Append("\\f"); break;
                    case '\n': builder.Append("\\n"); break;
                    case '\r': builder.Append("\\r"); break;
                    case '\t': builder.Append("\\t"); break;
                    default:
                        if (character < 32)
                        {
                            builder.Append("\\u");
                            builder.Append(((int)character).ToString("x4"));
                        }
                        else
                        {
                            builder.Append(character);
                        }
                        break;
                }
            }
            builder.Append('"');
            return builder.ToString();
        }
    }

    internal sealed class BridgeCommandException : Exception
    {
        internal string Code { get; }

        internal BridgeCommandException(string code, string message) : base(message)
        {
            Code = code;
        }
    }
}
