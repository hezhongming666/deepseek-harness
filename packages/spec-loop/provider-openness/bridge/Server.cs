using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace OpennessBridge
{
    /// <summary>
    /// The bridge's HTTP JSON server on 127.0.0.1. Routes /health, /validate,
    /// /run, and /cancel; serializes runs (one in flight), forwards the
    /// adapter's cancel set to the host, and maps host infrastructure
    /// failures to HTTP 503.
    /// </summary>
    internal sealed class BridgeServer : IDisposable
    {
        private readonly BridgeConfig config;
        private readonly IOpennessHost host;
        private readonly TaskCompletionSource<bool> shutdownRequested;
        private readonly ConcurrentDictionary<string, byte> cancelledRuns =
            new ConcurrentDictionary<string, byte>();
        private HttpListener? listener;
        private Task? loop;
        private int busy;

        public BridgeServer(BridgeConfig config, IOpennessHost host, TaskCompletionSource<bool> shutdownRequested)
        {
            this.config = config;
            this.host = host;
            this.shutdownRequested = shutdownRequested;
        }

        /// <summary>
        /// Bind the listener and start the request loop.
        /// </summary>
        /// <returns>The bound listening URL to report on stdout.</returns>
        public async Task<string> StartAsync()
        {
            var port = config.Port;
            var lastError = (Exception?)null;
            for (var attempt = 0; attempt < 5; attempt += 1)
            {
                if (port == 0)
                {
                    port = DiscoverPort();
                }
                var candidate = new HttpListener();
                candidate.Prefixes.Add($"http://127.0.0.1:{port}/");
                try
                {
                    candidate.Start();
                    listener = candidate;
                    loop = Task.Run(() => RunLoopAsync(listener));
                    return $"http://127.0.0.1:{port}";
                }
                catch (Exception error)
                {
                    lastError = error;
                    if (config.Port != 0)
                    {
                        break;
                    }
                }
            }
            throw new InvalidOperationException(
                $"failed to bind the bridge listener: {lastError?.Message ?? "unknown error"}");
        }

        private static int DiscoverPort()
        {
            var probe = new TcpListener(IPAddress.Loopback, 0);
            probe.Start();
            var port = ((IPEndPoint)probe.LocalEndpoint).Port;
            probe.Stop();
            return port;
        }

        private async Task RunLoopAsync(HttpListener active)
        {
            while (active.IsListening)
            {
                HttpListenerContext context;
                try
                {
                    context = await active.GetContextAsync().ConfigureAwait(false);
                }
                catch (Exception)
                {
                    break;
                }
                _ = HandleAsync(context);
            }
        }

        private async Task HandleAsync(HttpListenerContext context)
        {
            try
            {
                var path = context.Request.Url?.AbsolutePath ?? "/";
                var method = context.Request.HttpMethod;
                if (method == "GET" && path == "/health")
                {
                    await WriteJsonAsync(context, 200, host.Health()).ConfigureAwait(false);
                    return;
                }
                if (method == "POST" && path == "/validate")
                {
                    await WriteJsonAsync(context, 200, Validate(context)).ConfigureAwait(false);
                    return;
                }
                if (method == "POST" && path == "/run")
                {
                    if (Interlocked.CompareExchange(ref busy, 1, 0) != 0)
                    {
                        await WriteJsonAsync(context, 409, new Wire.ErrorResponse
                        {
                            Error = "a run is already in flight; the bridge serializes runs",
                        }).ConfigureAwait(false);
                        return;
                    }
                    try
                    {
                        var runId = ReadBody<Wire.RunRequest>(context);
                        var cancelled = new Func<bool>(() => cancelledRuns.ContainsKey(runId.RunId));
                        var response = host.Run(runId.RunId, runId.Params, cancelled);
                        if (cancelledRuns.TryRemove(runId.RunId, out _))
                        {
                            response.Status = "killed";
                            response.Result = null;
                            response.Error ??= "cancelled by the adapter";
                        }
                        await WriteJsonAsync(context, 200, response).ConfigureAwait(false);
                    }
                    finally
                    {
                        Interlocked.Exchange(ref busy, 0);
                    }
                    return;
                }
                if (method == "POST" && path == "/cancel")
                {
                    var cancel = ReadBody<Wire.CancelRequest>(context);
                    cancelledRuns[cancel.RunId] = 0;
                    await WriteJsonAsync(context, 202, new { ok = true }).ConfigureAwait(false);
                    return;
                }
                if (method == "POST" && path == "/shutdown")
                {
                    // Graceful stop: the main loop exits after the response,
                    // and disposal closes the project and the TIA session.
                    await WriteJsonAsync(context, 202, new { ok = true }).ConfigureAwait(false);
                    shutdownRequested.TrySetResult(true);
                    return;
                }
                await WriteJsonAsync(context, 404, new Wire.ErrorResponse
                {
                    Error = $"unknown route {method} {path}",
                }).ConfigureAwait(false);
            }
            catch (InfrastructureException error)
            {
                await WriteJsonAsync(context, 503, new Wire.ErrorResponse { Error = error.ToString() }).ConfigureAwait(false);
            }
            catch (Exception error)
            {
                await WriteJsonAsync(context, 500, new Wire.ErrorResponse { Error = error.Message }).ConfigureAwait(false);
            }
        }

        private Wire.ValidateResponse Validate(HttpListenerContext context)
        {
            var request = ReadBody<Wire.ValidateRequest>(context);
            return host.Validate(request.Params);
        }

        private static T ReadBody<T>(HttpListenerContext context)
        {
            string text;
            using (var reader = new StreamReader(context.Request.InputStream, context.Request.ContentEncoding))
            {
                text = reader.ReadToEnd();
            }
            return JsonSerializer.Deserialize<T>(text, Wire.Options)
                ?? throw new InvalidOperationException($"request body did not parse as {typeof(T).Name}");
        }

        private static async Task WriteJsonAsync(HttpListenerContext context, int status, object value)
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(value, Wire.Options);
            context.Response.StatusCode = status;
            context.Response.ContentType = "application/json; charset=utf-8";
            context.Response.ContentLength64 = bytes.Length;
            try
            {
                await context.Response.OutputStream.WriteAsync(bytes, 0, bytes.Length).ConfigureAwait(false);
            }
            catch (IOException)
            {
                // The adapter aborted the connection (timeout or cancel).
            }
            catch (HttpListenerException)
            {
                // The listener shut down mid-write.
            }
        }

        public void Dispose()
        {
            try
            {
                listener?.Stop();
                listener?.Close();
            }
            catch
            {
                // Disposal is best effort.
            }
            host.Dispose();
        }
    }
}
