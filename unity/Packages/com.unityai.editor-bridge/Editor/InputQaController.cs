using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEngine;

namespace UnityAI.EditorBridge
{
    // Input System integration is deliberately implemented through a fixed,
    // internal compatibility surface. No reflected type/member is supplied by
    // the caller and no reflection capability is exposed through the bridge.
    internal sealed class InputQaController : IDisposable
    {
        private const int MaximumBindings = 1000;
        private readonly Type inputSystemType;
        private readonly Type playerInputType;
        private readonly Dictionary<string, object> ownedDevices = new Dictionary<string, object>(StringComparer.Ordinal);
        private readonly Dictionary<string, HeldControl> heldControls = new Dictionary<string, HeldControl>(StringComparer.Ordinal);
        private bool disposed;

        internal InputQaController()
        {
            inputSystemType = Type.GetType("UnityEngine.InputSystem.InputSystem, Unity.InputSystem", false);
            playerInputType = Type.GetType("UnityEngine.InputSystem.PlayerInput, Unity.InputSystem", false);
            EditorApplication.playModeStateChanged += OnPlayModeStateChanged;
        }

        internal BridgeProtocol.InputCapabilitiesResult Capabilities()
        {
            var available = inputSystemType != null;
            return new BridgeProtocol.InputCapabilitiesResult
            {
                inputSystemAvailable = available,
#if ENABLE_LEGACY_INPUT_MANAGER
                legacyInputAvailable = true,
#else
                legacyInputAvailable = false,
#endif
#if ENABLE_INPUT_SYSTEM && ENABLE_LEGACY_INPUT_MANAGER
                activeInputHandling = "BOTH",
#elif ENABLE_INPUT_SYSTEM
                activeInputHandling = "NEW",
#elif ENABLE_LEGACY_INPUT_MANAGER
                activeInputHandling = "OLD",
#else
                activeInputHandling = "UNKNOWN",
#endif
                virtualDevicesSupported = available
                    ? new[] { "KEYBOARD", "MOUSE", "GAMEPAD" }
                    : Array.Empty<string>(),
                qaOwnedDevices = ownedDevices.Select(pair => new BridgeProtocol.OwnedInputDevice
                {
                    device = pair.Key,
                    name = ReadString(pair.Value, "name"),
                    deviceId = ReadInt(pair.Value, "deviceId")
                }).ToArray()
            };
        }

        internal BridgeProtocol.InputBindingsResult Bindings(BridgeProtocol.Parameters parameters)
        {
            EnsureInputSystem();
            var maximum = Math.Max(1, Math.Min(parameters.maxBindings <= 0 ? 300 : parameters.maxBindings, MaximumBindings));
            var all = ReadBindings(parameters.action, parameters.actionMap, maximum + 1);
            var hasMore = all.Count > maximum;
            var bounded = all.Take(maximum).ToArray();
            return new BridgeProtocol.InputBindingsResult
            {
                complete = !hasMore,
                count = bounded.Length,
                hasMore = hasMore,
                bindings = bounded
            };
        }

