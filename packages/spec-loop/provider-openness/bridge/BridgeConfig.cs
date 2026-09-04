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
    /// The simulation target for the <c>online</c> action. V21 has no
    /// <c>SetInterfaceToPlcsim()</c> helper: the connection configuration
    /// names the PLCSIM PC interface directly, so the bridge resolves the
    /// target through <c>Modes.Find(ModeName).PcInterfaces.Find(InterfaceName,
    /// InterfaceNumber)</c>. An empty <see cref="TargetInterface"/> selects the
    /// first target interface on that PC interface.
    /// </summary>
    public sealed class SimulationConfig
    {
        /// <summary>Connection mode name, e.g. <c>PN/IE</c>.</summary>
        public string ModeName { get; set; } = "PN/IE";

        /// <summary>PC interface name, e.g. <c>PLCSIM</c> (the classic S7-PLCSIM interface).</summary>
        public string InterfaceName { get; set; } = "PLCSIM";

        /// <summary>PC interface number; classic S7-PLCSIM is number 1.</summary>
        public int InterfaceNumber { get; set; } = 1;

        /// <summary>Target interface (slot) name; empty selects the first available.</summary>
        public string TargetInterface { get; set; } = string.Empty;
    }

    /// <summary>
    /// The <c>generate</c> action's SCL template: <see cref="BlockName"/> names
    /// the block the source declares, and <see cref="Source"/> is SCL text in
    /// which each <c>{{paramKey}}</c> placeholder is replaced by that param's
    /// numeric candidate value before import. The template travels the
    /// external-source route (plain SCL, no Openness XML wrapper).
    /// </summary>
    public sealed class GenerateConfig
    {
        /// <summary>Name of the block the SCL source declares.</summary>
        public string BlockName { get; set; } = string.Empty;

        /// <summary>SCL source text with <c>{{paramKey}}</c> placeholders.</summary>
        public string Source { get; set; } = string.Empty;
    }

    /// <summary>
    /// The <c>import</c> action: <see cref="Target"/> names the composition the
    /// Openness-format XML is imported into, and <see cref="Source"/> is that
    /// XML with <c>{{paramKey}}</c> placeholders replaced by numeric candidate
    /// values before import. V21 exposes import as composition-level methods
    /// (<c>PlcBlockComposition.Import</c>, <c>PlcTagTableComposition.Import</c>),
    /// not a generic ImportProvider.
    /// </summary>
    public sealed class ImportConfig
    {
        /// <summary>Import target: <c>blocks</c> or <c>tagTables</c> (<c>software</c> is unsupported by V21).</summary>
        public string Target { get; set; } = string.Empty;

        /// <summary>Openness-format XML with <c>{{paramKey}}</c> placeholders.</summary>
        public string Source { get; set; } = string.Empty;
    }

    /// <summary>
    /// The <c>export</c> action: <see cref="Target"/> names the kind of
    /// engineering object to export, <see cref="ObjectName"/> selects one
    /// object of that kind (empty selects the first), and
    /// <see cref="Directory"/> receives the exported XML. V21 exposes export
    /// as object-level methods (<c>PlcBlock.Export</c>,
    /// <c>PlcTagTable.Export</c>).
    /// </summary>
    public sealed class ExportConfig
    {
        /// <summary>Export target: <c>blocks</c> or <c>tagTables</c> (<c>software</c> is unsupported by V21).</summary>
        public string Target { get; set; } = string.Empty;

        /// <summary>Name of the object to export; empty selects the first of the target kind.</summary>
        public string ObjectName { get; set; } = string.Empty;

        /// <summary>Destination directory for the exported XML file.</summary>
        public string Directory { get; set; } = string.Empty;
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

        /// <summary>
        /// The shipped run action: <c>compile</c> (write start values then
        /// compile; the default), <c>online</c> (write start values, download
        /// to the simulation target, go online, and read back online values),
        /// <c>generate</c> (render an SCL template, import the block, and
        /// compile), <c>import</c> (batch XML import into a composition, then
        /// compile), or <c>export</c> (XML export of an engineering object).
        /// </summary>
        public string Action { get; set; } = "compile";

        /// <summary>Simulation target settings; used only by the <c>online</c> action.</summary>
        public SimulationConfig Simulation { get; set; } = new SimulationConfig();

        /// <summary>
        /// Save the project after a successful run. Defaults to false (tuning
        /// attempts stay in the session); deployments whose action is a batch
        /// edit (e.g. import) set it true to persist the change.
        /// </summary>
        public bool Save { get; set; }

        /// <summary>SCL template settings; used only by the <c>generate</c> action.</summary>
        public GenerateConfig Generate { get; set; } = new GenerateConfig();

        /// <summary>Openness XML import settings; used only by the <c>import</c> action.</summary>
        public ImportConfig Import { get; set; } = new ImportConfig();

        /// <summary>Openness XML export settings; used only by the <c>export</c> action.</summary>
        public ExportConfig Export { get; set; } = new ExportConfig();

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
            if (config.Action != "compile" && config.Action != "online" && config.Action != "generate"
                && config.Action != "import" && config.Action != "export")
            {
                throw new InvalidOperationException("config action must be compile, online, generate, import, or export");
            }
            if (config.Action == "online")
            {
                var simulation = config.Simulation;
                if (simulation == null
                    || string.IsNullOrWhiteSpace(simulation.ModeName)
                    || string.IsNullOrWhiteSpace(simulation.InterfaceName)
                    || simulation.InterfaceNumber < 0)
                {
                    throw new InvalidOperationException(
                        "config simulation requires modeName, interfaceName, and a non-negative interfaceNumber");
                }
            }
            if (config.Action == "generate")
            {
                var generate = config.Generate;
                if (generate == null
                    || string.IsNullOrWhiteSpace(generate.BlockName)
                    || string.IsNullOrWhiteSpace(generate.Source))
                {
                    throw new InvalidOperationException(
                        "config generate requires non-empty blockName and source");
                }
            }
            if (config.Action == "import")
            {
                var import = config.Import;
                if (import == null
                    || !IsValidTarget(import.Target)
                    || string.IsNullOrWhiteSpace(import.Source))
                {
                    throw new InvalidOperationException(
                        "config import requires target software|blocks|tagTables and non-empty source");
                }
            }
            if (config.Action == "export")
            {
                var export = config.Export;
                if (export == null
                    || !IsValidTarget(export.Target)
                    || string.IsNullOrWhiteSpace(export.Directory))
                {
                    throw new InvalidOperationException(
                        "config export requires target software|blocks|tagTables and non-empty directory");
                }
            }
            foreach (var entry in config.Params)
            {
                if (string.IsNullOrWhiteSpace(entry.Key))
                {
                    throw new InvalidOperationException("config param keys must be non-empty strings");
                }
                if ((config.Action == "compile" || config.Action == "online")
                    && (string.IsNullOrWhiteSpace(entry.Value.Block) || string.IsNullOrWhiteSpace(entry.Value.Member)))
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

        /// <summary>The import/export target vocabulary shared by both actions.</summary>
        private static bool IsValidTarget(string target)
        {
            return target == "software" || target == "blocks" || target == "tagTables";
        }
    }
}
