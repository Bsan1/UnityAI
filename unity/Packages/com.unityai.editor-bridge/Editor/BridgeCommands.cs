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
    internal sealed class BridgeCommands : IDisposable
    {
        private readonly string projectRoot;
        private readonly ConsoleReader console;
        private readonly CompilationTracker compilation;
        private readonly InputQaController input;

        internal BridgeCommands(string projectRoot, ConsoleReader console, CompilationTracker compilation)
        {
            this.projectRoot = projectRoot;
            this.console = console;
            this.compilation = compilation;
            input = new InputQaController();
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
                    var requestId = compilation.Begin();
                    CompilationPipeline.RequestScriptCompilation();
                    return new BridgeProtocol.RequestedResult { requested = true, requestId = requestId };
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
                case "play.reloadScene":
                    return ReloadScene();
                case "input.capabilities":
                    return input.Capabilities();
                case "input.bindings":
                    return input.Bindings(request.@params);
                case "input.resolveAction":
                    return input.ResolveAction(request.@params);
                case "input.control":
                    return input.SetControl(request.@params);
                case "input.releaseAll":
                    return input.ReleaseAll(true);
                case "gameView.screenshot":
                    return VisualEvidence.Capture(projectRoot, request.@params);
                case "runtime.probe":
                    return RuntimeProbe(request.@params);
                default:
                    throw new BridgeCommandException("UNKNOWN_METHOD", "Unknown bridge method: " + request.method);
            }
        }

        public void Dispose()
        {
            input.Dispose();
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

        private BridgeProtocol.EditorStatusResult Status()
        {
            return new BridgeProtocol.EditorStatusResult
            {
                isPlaying = EditorApplication.isPlaying,
                isPaused = EditorApplication.isPaused,
                isCompiling = EditorApplication.isCompiling,
                isUpdating = EditorApplication.isUpdating,
                activeScene = SceneManager.GetActiveScene().name ?? string.Empty,
                activePlatform = EditorUserBuildSettings.activeBuildTarget.ToString(),
                frameCount = Time.frameCount,
                lastCompilation = compilation.Snapshot()
            };
        }

        private static BridgeProtocol.RequestedResult ReloadScene()
        {
            if (!EditorApplication.isPlaying)
            {
                throw new BridgeCommandException("INPUT_NOT_ACTIVE", "Scene reload requires Play Mode.");
            }
            var scene = SceneManager.GetActiveScene();
            if (!scene.IsValid() || !scene.isLoaded)
            {
                throw new BridgeCommandException("COMMAND_FAILED", "No loaded active scene is available to reload.");
            }
            if (scene.buildIndex >= 0)
            {
                SceneManager.LoadScene(scene.buildIndex);
            }
            else if (!string.IsNullOrEmpty(scene.path))
            {
                SceneManager.LoadScene(scene.path);
            }
            else
            {
                SceneManager.LoadScene(scene.name);
            }
            return new BridgeProtocol.RequestedResult { requested = true };
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

        private static BridgeProtocol.RuntimeProbeResult RuntimeProbe(BridgeProtocol.Parameters parameters)
        {
            if (!EditorApplication.isPlaying)
            {
                throw new BridgeCommandException("INPUT_NOT_ACTIVE", "Runtime probes require Play Mode.");
            }
            GameObject gameObject = null;
            if (parameters.instanceId != 0)
            {
                var unityObject = EditorUtility.InstanceIDToObject(parameters.instanceId);
                gameObject = unityObject as GameObject;
                var sourceComponent = unityObject as Component;
                if (gameObject == null && sourceComponent != null)
                {
                    gameObject = sourceComponent.gameObject;
                }
            }
            if (gameObject == null && !string.IsNullOrEmpty(parameters.hierarchyPath))
            {
                gameObject = FindByHierarchyPath(parameters.hierarchyPath);
            }
            if (gameObject == null || string.IsNullOrWhiteSpace(parameters.componentType) || string.IsNullOrWhiteSpace(parameters.propertyPath))
            {
                throw new BridgeCommandException("RUNTIME_PROBE_INVALID", "Runtime probe requires an object, component type, and serialized property path.");
            }

            var path = BuildHierarchyPath(gameObject);
            if (string.Equals(parameters.componentType, "Transform", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(parameters.componentType, typeof(Transform).FullName, StringComparison.Ordinal))
            {
                return TransformProbe(gameObject.transform, path, parameters.propertyPath);
            }
            var component = gameObject.GetComponents<Component>().FirstOrDefault(candidate => candidate != null &&
                (string.Equals(candidate.GetType().Name, parameters.componentType, StringComparison.Ordinal) ||
                 string.Equals(candidate.GetType().FullName, parameters.componentType, StringComparison.Ordinal)));
            if (component == null)
            {
                throw new BridgeCommandException("RUNTIME_PROBE_INVALID", "The requested component was not found on the runtime object.");
            }
            try
            {
                var serialized = new SerializedObject(component);
                var property = serialized.FindProperty(parameters.propertyPath);
                if (property == null || property.isArray)
                {
                    throw new BridgeCommandException("RUNTIME_PROBE_INVALID", "The requested serialized primitive property was not found or is a collection.");
                }
                string value;
                string valueType;
                var truncated = false;
                switch (property.propertyType)
                {
                    case SerializedPropertyType.Integer:
                        value = property.longValue.ToString();
                        valueType = "Integer";
                        break;
                    case SerializedPropertyType.Boolean:
                        value = property.boolValue ? "true" : "false";
                        valueType = "Boolean";
                        break;
                    case SerializedPropertyType.Float:
                        value = property.doubleValue.ToString("R");
                        valueType = "Float";
                        break;
                    case SerializedPropertyType.String:
                        truncated = property.stringValue != null && property.stringValue.Length > 1024;
                        value = Bound(property.stringValue, 1024);
                        valueType = "String";
                        break;
                    case SerializedPropertyType.Enum:
                        value = property.enumValueIndex >= 0 && property.enumDisplayNames.Length > property.enumValueIndex
                            ? property.enumDisplayNames[property.enumValueIndex]
                            : property.enumValueIndex.ToString();
                        valueType = "Enum";
                        break;
                    case SerializedPropertyType.Vector2:
                        value = Format(property.vector2Value);
                        valueType = "Vector2";
                        break;
                    case SerializedPropertyType.Vector3:
                        value = Format(property.vector3Value);
                        valueType = "Vector3";
                        break;
                    case SerializedPropertyType.Quaternion:
                        value = Format(property.quaternionValue);
                        valueType = "Quaternion";
                        break;
                    case SerializedPropertyType.Color:
                        value = Format(property.colorValue);
                        valueType = "Color";
                        break;
                    case SerializedPropertyType.ObjectReference:
                        value = property.objectReferenceValue == null
                            ? "null"
                            : property.objectReferenceValue.GetType().FullName + ":" + Bound(property.objectReferenceValue.name, 256);
                        valueType = "ObjectReference";
                        break;
                    default:
                        throw new BridgeCommandException("RUNTIME_PROBE_INVALID", "The requested property type is not in the bounded runtime probe allowlist.");
                }
                return new BridgeProtocol.RuntimeProbeResult
                {
                    hierarchyPath = path,
                    componentType = component.GetType().FullName ?? component.GetType().Name,
                    propertyPath = property.propertyPath,
                    valueType = valueType,
                    value = value,
                    truncated = truncated
                };
            }
            catch (BridgeCommandException)
            {
                throw;
            }
            catch (Exception exception)
            {
                throw new BridgeCommandException("RUNTIME_PROBE_INVALID", "Runtime probe failed: " + exception.Message);
            }
        }

        private static BridgeProtocol.RuntimeProbeResult TransformProbe(Transform transform, string path, string propertyPath)
        {
            string value;
            string valueType;
            switch (propertyPath)
            {
                case "position": value = Format(transform.position); valueType = "Vector3"; break;
                case "localPosition": value = Format(transform.localPosition); valueType = "Vector3"; break;
                case "rotation": value = Format(transform.rotation); valueType = "Quaternion"; break;
                case "localRotation": value = Format(transform.localRotation); valueType = "Quaternion"; break;
                case "localScale": value = Format(transform.localScale); valueType = "Vector3"; break;
                default:
                    throw new BridgeCommandException("RUNTIME_PROBE_INVALID", "Transform probe supports position, localPosition, rotation, localRotation, and localScale only.");
            }
            return new BridgeProtocol.RuntimeProbeResult
            {
                hierarchyPath = path,
                componentType = typeof(Transform).FullName,
                propertyPath = propertyPath,
                valueType = valueType,
                value = value,
                truncated = false
            };
        }

        private static string Format(Vector2 value)
        {
            return "[" + value.x.ToString("R") + "," + value.y.ToString("R") + "]";
        }

        private static string Format(Vector3 value)
        {
            return "[" + value.x.ToString("R") + "," + value.y.ToString("R") + "," + value.z.ToString("R") + "]";
        }

        private static string Format(Quaternion value)
        {
            return "[" + value.x.ToString("R") + "," + value.y.ToString("R") + "," + value.z.ToString("R") + "," + value.w.ToString("R") + "]";
        }

        private static string Format(Color value)
        {
            return "[" + value.r.ToString("R") + "," + value.g.ToString("R") + "," + value.b.ToString("R") + "," + value.a.ToString("R") + "]";
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
