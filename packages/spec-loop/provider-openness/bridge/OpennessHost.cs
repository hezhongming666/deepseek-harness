#if WITH_OPENNESS
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using Siemens.Collaboration.Net;
using Siemens.Engineering;
using Siemens.Engineering.Compiler;
using Siemens.Engineering.HW;
using Siemens.Engineering.SW;
using Siemens.Engineering.SW.Tags;

namespace OpennessBridge
{
    /// <summary>
    /// The TIA Portal Openness host. Opens the configured project once and
    /// keeps the session warm across requests: validate checks parameter keys
    /// and bounds against the config (the cheap S1 gate), run writes each
    /// parameter to its bound tag's start value, compiles the PLC, and
    /// reports compile error/warning counts plus the compile wall time.
    ///
    /// This file compiles only with -p:WithOpenness=true against the
    /// installed TIA Portal V21 Openness API (see the csproj comment). API
    /// usage targets the V21 Openness manual; runtime behavior is verified on
    /// the deployment machine that hosts TIA Portal.
    /// </summary>
    internal sealed class OpennessHost : IOpennessHost
    {
        private readonly BridgeConfig config;
        private readonly object gate = new object();
        private static readonly object resolverGate = new object();
        private static IDisposable? resolverHandle;
        private TiaPortal? portal;
        private Project? project;
        private PlcSoftware? plcSoftware;

        public OpennessHost(BridgeConfig config)
        {
            this.config = config;
            // The resolver must hook before any method that references
            // Siemens.Engineering types is JIT-compiled: those methods fail to
            // load the assembly before their first instruction can run.
            EnsureResolver();
        }

        /// <summary>
        /// Hook the assembly resolver once: TIA's Siemens.Engineering.*
        /// assemblies live in the TIA install directory (Copy Local must stay
        /// false), so the resolver supplies them from the registry-derived
        /// PublicAPI path when the CLR probes for them.
        /// </summary>
        private static void EnsureResolver()
        {
            if (resolverHandle != null) return;
            lock (resolverGate)
            {
                resolverHandle ??= Api.Global.Openness().Initialize(null, null, null, 21);
            }
        }

        public Wire.HealthResponse Health()
        {
            try
            {
                var session = EnsureSession();
                return new Wire.HealthResponse
                {
                    Ok = true,
                    Environment = new Dictionary<string, string>
                    {
                        ["softwareVersion"] = $"OpennessBridge 0.1.0 over TIA Portal Openness {session.OpennessVersion}",
                        ["osKernel"] = Environment.OSVersion.VersionString,
                    },
                };
            }
            catch (Exception error)
            {
                return new Wire.HealthResponse { Ok = false, Error = error.Message };
            }
        }

        /// <summary>
        /// Print one `table/tag<TAB>dataType` line per PLC tag. This is the
        /// deployment diagnostic for writing the config's params map: the
        /// printed tag name is the `Find` argument the run action uses.
        /// </summary>
        /// <param name="output">The sink receiving the listing.</param>
        public void ListTags(TextWriter output)
        {
            var session = EnsureSession();
            foreach (var table in session.Software.TagTableGroup.TagTables)
            {
                foreach (var tag in table.Tags)
                {
                    output.WriteLine($"{table.Name}/{tag.Name}\t{tag.DataTypeName}");
                }
            }
        }

        /// <summary>
        /// Print one `device<TAB>itemType<TAB>itemName` line per device item.
        /// This is the deployment diagnostic for choosing the config's
        /// `device` value and locating the PLC software object.
        /// </summary>
        /// <param name="output">The sink receiving the listing.</param>
        public void ListDevices(TextWriter output)
        {
            var opened = EnsureProject();
            foreach (var device in opened.Devices)
            {
                foreach (var item in device.DeviceItems)
                {
                    output.WriteLine($"{device.Name}\t{item.GetType().FullName}\t{item.Name}");
                }
            }
        }

