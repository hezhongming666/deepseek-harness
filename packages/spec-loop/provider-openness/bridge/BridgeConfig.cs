using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;

namespace OpennessBridge
{
    /// <summary>
    /// One parameter binding: a numeric parameter key mapped to a global data
    /// block member whose start value the run action writes, with inclusive
    /// numeric bounds enforced by validate. V21 exposes member start values as
    /// the dynamic `StartValue` attribute, not as a tag property.
    /// </summary>
    public sealed class ParamBinding
    {
        /// <summary>Global data block name, e.g. <c>Diag</c>.</summary>
        public string Block { get; set; } = string.Empty;

        /// <summary>Member name inside the block interface, e.g. <c>threshold</c>.</summary>
        public string Member { get; set; } = string.Empty;

        public double Min { get; set; }
        public double Max { get; set; }
    }

    /// <summary>
    /// Optional self-provisioning: when the configured project does not exist,
    /// the real host creates a folder-based project and inserts one device
    /// (a PLC CPU order number also brings its PLC software along).
    /// </summary>
    public sealed class BootstrapConfig
    {
        /// <summary>Parent directory for the folder-based project to create.</summary>
        public string Directory { get; set; } = string.Empty;

        /// <summary>Project name; the project lands in <c>Directory\ProjectName</c>.</summary>
        public string ProjectName { get; set; } = string.Empty;

        /// <summary>Device order number from the TIA catalog, e.g. a SIMATIC S7-1200 CPU.</summary>
        public string DeviceOrderNumber { get; set; } = string.Empty;

        /// <summary>Device name inside the project.</summary>
        public string DeviceName { get; set; } = string.Empty;

        /// <summary>Firmware/catalog version string, e.g. <c>V4.5</c>.</summary>
        public string DeviceVersion { get; set; } = string.Empty;
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

        /// <summary>Optional project/device creation when the project is missing.</summary>
        public BootstrapConfig? Bootstrap { get; set; }

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
                if (string.IsNullOrWhiteSpace(entry.Value.Block) || string.IsNullOrWhiteSpace(entry.Value.Member))
                {
                    throw new InvalidOperationException(
                        $"config param {entry.Key} requires non-empty block and member names");
                }
                if (entry.Value.Min > entry.Value.Max)
                {
                    throw new InvalidOperationException($"config param {entry.Key} bounds are inverted");
                }
            }
            if (config.Bootstrap != null)
            {
                if (string.IsNullOrWhiteSpace(config.Bootstrap.Directory)
                    || string.IsNullOrWhiteSpace(config.Bootstrap.ProjectName)
                    || string.IsNullOrWhiteSpace(config.Bootstrap.DeviceOrderNumber)
                    || string.IsNullOrWhiteSpace(config.Bootstrap.DeviceName)
                    || string.IsNullOrWhiteSpace(config.Bootstrap.DeviceVersion))
                {
                    throw new InvalidOperationException(
                        "config bootstrap requires directory, projectName, deviceOrderNumber, deviceName, and deviceVersion");
                }
            }
            config.Fake = config.Fake || forceFake;
            return config;
        }
    }
}