        internal BridgeProtocol.InputActionResolutionResult ResolveAction(BridgeProtocol.Parameters parameters)
        {
            EnsureInputSystem();
            if (string.IsNullOrWhiteSpace(parameters.action))
            {
                throw new BridgeCommandException("INPUT_BINDING_UNSUPPORTED", "An Input System action name is required.");
            }
            var bindings = ReadBindings(parameters.action, parameters.actionMap, MaximumBindings)
                .Where(binding => string.Equals(binding.action, parameters.action, StringComparison.OrdinalIgnoreCase))
                .Where(binding => string.IsNullOrEmpty(parameters.actionMap) ||
                    string.Equals(binding.actionMap, parameters.actionMap, StringComparison.OrdinalIgnoreCase))
                .ToList();
            if (bindings.Count == 0)
            {
                throw new BridgeCommandException("INPUT_BINDING_UNSUPPORTED", "No loaded Input System binding matched action " + parameters.action + ".");
            }

            for (var index = 0; index < bindings.Count; index++)
            {
                var binding = bindings[index];
                if (!binding.isComposite && !binding.isPartOfComposite && IsSupportedButtonPath(binding.effectivePath))
                {
                    return new BridgeProtocol.InputActionResolutionResult
                    {
                        action = binding.action,
                        actionMap = binding.actionMap,
                        mode = "BUTTON",
                        controls = new[]
                        {
                            new BridgeProtocol.ResolvedInputControl { role = "button", path = binding.effectivePath }
                        }
                    };
                }
                if (!binding.isComposite)
                {
                    continue;
                }
                var controls = new List<BridgeProtocol.ResolvedInputControl>();
                var part = index + 1;
                while (part < bindings.Count && bindings[part].isPartOfComposite)
                {
                    var partBinding = bindings[part];
                    if (IsSupportedControlPath(partBinding.effectivePath))
                    {
                        controls.Add(new BridgeProtocol.ResolvedInputControl
                        {
                            role = string.IsNullOrEmpty(partBinding.bindingName) ? "part" : partBinding.bindingName,
                            path = partBinding.effectivePath
                        });
                    }
                    part++;
                }
                if (controls.Count < 2)
                {
                    continue;
                }
                var compositeName = (binding.bindingName + " " + binding.path).ToLowerInvariant();
                var oneDimensional = compositeName.Contains("1d") || compositeName.Contains("axis");
                return new BridgeProtocol.InputActionResolutionResult
                {
                    action = binding.action,
                    actionMap = binding.actionMap,
                    mode = oneDimensional ? "AXIS_1D" : "VECTOR_2D",
                    controls = controls.ToArray()
                };
            }
            throw new BridgeCommandException(
                "INPUT_BINDING_UNSUPPORTED",
                "Action " + parameters.action + " does not have a safely supported keyboard, mouse, gamepad, or simple composite binding."
            );
        }

        internal BridgeProtocol.InputCommandResult SetControl(BridgeProtocol.Parameters parameters)
        {
            EnsureInputActive();
            var deviceKind = (parameters.device ?? string.Empty).Trim().ToUpperInvariant();
            if (deviceKind != "KEYBOARD" && deviceKind != "MOUSE" && deviceKind != "GAMEPAD")
            {
                throw new BridgeCommandException("INPUT_BINDING_UNSUPPORTED", "Input device must be KEYBOARD, MOUSE, or GAMEPAD.");
            }
            var controlName = NormalizeControl(parameters.control);
            if (deviceKind == "MOUSE" && string.Equals(controlName, "press", StringComparison.OrdinalIgnoreCase))
            {
                controlName = "leftButton";
            }
            if (string.IsNullOrEmpty(controlName) || parameters.value == null || parameters.value.Length < 1 || parameters.value.Length > 2)
            {
                throw new BridgeCommandException("INPUT_BINDING_UNSUPPORTED", "Input control and one or two finite values are required.");
            }
            if (parameters.value.Any(value => float.IsNaN(value) || float.IsInfinity(value) || Math.Abs(value) > 100000f))
            {
                throw new BridgeCommandException("INPUT_BINDING_UNSUPPORTED", "Input values must be finite and bounded.");
            }

            var device = GetOrCreateDevice(deviceKind);
            var control = FindControl(device, controlName);
            var value = ValueForControl(deviceKind, controlName, parameters.value);
            var key = deviceKind + ":" + controlName;
            if (parameters.value.Any(component => Math.Abs(component) > 0.00001f))
            {
                heldControls[key] = new HeldControl(deviceKind, controlName, control, value);
            }
            else
            {
                heldControls.Remove(key);
            }
            if (UsesFullDeviceState(deviceKind, controlName))
            {
                QueueDeviceState(deviceKind, device);
            }
            else
            {
                QueueDeltaControl(control, value);
            }
            if (IsTransientControl(deviceKind, controlName))
            {
                heldControls.Remove(key);
            }
            return new BridgeProtocol.InputCommandResult
            {
                device = deviceKind,
                control = controlName,
                value = parameters.value.ToArray(),
                frameCount = Time.frameCount
            };
        }