        public Wire.ValidateResponse Validate(IReadOnlyDictionary<string, JsonElement> parameters)
        {
            EnsureSession();
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
            Func<bool> cancelled)
        {
            var session = EnsureSession();
            if (cancelled())
            {
                return new Wire.RunResponse { RunId = runId, Status = "killed", Error = "cancelled before execution" };
            }
            foreach (var entry in parameters)
            {
                if (!config.Params.TryGetValue(entry.Key, out var binding))
                {
                    return new Wire.RunResponse
                    {
                        RunId = runId,
                        Status = "diverged",
                        Error = $"unknown parameter {JsonSerializer.Serialize(entry.Key)}",
                    };
                }
                if (entry.Value.ValueKind != JsonValueKind.Number || !entry.Value.TryGetDouble(out var value))
                {
                    return new Wire.RunResponse
                    {
                        RunId = runId,
                        Status = "diverged",
                        Error = $"parameter {JsonSerializer.Serialize(entry.Key)} must be a number",
                    };
                }
                var tag = FindTag(binding.Tag);
                if (tag == null)
                {
                    return new Wire.RunResponse
                    {
                        RunId = runId,
                        Status = "diverged",
                        Error = $"tag {JsonSerializer.Serialize(binding.Tag)} does not exist in PLC {session.Software.Name}",
                    };
                }
                try
                {
                    WriteTagStartValue(tag, value);
                }
                catch (Exception error)
                {
                    return new Wire.RunResponse
                    {
                        RunId = runId,
                        Status = "diverged",
                        Error = $"setting tag {JsonSerializer.Serialize(binding.Tag)} failed: {error.Message}",
                    };
                }
            }
            var stopwatch = Stopwatch.StartNew();
            CompilerResult compileResult;
            try
            {
                // V21 keeps the ICompilable seam; PlcSoftware implements it.
                // The runtime smoke on the deployment project confirms the
                // cast (the alternative is the CompileProvider service).
                compileResult = ((ICompilable)session.Software).Compile();
            }
            catch (Exception error)
            {
                return new Wire.RunResponse
                {
                    RunId = runId,
                    Status = "diverged",
                    Error = $"compile threw: {error.Message}",
                };
            }
            stopwatch.Stop();
            if (cancelled())
            {
                return new Wire.RunResponse { RunId = runId, Status = "killed", Error = "cancelled during execution" };
            }
            var compileMs = stopwatch.ElapsedMilliseconds;
            var errors = compileResult.ErrorCount;
            var warnings = compileResult.WarningCount;
            if (compileResult.State != CompilerResultState.Success)
            {
                return new Wire.RunResponse
                {
                    RunId = runId,
                    Status = "diverged",
                    Error = $"compile ended in state {compileResult.State} with {errors} error(s)",
                };
            }
            var result = new Dictionary<string, JsonElement>
            {
                ["compileErrors"] = JsonDocument.Parse(errors.ToString(CultureInfo.InvariantCulture)).RootElement.Clone(),
                ["compileWarnings"] = JsonDocument.Parse(warnings.ToString(CultureInfo.InvariantCulture)).RootElement.Clone(),
                ["compileMs"] = JsonDocument.Parse(compileMs.ToString(CultureInfo.InvariantCulture)).RootElement.Clone(),
            };
            return new Wire.RunResponse
            {
                RunId = runId,
                Status = "success",
                Result = result,
                // Compile wall time is the license-consuming span the bridge
                // can measure; license-pool accounting stays with the engine.
                LicenseMs = compileMs,
                Environment = session.Environment,
            };
        }

        public void Dispose()
        {
            lock (gate)
            {
                try
                {
                    project?.Close();
                }
                catch
                {
                    // Disposal is best effort; the OS reclaims the session.
                }
                try
                {
                    portal?.Dispose();
                }
                catch
                {
                    // Disposal is best effort; the OS reclaims the session.
                }
                portal = null;
                project = null;
                plcSoftware = null;
            }
            lock (resolverGate)
            {
                try
                {
                    resolverHandle?.Dispose();
                }
                catch
                {
                    // Disposal is best effort.
                }
                resolverHandle = null;
            }
        }

