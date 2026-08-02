using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using UnityEditor;
using UnityEngine;

namespace UnityAI.EditorBridge
{
    internal static class BridgeBootstrap
    {
        private static BridgeServer server;

        [InitializeOnLoadMethod]
        private static void Initialize()
        {
            AssemblyReloadEvents.beforeAssemblyReload -= Stop;
            AssemblyReloadEvents.beforeAssemblyReload += Stop;
            EditorApplication.quitting -= Stop;
            EditorApplication.quitting += Stop;
            Start();
        }

        private static void Start()
        {
            if (server != null)
            {
                return;
            }
            try
            {
                server = new BridgeServer();
                server.Start();
            }
            catch (Exception exception)
            {
                server?.Dispose();
                UnityEngine.Debug.LogError("UnityAI Editor Bridge failed to start: " + exception);
                server = null;
            }
        }

        private static void Stop()
        {
            if (server == null)
            {
                return;
            }
            server.Dispose();
            server = null;
        }
    }

    internal sealed class BridgeServer : IDisposable
    {
        private const int MaximumCommandsPerEditorUpdate = 16;
        private readonly ConcurrentQueue<PendingCommand> queue = new ConcurrentQueue<PendingCommand>();
        private readonly CancellationTokenSource cancellation = new CancellationTokenSource();
        private readonly string projectRoot;
        private readonly string descriptorPath;
        private readonly string token;
        private readonly ConsoleReader console;
        private readonly BridgeCommands commands;
        private TcpListener listener;
        private Thread listenerThread;
        private bool disposed;

