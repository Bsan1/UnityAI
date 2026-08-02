using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace UnityAI.EditorBridge
{
    internal sealed class BridgeCommands
    {
        private readonly string projectRoot;
        private readonly ConsoleReader console;

        internal BridgeCommands(string projectRoot, ConsoleReader console)
        {
            this.projectRoot = projectRoot;
            this.console = console;
        }

        internal object Execute(BridgeProtocol.Request request)
        {
            switch (request.method)
            {
                case "bridge.ping":
                    return Ping();
                case "editor.status":
                    return Status();
                case "editor.requestCompilation":
                    CompilationPipeline.RequestScriptCompilation();
                    return new BridgeProtocol.RequestedResult { requested = true };
                case "play.enter":
                    EditorApplication.EnterPlaymode();
                    return new BridgeProtocol.RequestedResult { requested = true };
                case "play.exit":
                    EditorApplication.ExitPlaymode();
                    return new BridgeProtocol.RequestedResult { requested = true };
                case "play.setPaused":
                    EditorApplication.isPaused = request.@params.paused;
                    return new BridgeProtocol.PausedResult { paused = EditorApplication.isPaused };
                case "console.get":
                    return console.Read(request.@params.offset, request.@params.limit);
                case "scene.summary":
                    return SceneSummary();
                case "scene.hierarchy":
                    return SceneHierarchy(request.@params);
                case "object.snapshot":
                    return ObjectSnapshot(request.@params);
                default:
                    throw new BridgeCommandException("UNKNOWN_METHOD", "Unknown bridge method: " + request.method);
            }
        }

        private BridgeProtocol.PingResult Ping()
        {
            return new BridgeProtocol.PingResult
            {
                protocolVersion = BridgeProtocol.ProtocolVersion,
                bridgeVersion = BridgeProtocol.BridgeVersion,
                unityVersion = Application.unityVersion,
                projectPath = projectRoot,
                processId = Process.GetCurrentProcess().Id
            };
        }

        private static BridgeProtocol.EditorStatusResult Status()
        {
            return new BridgeProtocol.EditorStatusResult
            {
                isPlaying = EditorApplication.isPlaying,
                isPaused = EditorApplication.isPaused,
                isCompiling = EditorApplication.isCompiling,
                isUpdating = EditorApplication.isUpdating,
                activeScene = SceneManager.GetActiveScene().name ?? string.Empty,
                activePlatform = EditorUserBuildSettings.activeBuildTarget.ToString()
            };
        }

        private static BridgeProtocol.SceneSummaryResult SceneSummary()
        {
            var scenes = new List<BridgeProtocol.SceneInfo>();
            for (var index = 0; index < SceneManager.sceneCount; index++)
            {
                var scene = SceneManager.GetSceneAt(index);
                scenes.Add(new BridgeProtocol.SceneInfo
                {
                    name = scene.name ?? string.Empty,
                    path = scene.path ?? string.Empty,
                    isLoaded = scene.isLoaded,
                    isDirty = scene.isDirty,
                    rootCount = scene.isLoaded ? scene.rootCount : 0
                });
            }
            return new BridgeProtocol.SceneSummaryResult
            {
                activeScene = SceneManager.GetActiveScene().name ?? string.Empty,
                scenes = scenes.ToArray()
            };
        }

        private static BridgeProtocol.HierarchyResult SceneHierarchy(BridgeProtocol.Parameters parameters)
        {
            var offset = Math.Max(0, parameters.offset);
            var maximumObjects = Math.Max(1, Math.Min(parameters.maxObjects <= 0 ? 300 : parameters.maxObjects, 1000));
            var maximumDepth = Math.Max(1, Math.Min(parameters.maxDepth <= 0 ? 6 : parameters.maxDepth, 12));
            var collected = new List<BridgeProtocol.HierarchyObject>();
            var encountered = 0;
            var hasMore = false;

            for (var sceneIndex = 0; sceneIndex < SceneManager.sceneCount && !hasMore; sceneIndex++)
            {
                var scene = SceneManager.GetSceneAt(sceneIndex);
                if (!scene.isLoaded)
                {
                    continue;
                }
                foreach (var root in scene.GetRootGameObjects())
                {
                    Visit(root.transform, scene.name + ":/" + root.name, 0, maximumDepth, offset,
                        maximumObjects, ref encountered, collected, ref hasMore);
                    if (hasMore)
                    {
                        break;
                    }
                }
            }

            return new BridgeProtocol.HierarchyResult
            {
                offset = offset,
                count = collected.Count,
                maxDepth = maximumDepth,
                hasMore = hasMore,
                objects = collected.ToArray()
            };
        }

        private static void Visit(
            Transform transform,
            string path,
            int depth,
            int maximumDepth,
            int offset,
            int maximumObjects,
            ref int encountered,
            List<BridgeProtocol.HierarchyObject> collected,
            ref bool hasMore)
        {
            if (encountered >= offset && collected.Count < maximumObjects)
            {
                collected.Add(HierarchySnapshot(transform.gameObject, path));
            }
            else if (encountered >= offset && collected.Count >= maximumObjects)
            {
                hasMore = true;
                return;
            }
            encountered++;
            if (depth >= maximumDepth)
            {
                return;
            }
            for (var index = 0; index < transform.childCount; index++)
            {
                var child = transform.GetChild(index);
                Visit(child, path + "/" + child.name, depth + 1, maximumDepth, offset,
                    maximumObjects, ref encountered, collected, ref hasMore);
                if (hasMore)
                {
                    return;
                }
            }
        }

        private static BridgeProtocol.ObjectSnapshot ObjectSnapshot(BridgeProtocol.Parameters parameters)
        {
            GameObject gameObject = null;
            if (parameters.instanceId != 0)
            {
                var unityObject = EditorUtility.InstanceIDToObject(parameters.instanceId);
                gameObject = unityObject as GameObject;
                var component = unityObject as Component;
                if (gameObject == null && component != null)
                {
                    gameObject = component.gameObject;
                }
            }
            if (gameObject == null && !string.IsNullOrEmpty(parameters.hierarchyPath))
            {
                gameObject = FindByHierarchyPath(parameters.hierarchyPath);
            }
            if (gameObject == null)
            {
                throw new BridgeCommandException("OBJECT_NOT_FOUND", "No object matched the supplied instance ID or hierarchy path.");
            }

            var path = BuildHierarchyPath(gameObject);
            var baseSnapshot = HierarchySnapshot(gameObject, path);
            var maximumProperties = Math.Max(1, Math.Min(parameters.maxProperties <= 0 ? 100 : parameters.maxProperties, 200));
            var remaining = maximumProperties;
            var complete = true;
            var components = new List<BridgeProtocol.ComponentSnapshot>();
            foreach (var component in gameObject.GetComponents<Component>())
            {
                if (component == null)
                {
                    components.Add(new BridgeProtocol.ComponentSnapshot { typeName = "<MissingScript>" });
                    continue;
                }
                var properties = ReadPrimitiveProperties(component, ref remaining, ref complete);
                components.Add(new BridgeProtocol.ComponentSnapshot
                {
                    typeName = component.GetType().FullName ?? component.GetType().Name,
                    properties = properties.ToArray()
                });
                if (remaining <= 0)
                {
                    complete = false;
                    break;
                }
            }

            return new BridgeProtocol.ObjectSnapshot
            {
                instanceId = baseSnapshot.instanceId,
                hierarchyPath = baseSnapshot.hierarchyPath,
                name = baseSnapshot.name,
                activeSelf = baseSnapshot.activeSelf,
                activeInHierarchy = baseSnapshot.activeInHierarchy,
                tag = baseSnapshot.tag,
                layer = baseSnapshot.layer,
                transform = baseSnapshot.transform,
                componentTypeNames = baseSnapshot.componentTypeNames,
                components = components.ToArray(),
                propertiesComplete = complete
            };
        }

        private static List<BridgeProtocol.SerializedPropertySnapshot> ReadPrimitiveProperties(
            Component component,
            ref int remaining,
            ref bool complete)
        {
            var result = new List<BridgeProtocol.SerializedPropertySnapshot>();
            try
            {
                var serializedObject = new SerializedObject(component);
                var iterator = serializedObject.GetIterator();
                var enterChildren = true;
                while (iterator.NextVisible(enterChildren))
                {
                    enterChildren = false;
                    string value;
                    switch (iterator.propertyType)
                    {
                        case SerializedPropertyType.Integer:
                            value = iterator.longValue.ToString();
                            break;
                        case SerializedPropertyType.Boolean:
                            value = iterator.boolValue ? "true" : "false";
                            break;
                        case SerializedPropertyType.Float:
                            value = iterator.doubleValue.ToString("R");
                            break;
                        case SerializedPropertyType.String:
                            value = Bound(iterator.stringValue, 512);
                            break;
                        case SerializedPropertyType.Enum:
                            value = iterator.enumDisplayNames.Length > iterator.enumValueIndex && iterator.enumValueIndex >= 0
                                ? iterator.enumDisplayNames[iterator.enumValueIndex]
                                : iterator.enumValueIndex.ToString();
                            break;
                        default:
                            continue;
                    }
                    if (remaining <= 0)
                    {
                        complete = false;
                        break;
                    }
                    result.Add(new BridgeProtocol.SerializedPropertySnapshot
                    {
                        path = iterator.propertyPath,
                        type = iterator.propertyType.ToString(),
                        value = value
                    });
                    remaining--;
                }
            }
            catch (Exception)
            {
                complete = false;
            }
            return result;
        }

        private static BridgeProtocol.HierarchyObject HierarchySnapshot(GameObject gameObject, string path)
        {
            var transform = gameObject.transform;
            return new BridgeProtocol.HierarchyObject
            {
                instanceId = gameObject.GetInstanceID(),
                hierarchyPath = Bound(path, 2048),
                name = Bound(gameObject.name, 512),
                activeSelf = gameObject.activeSelf,
                activeInHierarchy = gameObject.activeInHierarchy,
                tag = Bound(SafeTag(gameObject), 128),
                layer = gameObject.layer,
                transform = new BridgeProtocol.TransformSnapshot
                {
                    position = Vector(transform.position),
                    localPosition = Vector(transform.localPosition),
                    rotationEuler = Vector(transform.eulerAngles),
                    localScale = Vector(transform.localScale)
                },
                componentTypeNames = gameObject.GetComponents<Component>()
                    .Select(component => component == null ? "<MissingScript>" : component.GetType().FullName ?? component.GetType().Name)
                    .ToArray()
            };
        }

        private static GameObject FindByHierarchyPath(string requestedPath)
        {
            for (var sceneIndex = 0; sceneIndex < SceneManager.sceneCount; sceneIndex++)
            {
                var scene = SceneManager.GetSceneAt(sceneIndex);
                if (!scene.isLoaded)
                {
                    continue;
                }
                foreach (var root in scene.GetRootGameObjects())
                {
                    var found = FindRecursive(root.transform, scene.name + ":/" + root.name, requestedPath);
                    if (found != null)
                    {
                        return found.gameObject;
                    }
                }
            }
            return null;
        }

        private static Transform FindRecursive(Transform current, string path, string requestedPath)
        {
            if (string.Equals(path, requestedPath, StringComparison.Ordinal))
            {
                return current;
            }
            for (var index = 0; index < current.childCount; index++)
            {
                var child = current.GetChild(index);
                var found = FindRecursive(child, path + "/" + child.name, requestedPath);
                if (found != null)
                {
                    return found;
                }
            }
            return null;
        }

        private static string BuildHierarchyPath(GameObject gameObject)
        {
            var names = new List<string>();
            var current = gameObject.transform;
            while (current != null)
            {
                names.Add(current.name);
                current = current.parent;
            }
            names.Reverse();
            return gameObject.scene.name + ":/" + string.Join("/", names.ToArray());
        }

        private static float[] Vector(Vector3 vector)
        {
            return new[] { vector.x, vector.y, vector.z };
        }

        private static string SafeTag(GameObject gameObject)
        {
            try
            {
                return gameObject.tag;
            }
            catch (Exception)
            {
                return string.Empty;
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