        internal BridgeProtocol.ReleaseInputsResult ReleaseAll(bool removeDevices)
        {
            var released = heldControls.Count;
            foreach (var held in heldControls.Values
                .Where(value => !UsesFullDeviceState(value.Device, value.Name))
                .ToArray())
            {
                try
                {
                    QueueDeltaControl(held.Control, held.Value is Vector2 ? (object)Vector2.zero : 0f);
                }
                catch (Exception) { }
            }
            heldControls.Clear();
            foreach (var pair in ownedDevices.ToArray())
            {
                try
                {
                    QueueDeviceState(pair.Key, pair.Value);
                }
                catch (Exception)
                {
                    // Device teardown below is the final safety net.
                }
            }
            var removed = 0;
            if (removeDevices && inputSystemType != null)
            {
                foreach (var device in ownedDevices.Values.ToArray())
                {
                    try
                    {
                        InvokeRemoveDevice(device);
                        removed++;
                    }
                    catch (Exception) { }
                }
                ownedDevices.Clear();
            }
            return new BridgeProtocol.ReleaseInputsResult
            {
                releasedControls = released,
                removedDevices = removed,
                frameCount = Time.frameCount
            };
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }
            disposed = true;
            EditorApplication.playModeStateChanged -= OnPlayModeStateChanged;
            ReleaseAll(true);
        }

        private void OnPlayModeStateChanged(PlayModeStateChange state)
        {
            if (state == PlayModeStateChange.ExitingPlayMode || state == PlayModeStateChange.EnteredEditMode)
            {
                ReleaseAll(true);
            }
        }

        private List<BridgeProtocol.InputBindingInfo> ReadBindings(string actionFilter, string mapFilter, int maximum)
        {
            var result = new List<BridgeProtocol.InputBindingInfo>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            if (playerInputType != null)
            {
                foreach (var player in Resources.FindObjectsOfTypeAll(playerInputType))
                {
                    var asset = ReadObject(player, "actions");
                    foreach (var map in Enumerate(ReadObject(asset, "actionMaps")))
                    {
                        AddMapBindings(map, actionFilter, mapFilter, maximum, result, seen);
                        if (result.Count >= maximum)
                        {
                            return result;
                        }
                    }
                }
            }
            if (result.Count == 0)
            {
                var listEnabled = inputSystemType.GetMethod("ListEnabledActions", BindingFlags.Public | BindingFlags.Static, null, Type.EmptyTypes, null);
                if (listEnabled != null)
                {
                    foreach (var action in Enumerate(listEnabled.Invoke(null, null)))
                    {
                        AddActionBindings(action, actionFilter, mapFilter, maximum, result, seen);
                        if (result.Count >= maximum)
                        {
                            break;
                        }
                    }
                }
            }
            return result;
        }

        private static void AddMapBindings(
            object map,
            string actionFilter,
            string mapFilter,
            int maximum,
            List<BridgeProtocol.InputBindingInfo> result,
            HashSet<string> seen)
        {
            var mapName = ReadString(map, "name");
            if (!string.IsNullOrEmpty(mapFilter) && !string.Equals(mapName, mapFilter, StringComparison.OrdinalIgnoreCase))
            {
                return;
            }
            foreach (var action in Enumerate(ReadObject(map, "actions")))
            {
                AddActionBindings(action, actionFilter, mapFilter, maximum, result, seen);
                if (result.Count >= maximum)
                {
                    return;
                }
            }
        }

