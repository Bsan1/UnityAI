using System;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace UnityAI.EditorBridge
{
    internal static class VisualEvidence
    {
        private const int MaximumWidth = 1280;
        private const int MaximumHeight = 720;
        private const int MaximumPngBytes = 2500000;

        internal static BridgeProtocol.ScreenshotResult Capture(string projectRoot, BridgeProtocol.Parameters parameters)
        {
            if (!EditorApplication.isPlaying)
            {
                throw new BridgeCommandException("INPUT_NOT_ACTIVE", "Game View screenshots require Play Mode.");
            }
            var requestedWidth = Math.Max(64, Math.Min(parameters.maxWidth <= 0 ? 960 : parameters.maxWidth, MaximumWidth));
            var requestedHeight = Math.Max(64, Math.Min(parameters.maxHeight <= 0 ? 540 : parameters.maxHeight, MaximumHeight));
            Texture2D source = null;
            Texture2D bounded = null;
            RenderTexture target = null;
            var previous = RenderTexture.active;
            try
            {
                source = ScreenCapture.CaptureScreenshotAsTexture(1);
                if (source == null || source.width < 1 || source.height < 1)
                {
                    throw new BridgeCommandException("SCREENSHOT_CAPTURE_FAILED", "Unity returned no Game View image.");
                }
                var scale = Math.Min(1f, Math.Min((float)requestedWidth / source.width, (float)requestedHeight / source.height));
                var width = Math.Max(1, Mathf.RoundToInt(source.width * scale));
                var height = Math.Max(1, Mathf.RoundToInt(source.height * scale));
                if (width == source.width && height == source.height)
                {
                    bounded = source;
                    source = null;
                }
                else
                {
                    target = RenderTexture.GetTemporary(width, height, 0, RenderTextureFormat.ARGB32);
                    Graphics.Blit(source, target);
                    RenderTexture.active = target;
                    bounded = new Texture2D(width, height, TextureFormat.RGB24, false);
                    bounded.ReadPixels(new Rect(0, 0, width, height), 0, 0, false);
                    bounded.Apply(false, false);
                }
                var bytes = bounded.EncodeToPNG();
                if (bytes == null || bytes.Length == 0 || bytes.Length > MaximumPngBytes)
                {
                    throw new BridgeCommandException("SCREENSHOT_CAPTURE_FAILED", "Bounded Game View PNG was empty or exceeded the 2.5 MB evidence limit.");
                }
                var evidenceId = "SHOT-" + Guid.NewGuid().ToString("N").ToUpperInvariant();
                var relativePath = Path.Combine("Library", "UnityAI", "screenshots", evidenceId + ".png");
                var absolutePath = Path.Combine(projectRoot, relativePath);
                Directory.CreateDirectory(Path.GetDirectoryName(absolutePath));
                File.WriteAllBytes(absolutePath, bytes);
                return new BridgeProtocol.ScreenshotResult
                {
                    evidenceId = evidenceId,
                    relativePath = relativePath.Replace(Path.DirectorySeparatorChar, '/'),
                    width = bounded.width,
                    height = bounded.height,
                    byteCount = bytes.Length,
                    capturedAt = DateTime.UtcNow.ToString("o")
                };
            }
            catch (BridgeCommandException)
            {
                throw;
            }
            catch (Exception exception)
            {
                throw new BridgeCommandException("SCREENSHOT_CAPTURE_FAILED", "Game View screenshot failed: " + exception.Message);
            }
            finally
            {
                RenderTexture.active = previous;
                if (target != null)
                {
                    RenderTexture.ReleaseTemporary(target);
                }
                if (source != null)
                {
                    UnityEngine.Object.DestroyImmediate(source);
                }
                if (bounded != null)
                {
                    UnityEngine.Object.DestroyImmediate(bounded);
                }
            }
        }
    }
}
