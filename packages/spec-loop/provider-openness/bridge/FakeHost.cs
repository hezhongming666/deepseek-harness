using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json;

namespace OpennessBridge
{
    /// <summary>
    /// The deterministic fake host: validates parameter keys and bounds from
    /// the config, and reports a constant clean compile. It exists so the
    /// bridge protocol and a spec-loop wiring can be exercised on machines
    /// without TIA Portal; it touches no license and no project.
    /// </summary>
    internal sealed class FakeHost : IOpennessHost
    {
        private readonly BridgeConfig config;

        public FakeHost(BridgeConfig config)
        {
            this.config = config;
        }

        public Wire.HealthResponse Health()
        {
            return new Wire.HealthResponse
            {
                Ok = true,
                Environment = new Dictionary<string, string>
                {
                    ["softwareVersion"] = "OpennessBridge (fake) 0.1.0",
                    ["osKernel"] = Environment.OSVersion.VersionString,
                },
            };
        }

        public Wire.ValidateResponse Validate(IReadOnlyDictionary<string, JsonElement> parameters)
        {
            var response = new Wire.ValidateResponse { Ok = true };
            foreach (var entry in parameters)
            {
                if (!config.Params.TryGetValue(entry.Key, out var binding))
                {
                    response.Ok = false;
                    response.Reasons.Add($"unknown parameter {JsonSerializer.Serialize(entry.Key)}");
                    continue;
                }
                if (entry.Value.ValueKind != JsonValueKind.Number || !entry.Value.TryGetDouble(out var value))
                {
                    response.Ok = false;
                    response.Reasons.Add($"parameter {JsonSerializer.Serialize(entry.Key)} must be a number");
                    continue;
                }
                if (value < binding.Min || value > binding.Max)
                {
                    response.Ok = false;
                    response.Reasons.Add(
                        $"parameter {JsonSerializer.Serialize(entry.Key)} = {value.ToString(CultureInfo.InvariantCulture)} "
                        + $"outside [{binding.Min.ToString(CultureInfo.InvariantCulture)}, "
                        + $"{binding.Max.ToString(CultureInfo.InvariantCulture)}]");
                }
            }
            return response;
        }

        public Wire.RunResponse Run(
            string runId,
            IReadOnlyDictionary<string, JsonElement> parameters,
            string? action,
            string? blockName,
            string? source,
            Func<bool> cancelled)
        {
            if (cancelled())
            {
                return new Wire.RunResponse
                {
                    RunId = runId,
                    Status = "killed",
                    Error = "cancelled before execution",
                };
            }
            var effectiveAction = string.IsNullOrWhiteSpace(action) ? config.Action : action;
            if (effectiveAction == "verify" && source != null)
            {
                // Deterministic fake verdict: the `(*FAIL*)` and `(*WARN*)`
                // markers count as compile errors and warnings, so tests can
                // pin both outcomes without TIA Portal.
                var errors = CountMarker(source, "(*FAIL*)");
                var warnings = CountMarker(source, "(*WARN*)");
                var messages = new List<string>();
                var states = new List<string>();
                for (var index = 0; index < errors; index += 1)
                {
                    messages.Add($"fake error #{index + 1}");
                    states.Add("error");
                }
                for (var index = 0; index < warnings; index += 1)
                {
                    messages.Add($"fake warning #{index + 1}");
                    states.Add("warning");
                }
                return new Wire.RunResponse
                {
                    RunId = runId,
                    Status = "success",
                    Result = new Dictionary<string, JsonElement>
                    {
                        ["compileErrors"] = JsonDocument.Parse(errors.ToString(CultureInfo.InvariantCulture)).RootElement.Clone(),
                        ["compileWarnings"] = JsonDocument.Parse(warnings.ToString(CultureInfo.InvariantCulture)).RootElement.Clone(),
                        ["compileMs"] = JsonDocument.Parse("100").RootElement.Clone(),
                        ["compileMessages"] = JsonSerializer.SerializeToElement(messages),
                        ["compileMessageStates"] = JsonSerializer.SerializeToElement(states),
                        ["blockName"] = JsonSerializer.SerializeToElement(blockName ?? string.Empty),
                    },
                    LicenseMs = 100,
                };
            }
            return new Wire.RunResponse
            {
                RunId = runId,
                Status = "success",
                Result = new Dictionary<string, JsonElement>
                {
                    ["compileErrors"] = JsonDocument.Parse("0").RootElement.Clone(),
                    ["compileWarnings"] = JsonDocument.Parse("0").RootElement.Clone(),
                    ["compileMs"] = JsonDocument.Parse("100").RootElement.Clone(),
                },
                LicenseMs = 100,
            };
        }

        /// <summary>Count the occurrences of one marker in the fake verify source.</summary>
        private static int CountMarker(string source, string marker)
        {
            var count = 0;
            var index = 0;
            while ((index = source.IndexOf(marker, index, StringComparison.Ordinal)) >= 0)
            {
                count += 1;
                index += marker.Length;
            }
            return count;
        }

        public void Dispose()
        {
        }
    }
}