        private static void AddActionBindings(
            object action,
            string actionFilter,
            string mapFilter,
            int maximum,
            List<BridgeProtocol.InputBindingInfo> result,
            HashSet<string> seen)
        {
            var actionName = ReadString(action, "name");
            var map = ReadObject(action, "actionMap");
            var mapName = ReadString(map, "name");
            if ((!string.IsNullOrEmpty(actionFilter) && !string.Equals(actionName, actionFilter, StringComparison.OrdinalIgnoreCase)) ||
                (!string.IsNullOrEmpty(mapFilter) && !string.Equals(mapName, mapFilter, StringComparison.OrdinalIgnoreCase)))
            {
                return;
            }
            var enabled = ReadBool(action, "enabled");
            foreach (var binding in Enumerate(ReadObject(action, "bindings")))
            {
                var path = ReadString(binding, "path");
                var effectivePath = ReadString(binding, "effectivePath");
                var name = ReadString(binding, "name");
                var key = mapName + "\u001f" + actionName + "\u001f" + name + "\u001f" + path + "\u001f" + effectivePath;
                if (!seen.Add(key))
                {
                    continue;
                }
                result.Add(new BridgeProtocol.InputBindingInfo
                {
                    actionMap = mapName,
                    action = actionName,
                    enabled = enabled,
                    bindingName = name,
                    path = Bound(path, 512),
                    effectivePath = Bound(string.IsNullOrEmpty(effectivePath) ? path : effectivePath, 512),
                    groups = Bound(ReadString(binding, "groups"), 512),
                    isComposite = ReadBool(binding, "isComposite"),
                    isPartOfComposite = ReadBool(binding, "isPartOfComposite")
                });
                if (result.Count >= maximum)
                {
                    return;
                }
            }
        }

        private object GetOrCreateDevice(string deviceKind)
        {
            object device;
            if (ownedDevices.TryGetValue(deviceKind, out device))
            {
                return device;
            }
            var layout = deviceKind == "KEYBOARD" ? "Keyboard" : deviceKind == "MOUSE" ? "Mouse" : "Gamepad";
            var method = inputSystemType.GetMethods(BindingFlags.Public | BindingFlags.Static)
                .Where(candidate => candidate.Name == "AddDevice" && !candidate.IsGenericMethod)
                .FirstOrDefault(candidate =>
                {
                    var parameters = candidate.GetParameters();
                    return parameters.Length >= 1 && parameters[0].ParameterType == typeof(string);
                });
            if (method == null)
            {
                throw new BridgeCommandException("INPUT_SYSTEM_UNAVAILABLE", "Input System AddDevice API is unavailable.");
            }
            var arguments = method.GetParameters().Select((parameter, index) =>
                index == 0 ? (object)layout : index == 1 ? "UnityAI-" + layout : parameter.HasDefaultValue ? parameter.DefaultValue : null
            ).ToArray();
            try
            {
                device = method.Invoke(null, arguments);
            }
            catch (TargetInvocationException exception)
            {
                throw new BridgeCommandException("INPUT_SYSTEM_UNAVAILABLE", "Could not create UnityAI virtual " + layout + ": " + exception.InnerException?.Message);
            }
            if (device == null)
            {
                throw new BridgeCommandException("INPUT_SYSTEM_UNAVAILABLE", "Input System returned no virtual " + layout + ".");
            }
            ownedDevices[deviceKind] = device;
            return device;
        }

        private static object FindControl(object device, string controlName)
        {
            var indexer = device.GetType().GetProperties(BindingFlags.Instance | BindingFlags.Public)
                .FirstOrDefault(property =>
                {
                    var indexes = property.GetIndexParameters();
                    return indexes.Length == 1 && indexes[0].ParameterType == typeof(string);
                });
            object control = null;
            try
            {
                control = indexer?.GetValue(device, new object[] { controlName });
            }
            catch (Exception) { }
            if (control == null)
            {
                throw new BridgeCommandException("INPUT_BINDING_UNSUPPORTED", "Virtual device has no supported control named " + controlName + ".");
            }
            return control;
        }

        private void QueueDeviceState(string deviceKind, object device)
        {
            var state = deviceKind == "KEYBOARD"
                ? CreateKeyboardState()
                : deviceKind == "MOUSE"
                    ? CreateMouseState()
                    : CreateGamepadState();
            var method = inputSystemType.GetMethods(BindingFlags.Public | BindingFlags.Static)
                .Where(candidate => candidate.Name == "QueueStateEvent" && candidate.IsGenericMethodDefinition)
                .FirstOrDefault(candidate => candidate.GetParameters().Length >= 2);
            if (method == null)
            {
                throw new BridgeCommandException("INPUT_SYSTEM_UNAVAILABLE", "Input System QueueStateEvent API is unavailable.");
            }
            var closed = method.MakeGenericMethod(state.GetType());
            var arguments = closed.GetParameters().Select((parameter, index) =>
                index == 0 ? device : index == 1 ? state : parameter.HasDefaultValue ? parameter.DefaultValue : -1d
            ).ToArray();
            try
            {
                closed.Invoke(null, arguments);
            }
            catch (TargetInvocationException exception)
            {
                throw new BridgeCommandException("INPUT_BINDING_UNSUPPORTED", "Virtual device state could not be queued: " + exception.InnerException?.Message);
            }
        }

