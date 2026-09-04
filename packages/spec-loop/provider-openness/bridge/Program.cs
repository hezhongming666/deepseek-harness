using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading.Tasks;

namespace OpennessBridge
{
    /// <summary>
    /// Bridge entry point: parse CLI arguments, load the config, select the
    /// host (fake by default; the Openness host only when built with
    /// -p:WithOpenness=true), serve the protocol, and print the listening
    /// line the adapter's spawn mode waits for.
    /// </summary>
    internal static class Program
    {
        private const string HelpText =
            "OpennessBridge — TIA Portal Openness HTTP JSON bridge for dsh spec-loop\n"
            + "usage: OpennessBridge [--config <path>] [--port <n>] [--fake] [--list-tags] [--list-devices]\n"
            + "  --config <path>  JSON config file (default bridge.json)\n"
            + "  --port <n>       listening port override (0 = discover a free port)\n"
            + "  --fake           serve the deterministic fake host without TIA Portal\n"
            + "  --list-tags      print the project's PLC tags (table/tag, data type) and exit\n"
            + "  --list-devices   print the project's devices and their items, and exit\n";

        private static async Task<int> Main(string[] args)
        {
            var options = ParseArgs(args);
            if (options.ShowHelp)
            {
                Console.Out.WriteLine(HelpText);
                return 0;
            }
            BridgeConfig config;
            try
            {
                config = BridgeConfig.Load(options.ConfigPath, options.Fake);
            }
            catch (Exception error)
            {
                Console.Error.WriteLine($"config error: {error.Message}");
                return 2;
            }
            if (options.Port.HasValue)
            {
                config.Port = options.Port.Value;
            }
            IOpennessHost host;
            try
            {
                host = CreateHost(config);
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(Flatten(error));
                return 2;
            }
            if (options.ListTags || options.ListDevices || options.FindDevice != null || options.ProbeSoftware || options.ProbeTag != null)
            {
                try
                {
#if WITH_OPENNESS
                    if (host is OpennessHost opennessHost)
                    {
                        if (options.ListDevices) opennessHost.ListDevices(Console.Out);
                        if (options.ListTags) opennessHost.ListTags(Console.Out);
                        if (options.FindDevice != null) opennessHost.FindDevices(Console.Out, options.FindDevice);
                        if (options.ProbeSoftware) opennessHost.ProbeSoftware(Console.Out);
                        if (options.ProbeTag != null) opennessHost.ProbeTag(Console.Out, options.ProbeTag);
                        host.Dispose();
                        return 0;
                    }
#endif
                }
                catch (Exception error)
                {
                    Console.Error.WriteLine(Flatten(error));
                    return 2;
                }
                Console.Error.WriteLine("--list-tags/--list-devices/--find-device/--probe-software/--probe-tag require the full Openness build (not --fake)");
                return 2;
            }
            var shutdownRequested = new TaskCompletionSource<bool>();
            using (var server = new BridgeServer(config, host, shutdownRequested))
            {
                string listening;
                try
                {
                    listening = await server.StartAsync().ConfigureAwait(false);
                }
                catch (Exception error)
                {
                    Console.Error.WriteLine($"server error: {error.Message}");
                    return 2;
                }
                Console.Out.WriteLine(JsonSerializer.Serialize(
                    new { @event = "listening", url = listening },
                    Wire.Options));
                Console.Out.Flush();
                Console.CancelKeyPress += (_, eventArgs) =>
                {
                    eventArgs.Cancel = true;
                    shutdownRequested.TrySetResult(true);
                };
                await shutdownRequested.Task.ConfigureAwait(false);
                return 0;
            }
        }

        private static IOpennessHost CreateHost(BridgeConfig config)
        {
            if (config.Fake)
            {
                return new FakeHost(config);
            }
#if WITH_OPENNESS
            return new OpennessHost(config);
#else
            throw new InvalidOperationException(
                "this build has no Openness support: rebuild with -p:WithOpenness=true "
                + "and the TIA Portal V21 Openness API, or run with --fake");
#endif
        }

        /// <summary>
        /// Join the exception chain's messages without calling ToString: some
        /// Openness exception types fail when ToString renders their internals.
        /// </summary>
        private static string Flatten(Exception error)
        {
            var parts = new List<string>();
            for (var current = error as Exception; current != null; current = current.InnerException)
            {
                parts.Add($"{current.GetType().Name}: {current.Message}");
            }
            return string.Join(" <-- ", parts);
        }

        private sealed class CliOptions
        {
            public bool ShowHelp { get; set; }
            public string ConfigPath { get; set; } = "bridge.json";
            public bool Fake { get; set; }
            public bool ListTags { get; set; }
            public bool ListDevices { get; set; }
            public bool ProbeSoftware { get; set; }
            public string? ProbeTag { get; set; }
            public string? FindDevice { get; set; }
            public int? Port { get; set; }
        }

        private static CliOptions ParseArgs(string[] args)
        {
            var options = new CliOptions();
            for (var index = 0; index < args.Length; index += 1)
            {
                switch (args[index])
                {
                    case "--help":
                    case "-h":
                        options.ShowHelp = true;
                        break;
                    case "--fake":
                        options.Fake = true;
                        break;
                    case "--list-tags":
                        options.ListTags = true;
                        break;
                    case "--list-devices":
                        options.ListDevices = true;
                        break;
                    case "--probe-software":
                        options.ProbeSoftware = true;
                        break;
                    case "--probe-tag":
                        index += 1;
                        options.ProbeTag = index < args.Length
                            ? args[index]
                            : throw new InvalidOperationException("--probe-tag requires a tag name");
                        break;
                    case "--find-device":
                        index += 1;
                        options.FindDevice = index < args.Length
                            ? args[index]
                            : throw new InvalidOperationException("--find-device requires a query");
                        break;
                    case "--config":
                        index += 1;
                        options.ConfigPath = index < args.Length
                            ? args[index]
                            : throw new InvalidOperationException("--config requires a path");
                        break;
                    case "--port":
                        index += 1;
                        options.Port = index < args.Length && int.TryParse(args[index], out var port)
                            ? port
                            : throw new InvalidOperationException("--port requires an integer");
                        break;
                    default:
                        throw new InvalidOperationException($"unknown argument {args[index]}; run --help");
                }
            }
            return options;
        }
    }
}