        private sealed class Session
        {
            public Session(Project project, PlcSoftware software, string opennessVersion, Dictionary<string, string> environment)
            {
                Project = project;
                Software = software;
                OpennessVersion = opennessVersion;
                Environment = environment;
            }

            public Project Project { get; }

            public PlcSoftware Software { get; }

            public string OpennessVersion { get; }

            public Dictionary<string, string> Environment { get; }
        }

        private Session EnsureSession()
        {
            lock (gate)
            {
                var opened = EnsureProject();
                plcSoftware ??= FindPlcSoftware(opened);
                if (plcSoftware == null)
                {
                    throw new InfrastructureException(
                        $"no PLC software found in project {JsonSerializer.Serialize(config.ProjectPath)}; "
                        + "run --list-devices to see the device items");
                }
                return new Session(
                    opened,
                    plcSoftware,
                    portal?.GetType().Assembly.GetName().Version?.ToString() ?? "unknown",
                    new Dictionary<string, string>
                    {
                        ["softwareVersion"] = $"TIA Portal Openness {portal?.GetType().Assembly.GetName().Version}",
                        ["osKernel"] = Environment.OSVersion.VersionString,
                    });
            }
        }

        /// <summary>Open the TIA session and the project once; PLC software is resolved separately.</summary>
        private Project EnsureProject()
        {
            if (project != null)
            {
                return project;
            }
            try
            {
                var mode = config.Mode == "WithUserInterface"
                    ? TiaPortalMode.WithUserInterface
                    : TiaPortalMode.WithoutUserInterface;
                var process = new TiaPortal(mode);
                var projectPath = new FileInfo(config.ProjectPath);
                if (!projectPath.Exists)
                {
                    process.Dispose();
                    throw new InfrastructureException(
                        $"project path {JsonSerializer.Serialize(config.ProjectPath)} does not exist");
                }
                var opened = process.Projects.Open(projectPath);
                portal = process;
                project = opened;
                return opened;
            }
            catch (InfrastructureException)
            {
                throw;
            }
            catch (Exception error)
            {
                Dispose();
                // ToString keeps the full exception chain: Openness
                // failures are usually type-initializer errors whose
                // inner exception names the missing dependency.
                throw new InfrastructureException($"opening the TIA Portal project failed: {error}", error);
            }
        }

        private PlcSoftware? FindPlcSoftware(Project opened)
        {
            Device? device = null;
            if (!string.IsNullOrWhiteSpace(config.Device))
            {
                device = opened.Devices.FirstOrDefault(candidate => candidate.Name == config.Device);
                if (device == null)
                {
                    throw new InfrastructureException(
                        $"device {JsonSerializer.Serialize(config.Device)} does not exist in the project");
                }
            }
            else
            {
                device = opened.Devices.FirstOrDefault(candidate => candidate.DeviceItems.OfType<PlcSoftware>().Any());
            }
            return device?.DeviceItems.OfType<PlcSoftware>().FirstOrDefault();
        }

        private PlcTag? FindTag(string path)
        {
            var software = plcSoftware;
            if (software == null)
            {
                return null;
            }
            foreach (var table in software.TagTableGroup.TagTables)
            {
                var tag = table.Tags.Find(path);
                if (tag != null)
                {
                    return tag;
                }
            }
            return null;
        }

        /// <summary>
        /// Write one numeric start value into a PLC tag. V21 edits engineering
        /// objects through their attribute seam: `SetAttribute("StartValue", …)`
        /// on the tag (the attribute name follows the SW.InterfaceSections_v5
        /// schema). The exact attribute name and accepted value form are
        /// smoke-tested on a project copy at deployment time.
        /// </summary>
        private static void WriteTagStartValue(PlcTag tag, double value)
        {
            tag.SetAttribute("StartValue", value.ToString(CultureInfo.InvariantCulture));
        }
    }
}
#endif