        private void QueueDeltaControl(object control, object value)
        {
            var method = inputSystemType.GetMethods(BindingFlags.Public | BindingFlags.Static)
                .Where(candidate => candidate.Name == "QueueDeltaStateEvent" && candidate.IsGenericMethodDefinition)
                .FirstOrDefault(candidate => candidate.GetParameters().Length >= 2);
            if (method == null)
            {
                throw new BridgeCommandException("INPUT_SYSTEM_UNAVAILABLE", "Input System QueueDeltaStateEvent API is unavailable.");
            }
            var closed = method.MakeGenericMethod(value.GetType());
            var arguments = closed.GetParameters().Select((parameter, index) =>
                index == 0 ? control : index == 1 ? value : parameter.HasDefaultValue ? parameter.DefaultValue : -1d
            ).ToArray();
            try
            {
                closed.Invoke(null, arguments);
            }
            catch (TargetInvocationException exception)
            {
                throw new BridgeCommandException("INPUT_BINDING_UNSUPPORTED", "Virtual control delta could not be queued: " + exception.InnerException?.Message);
            }
        }

        private object CreateKeyboardState()
        {
            var stateType = RequireInputType("UnityEngine.InputSystem.LowLevel.KeyboardState");
            var keys = heldControls.Values
                .Where(held => held.Device == "KEYBOARD")
                .Select(held => ReadObject(held.Control, "keyCode"))
                .Where(value => value != null)
                .ToArray();
            var keyType = Type.GetType("UnityEngine.InputSystem.Key, Unity.InputSystem", false);
            if (keyType == null)
            {
                throw new BridgeCommandException("INPUT_SYSTEM_UNAVAILABLE", "Input System Key type is unavailable.");
            }
            var keyArray = Array.CreateInstance(keyType, keys.Length);
            Array.Copy(keys, keyArray, keys.Length);
            return Activator.CreateInstance(stateType, new object[] { keyArray });
        }

        private object CreateMouseState()
        {
            var stateType = RequireInputType("UnityEngine.InputSystem.LowLevel.MouseState");
            var state = Activator.CreateInstance(stateType);
            foreach (var held in heldControls.Values.Where(value => value.Device == "MOUSE"))
            {
                var normalized = held.Name.ToLowerInvariant();
                if (normalized == "position")
                {
                    SetStateField(state, "position", held.Value);
                    continue;
                }
                state = ApplyStateButton(
                    state,
                    "UnityEngine.InputSystem.LowLevel.MouseButton",
                    MouseButtonName(normalized),
                    "WithButton"
                );
            }
            return state;
        }

        private object CreateGamepadState()
        {
            var stateType = RequireInputType("UnityEngine.InputSystem.LowLevel.GamepadState");
            var state = Activator.CreateInstance(stateType);
            foreach (var held in heldControls.Values.Where(value => value.Device == "GAMEPAD"))
            {
                var normalized = held.Name.ToLowerInvariant();
                var fieldName = normalized == "leftstick" ? "leftStick"
                    : normalized == "rightstick" ? "rightStick"
                    : normalized == "lefttrigger" ? "leftTrigger"
                    : normalized == "righttrigger" ? "rightTrigger"
                    : null;
                if (fieldName != null)
                {
                    SetStateField(state, fieldName, held.Value);
                    continue;
                }
                state = ApplyStateButton(
                    state,
                    "UnityEngine.InputSystem.LowLevel.GamepadButton",
                    GamepadButtonName(normalized),
                    "WithButton"
                );
            }
            return state;
        }

