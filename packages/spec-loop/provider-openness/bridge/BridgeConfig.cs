using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;

namespace OpennessBridge
{
    /// <summary>
    /// One parameter binding: a numeric parameter key mapped to a PLC tag
    /// whose start value the run action writes, with inclusive numeric bounds
    /// enforced by validate.
    /// </summary>
    public sealed class ParamBinding
    {
        public string Tag { get; set; } = string.Empty;
        public double Min { get; set; }
        public double Max { get; set; }
    }

    /// <summary>
    /// The bridge's JSON config file, loaded once at startup.
    /// </summary>
    public sealed class BridgeConfig
    {
        /// <summary>Listening port; 0 discovers a free loopback port.</summary>
        public int Port { get; set; } = 4279;

        /// <summary>Serve the deterministic fake host without TIA Portal.</summary>
        public bool Fake { get; set; }

        /// <summary>Path to the TIA Portal project (.ap file or directory).</summary>
        public string ProjectPath { get; set; } = string.Empty;

        /// <summary>TIA Portal mode: WithoutUserInterface or WithUserInterface.</summary>
        public string Mode { get; set; } = "WithoutUserInterface";

        /// <summary>PLC device name; empty selects the first device with PLC software.</summary>
        public string Device { get; set; } = string.Empty;

        /// <summary>Parameter key to tag binding, with inclusive numeric bounds.</summary>
        public Dictionary<string, ParamBinding> Params { get; set; } = new Dictionary<string, ParamBinding>();

        /// <summary>
        /// Load and validate a config file.
        /// </summary>
        /// <param name="path">Path to the JSON config file.</param>
        /// <param name="forceFake">CLI --fake override.</param>
        /// <returns>The parsed config.</returns>
        public static BridgeConfig Load(string path, bool forceFake)
        {
            var text = File.ReadAllText(path);
            var config = JsonSerializer.Deserialize<BridgeConfig>(text, Wire.Options)
                ?? throw new InvalidOperationException("config file parsed to null");
            if (config.Port < 0 || config.Port > 65535)
            {
                throw new InvalidOperationException("config port must be between 0 and 65535");
            }
            if (config.Mode != "WithoutUserInterface" && config.Mode != "WithUserInterface")
            {
                throw new InvalidOperationException("config mode must be WithoutUserInterface or WithUserInterface");
            }
            foreach (var entry in config.Params)
            {
                if (string.IsNullOrWhiteSpace(entry.Key))
                {
                    throw new InvalidOperationException("config param keys must be non-empty strings");
                }
                if (string.IsNullOrWhiteSpace(entry.Value.Tag))
                {
                    throw new InvalidOperationException($"config param {entry.Key} requires a non-empty tag path");
                }
                if (entry.Value.Min > entry.Value.Max)
                {
                    throw new InvalidOperationException($"config param {entry.Key} bounds are inverted");
                }
            }
            config.Fake = config.Fake || forceFake;
            return config;
        }
    }
}