        internal BridgeServer()
        {
            projectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, "..")).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            descriptorPath = Path.Combine(projectRoot, "Library", "UnityAI", "bridge-session.json");
            token = CreateToken();
            console = new ConsoleReader();
            commands = new BridgeCommands(projectRoot, console);
        }

        internal void Start()
        {
            listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start(16);
            var endpoint = (IPEndPoint)listener.LocalEndpoint;
            WriteDescriptor(endpoint.Port);
            EditorApplication.update += DrainMainThreadQueue;
            listenerThread = new Thread(Listen)
            {
                IsBackground = true,
                Name = "UnityAI Bridge Listener"
            };
            listenerThread.Start();
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }
            disposed = true;
            EditorApplication.update -= DrainMainThreadQueue;
            cancellation.Cancel();
            try { listener?.Stop(); } catch (Exception) { }
            console.Dispose();
            try
            {
                if (File.Exists(descriptorPath))
                {
                    File.Delete(descriptorPath);
                }
            }
            catch (Exception) { }
            cancellation.Dispose();
        }

        private void Listen()
        {
            while (!cancellation.IsCancellationRequested)
            {
                try
                {
                    var client = listener.AcceptTcpClient();
                    ThreadPool.QueueUserWorkItem(_ => HandleClient(client));
                }
                catch (SocketException)
                {
                    if (!cancellation.IsCancellationRequested)
                    {
                        UnityEngine.Debug.LogWarning("UnityAI bridge listener stopped unexpectedly.");
                    }
                }
                catch (ObjectDisposedException)
                {
                    return;
                }
            }
        }

        private void HandleClient(TcpClient client)
        {
            using (client)
            {
                client.ReceiveTimeout = BridgeProtocol.CommandTimeoutMilliseconds;
                client.SendTimeout = BridgeProtocol.CommandTimeoutMilliseconds;
                var stream = client.GetStream();
                string requestJson;
                try
                {
                    requestJson = ReadBoundedLine(stream);
                }
                catch (BridgeCommandException exception)
                {
                    WriteLine(stream, BridgeProtocol.Failure(string.Empty, exception.Code, exception.Message));
                    return;
                }

                BridgeProtocol.Request request = null;
                try
                {
                    request = BridgeProtocol.ParseRequest(requestJson);
                    if (request.protocolVersion != BridgeProtocol.ProtocolVersion)
                    {
                        throw new BridgeCommandException("PROTOCOL_MISMATCH", "Unsupported bridge protocol version.");
                    }
                    if (!TokensEqual(token, request.token))
                    {
                        throw new BridgeCommandException("AUTH_FAILED", "Bridge session token is missing or invalid.");
                    }
                }
                catch (BridgeCommandException exception)
                {
                    WriteLine(stream, BridgeProtocol.Failure(request != null ? request.id : string.Empty, exception.Code, exception.Message));
                    return;
                }

                var pending = new PendingCommand(request);
                queue.Enqueue(pending);
                if (!pending.Completed.Wait(BridgeProtocol.CommandTimeoutMilliseconds))
                {
                    WriteLine(stream, BridgeProtocol.Failure(request.id, "COMMAND_TIMEOUT", "Unity main-thread command timed out."));
                    return;
                }
                WriteLine(stream, pending.Response);
            }
        }

        private void DrainMainThreadQueue()
        {
            for (var index = 0; index < MaximumCommandsPerEditorUpdate; index++)
            {
                PendingCommand pending;
                if (!queue.TryDequeue(out pending))
                {
                    return;
                }
                try
                {
                    var result = commands.Execute(pending.Request);
                    pending.Response = BridgeProtocol.Success(pending.Request.id, result);
                }
                catch (BridgeCommandException exception)
                {
                    pending.Response = BridgeProtocol.Failure(pending.Request.id, exception.Code, exception.Message);
                }
                catch (Exception exception)
                {
                    pending.Response = BridgeProtocol.Failure(pending.Request.id, "COMMAND_FAILED", Bound(exception.Message, 2048));
                }
                finally
                {
                    pending.Completed.Set();
                }
            }
        }

        private void WriteDescriptor(int port)
        {
            var directory = Path.GetDirectoryName(descriptorPath);
            Directory.CreateDirectory(directory);
            var descriptor = new BridgeProtocol.SessionDescriptor
            {
                protocolVersion = BridgeProtocol.ProtocolVersion,
                bridgeVersion = BridgeProtocol.BridgeVersion,
                projectRoot = projectRoot,
                unityVersion = Application.unityVersion,
                editorProcessId = Process.GetCurrentProcess().Id,
                host = "127.0.0.1",
                port = port,
                sessionToken = token,
                startedAt = DateTime.UtcNow.ToString("o")
            };
            var temporary = descriptorPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllText(temporary, JsonUtility.ToJson(descriptor, true), new UTF8Encoding(false));
            if (File.Exists(descriptorPath))
            {
                File.Delete(descriptorPath);
            }
            File.Move(temporary, descriptorPath);
        }

        private static string ReadBoundedLine(NetworkStream stream)
        {
            using (var memory = new MemoryStream())
            {
                while (true)
                {
                    var value = stream.ReadByte();
                    if (value < 0)
                    {
                        throw new BridgeCommandException("INVALID_REQUEST", "Connection closed before request terminator.");
                    }
                    if (value == '\n')
                    {
                        return Encoding.UTF8.GetString(memory.ToArray()).TrimEnd('\r');
                    }
                    if (memory.Length >= BridgeProtocol.MaximumRequestBytes)
                    {
                        throw new BridgeCommandException("REQUEST_TOO_LARGE", "Bridge request exceeded the size limit.");
                    }
                    memory.WriteByte((byte)value);
                }
            }
        }

        private static void WriteLine(NetworkStream stream, string response)
        {
            var bytes = Encoding.UTF8.GetBytes(response + "\n");
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush();
        }

        private static string CreateToken()
        {
            var bytes = new byte[32];
            using (var generator = RandomNumberGenerator.Create())
            {
                generator.GetBytes(bytes);
            }
            return Convert.ToBase64String(bytes);
        }

        private static bool TokensEqual(string expected, string supplied)
        {
            var expectedBytes = Encoding.UTF8.GetBytes(expected ?? string.Empty);
            var suppliedBytes = Encoding.UTF8.GetBytes(supplied ?? string.Empty);
            var difference = expectedBytes.Length ^ suppliedBytes.Length;
            var maximum = Math.Max(expectedBytes.Length, suppliedBytes.Length);
            for (var index = 0; index < maximum; index++)
            {
                var left = index < expectedBytes.Length ? expectedBytes[index] : (byte)0;
                var right = index < suppliedBytes.Length ? suppliedBytes[index] : (byte)0;
                difference |= left ^ right;
            }
            return difference == 0;
        }

        private static string Bound(string value, int maximum)
        {
            if (string.IsNullOrEmpty(value) || value.Length <= maximum)
            {
                return value ?? string.Empty;
            }
            return value.Substring(0, maximum) + "…[truncated]";
        }

        private sealed class PendingCommand
        {
            internal BridgeProtocol.Request Request { get; }
            internal ManualResetEventSlim Completed { get; } = new ManualResetEventSlim(false);
            internal string Response { get; set; } = string.Empty;

            internal PendingCommand(BridgeProtocol.Request request)
            {
                Request = request;
            }
        }
    }
}