        private object ApplyStateButton(object state, string enumTypeName, string enumName, string methodName)
        {
            var enumType = RequireInputType(enumTypeName);
            object button;
            try
            {
                button = Enum.Parse(enumType, enumName, true);
            }
            catch (Exception)
            {
                throw new BridgeCommandException("INPUT_BINDING_UNSUPPORTED", "Unsupported virtual device button " + enumName + ".");
            }
            var method = state.GetType().GetMethod(
                methodName,
                BindingFlags.Instance | BindingFlags.Public,
                null,
                new[] { enumType, typeof(bool) },
                null
            );
            var updated = method?.Invoke(state, new[] { button, (object)true });
            if (updated == null)
            {
                throw new BridgeCommandException("INPUT_SYSTEM_UNAVAILABLE", "Input System state button API is unavailable.");
            }
            return updated;
        }

        private static void SetStateField(object state, string fixedFieldName, object value)
        {
            var field = state.GetType().GetField(fixedFieldName, BindingFlags.Instance | BindingFlags.Public);
            if (field == null)
            {
                throw new BridgeCommandException("INPUT_SYSTEM_UNAVAILABLE", "Input System state field " + fixedFieldName + " is unavailable.");
            }
            field.SetValue(state, value);
        }

        private Type RequireInputType(string fullName)
        {
            var type = Type.GetType(fullName + ", Unity.InputSystem", false);
            if (type == null)
            {
                throw new BridgeCommandException("INPUT_SYSTEM_UNAVAILABLE", fullName + " is unavailable.");
            }
            return type;
        }

        private static string MouseButtonName(string controlName)
        {
            switch (controlName)
            {
                case "leftbutton": return "Left";
                case "rightbutton": return "Right";
                case "middlebutton": return "Middle";
                case "forwardbutton": return "Forward";
                case "backbutton": return "Back";
                default: throw new BridgeCommandException("INPUT_BINDING_UNSUPPORTED", "Unsupported virtual mouse control " + controlName + ".");
            }
        }

        private static string GamepadButtonName(string controlName)
        {
            switch (controlName)
            {
                case "dpad/up": return "DpadUp";
                case "dpad/down": return "DpadDown";
                case "dpad/left": return "DpadLeft";
                case "dpad/right": return "DpadRight";
                case "buttonnorth": case "y": return "North";
                case "buttoneast": case "b": return "East";
                case "buttonsouth": case "a": return "South";
                case "buttonwest": case "x": return "West";
                case "leftstickpress": return "LeftStick";
                case "rightstickpress": return "RightStick";
                case "leftshoulder": return "LeftShoulder";
                case "rightshoulder": return "RightShoulder";
                case "start": case "startbutton": return "Start";
                case "select": case "selectbutton": return "Select";
                default: throw new BridgeCommandException("INPUT_BINDING_UNSUPPORTED", "Unsupported virtual gamepad control " + controlName + ".");
            }
        }

        private static bool UsesFullDeviceState(string deviceKind, string controlName)
        {
            if (deviceKind == "KEYBOARD")
            {
                return true;
            }
            var normalized = controlName.ToLowerInvariant();
            if (deviceKind == "MOUSE")
            {
                return normalized.EndsWith("button", StringComparison.Ordinal);
            }
            return deviceKind == "GAMEPAD" &&
                normalized != "leftstick" &&
                normalized != "rightstick" &&
                normalized != "lefttrigger" &&
                normalized != "righttrigger";
        }

        private static bool IsTransientControl(string deviceKind, string controlName)
        {
            if (deviceKind != "MOUSE")
            {
                return false;
            }
            var normalized = controlName.ToLowerInvariant();
            return normalized == "delta" || normalized == "scroll";
        }

        private void InvokeRemoveDevice(object device)
        {
            var method = inputSystemType.GetMethods(BindingFlags.Public | BindingFlags.Static)
                .Where(candidate => candidate.Name == "RemoveDevice" && !candidate.IsGenericMethod)
                .FirstOrDefault(candidate =>
                {
                    var parameters = candidate.GetParameters();
                    return parameters.Length == 1 && parameters[0].ParameterType.IsAssignableFrom(device.GetType());
                });
            method?.Invoke(null, new[] { device });
        }

        private static object ValueForControl(string deviceKind, string controlName, float[] value)
        {
            var normalized = controlName.ToLowerInvariant();
            var vector = value.Length == 2 ||
                (deviceKind == "MOUSE" && (normalized == "position" || normalized == "delta" || normalized == "scroll")) ||
                (deviceKind == "GAMEPAD" && (normalized == "leftstick" || normalized == "rightstick"));
            if (vector)
            {
                return new Vector2(value[0], value.Length > 1 ? value[1] : 0f);
            }
            return value[0];
        }

        private void EnsureInputSystem()
        {
            if (inputSystemType == null)
            {
                throw new BridgeCommandException("INPUT_SYSTEM_UNAVAILABLE", "The Unity Input System package is not loaded for this project.");
            }
        }

        private void EnsureInputActive()
        {
            EnsureInputSystem();
            if (!EditorApplication.isPlaying || EditorApplication.isPaused)
            {
                throw new BridgeCommandException("INPUT_NOT_ACTIVE", "Virtual gameplay input is allowed only during unpaused Play Mode.");
            }
        }

        private static string NormalizeControl(string value)
        {
            var control = (value ?? string.Empty).Trim();
            var separator = control.IndexOf("/", StringComparison.Ordinal);
            if (control.StartsWith("<", StringComparison.Ordinal) && separator >= 0)
            {
                control = control.Substring(separator + 1);
            }
            return control;
        }

        private static bool IsSupportedButtonPath(string path)
        {
            if (!IsSupportedControlPath(path))
            {
                return false;
            }
            var normalized = path.ToLowerInvariant();
            return !normalized.EndsWith("/delta", StringComparison.Ordinal) &&
                !normalized.EndsWith("/position", StringComparison.Ordinal) &&
                !normalized.EndsWith("/scroll", StringComparison.Ordinal) &&
                !normalized.EndsWith("/leftstick", StringComparison.Ordinal) &&
                !normalized.EndsWith("/rightstick", StringComparison.Ordinal) &&
                !normalized.EndsWith("/lefttrigger", StringComparison.Ordinal) &&
                !normalized.EndsWith("/righttrigger", StringComparison.Ordinal);
        }

        private static bool IsSupportedControlPath(string path)
        {
            return !string.IsNullOrEmpty(path) &&
                (path.StartsWith("<Keyboard>/", StringComparison.OrdinalIgnoreCase) ||
                 path.StartsWith("<Mouse>/", StringComparison.OrdinalIgnoreCase) ||
                 path.StartsWith("<Gamepad>/", StringComparison.OrdinalIgnoreCase));
        }

        private static IEnumerable<object> Enumerate(object value)
        {
            var enumerable = value as IEnumerable;
            if (enumerable == null)
            {
                yield break;
            }
            foreach (var item in enumerable)
            {
                if (item != null)
                {
                    yield return item;
                }
            }
        }

        private static object ReadObject(object value, string property)
        {
            if (value == null)
            {
                return null;
            }
            try
            {
                return value.GetType().GetProperty(property, BindingFlags.Instance | BindingFlags.Public)?.GetValue(value, null);
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static string ReadString(object value, string property)
        {
            var result = ReadObject(value, property);
            return result == null ? string.Empty : result.ToString() ?? string.Empty;
        }

        private static bool ReadBool(object value, string property)
        {
            var result = ReadObject(value, property);
            return result is bool && (bool)result;
        }

        private static int ReadInt(object value, string property)
        {
            var result = ReadObject(value, property);
            return result is int ? (int)result : 0;
        }

        private static string Bound(string value, int maximum)
        {
            if (string.IsNullOrEmpty(value) || value.Length <= maximum)
            {
                return value ?? string.Empty;
            }
            return value.Substring(0, maximum) + "…[truncated]";
        }

        private sealed class HeldControl
        {
            internal string Device { get; }
            internal string Name { get; }
            internal object Control { get; }
            internal object Value { get; }

            internal HeldControl(string device, string name, object control, object value)
            {
                Device = device;
                Name = name;
                Control = control;
                Value = value;
            }
        }
    }
}
