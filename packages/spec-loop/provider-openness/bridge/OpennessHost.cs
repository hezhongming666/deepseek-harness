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
using Siemens.Engineering.HW.Features;
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
        /// false), so the resolver supplies them when the CLR probes. The TIA
        /// root is derived from the registry's Openness PublicAPI record —
        /// the resolver's own registry derivation assumes the standard layout
        /// and mis-resolves custom install drives.
        /// </summary>
        private static void EnsureResolver()
        {
            if (resolverHandle != null) return;
            lock (resolverGate)
            {
                if (resolverHandle != null) return;
                DirectoryInfo? tiaRoot = null;
                string? apiDir = null;
                var basePath = Microsoft.Win32.Registry.GetValue(
                    @"HKEY_LOCAL_MACHINE\SOFTWARE\Siemens\Automation\Openness\21.0\PublicAPI\21.0.0.0\net48",
                    "Siemens.Engineering.Base",
                    null) as string;
                if (!string.IsNullOrEmpty(basePath) && File.Exists(basePath))
                {
                    apiDir = Path.GetDirectoryName(basePath);
                    if (apiDir != null)
                    {
                        // apiDir is <TIA>\PublicAPI\V21\net48; three levels up names the TIA root.
                        tiaRoot = new DirectoryInfo(Path.GetFullPath(Path.Combine(apiDir, "..", "..", "..")));
                    }
                }
                if (apiDir != null)
                {
                    // The official resolver does not reliably cover the split
                    // Siemens.Engineering.* assemblies on custom installs, so
                    // this fallback loads them straight from the recorded
                    // PublicAPI directory.
                    AppDomain.CurrentDomain.AssemblyResolve += (_, args) =>
                    {
                        var name = new System.Reflection.AssemblyName(args.Name).Name;
                        if (name == null || !name.StartsWith("Siemens.Engineering", StringComparison.Ordinal))
                        {
                            return null;
                        }
                        var candidate = Path.Combine(apiDir, name + ".dll");
                        return File.Exists(candidate)
                            ? System.Reflection.Assembly.LoadFrom(candidate)
                            : null;
                    };
                }
                resolverHandle ??= Api.Global.Openness().Initialize(tiaRoot, null, null, 21);
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

        /// <summary>
        /// Print each device item's composition tree, marking PlcSoftware and
        /// ICompilable objects: the diagnostic for locating the compile target
        /// in V21's engineering-object model.
        /// </summary>
        /// <param name="output">The sink receiving the listing.</param>
        public void ProbeSoftware(TextWriter output)
        {
            var opened = EnsureProject();
            ProbeNode(output, "PROJECT", opened, 0);
            foreach (var device in opened.Devices)
            {
                ProbeNode(output, device.Name, device, 0);
                foreach (var item in device.DeviceItems)
                {
                    ProbeNode(output, $"{device.Name}/{item.Name}", item, 0);
                }
            }
        }

        /// <summary>Print one engineering object plus its composition tree, one level deep.</summary>
        private static void ProbeNode(TextWriter output, string path, IEngineeringObject node, int depth)
        {
            output.WriteLine(
                $"{path}: {node.GetType().FullName}"
                + $" PlcSoftware={node is PlcSoftware} ICompilable={node is ICompilable}");
            if (depth >= 3)
            {
                return;
            }
            foreach (var info in node.GetCompositionInfos())
            {
                object value;
                try
                {
                    value = node.GetComposition(info.Name);
                }
                catch (Exception error)
                {
                    output.WriteLine($"  {info.Name}: threw {error.Message}");
                    continue;
                }
                if (value == null)
                {
                    output.WriteLine($"  {info.Name}: null");
                    continue;
                }
                if (value is System.Collections.IEnumerable entries && value is not string)
                {
                    var count = 0;
                    foreach (var entry in entries)
                    {
                        if (entry is IEngineeringObject child)
                        {
                            ProbeNode(output, $"{path}/{info.Name}[{count}]", child, depth + 1);
                        }
                        else
                        {
                            output.WriteLine($"  {info.Name}[{count}]: {entry.GetType().FullName}");
                        }
                        count += 1;
                        if (count >= 6)
                        {
                            output.WriteLine($"  ({info.Name} has more entries)");
                            break;
                        }
                    }
                }
                else if (value is IEngineeringObject child)
                {
                    ProbeNode(output, $"{path}/{info.Name}", child, depth + 1);
                }
                else
                {
                    output.WriteLine($"  {info.Name}: {value.GetType().FullName}");
                }
            }
        }

        /// <summary>
        /// Print every hardware-catalog entry whose article number or type name
        /// contains the query. This is the deployment diagnostic for finding
        /// the type identifier CreateWithItem needs.
        /// </summary>
        /// <param name="output">The sink receiving the listing.</param>
        /// <param name="query">Substring matched against article numbers and type names.</param>
        public void FindDevices(TextWriter output, string query)
        {
            var opened = EnsureProject();
            var catalog = FindCatalogObject(output, portal!);
            catalog ??= FindCatalogObject(output, opened);
            if (catalog == null)
            {
                throw new InfrastructureException("no hardware-catalog composition found on the portal or project");
            }
            var compositions = ((IEngineeringObject)catalog).GetCompositionInfos().ToList();
            output.WriteLine($"catalog {catalog.GetType().FullName}: {compositions.Count} compositions");
            var typedCatalog = (Siemens.Engineering.HW.HardwareCatalog.HardwareCatalog)catalog;
            var matched = 0;
            foreach (var probe in ProbeKeys(query))
            {
                IList<Siemens.Engineering.HW.HardwareCatalog.CatalogEntry> found;
                try
                {
                    found = typedCatalog.Find(probe);
                }
                catch
                {
                    // A key form the catalog rejects; try the next one.
                    continue;
                }
                foreach (var entry in found)
                {
                    matched += 1;
                    output.WriteLine(
                        $"{entry.TypeName}\t{entry.ArticleNumber}\t{entry.Version}\t{entry.TypeIdentifier}\t{entry.CatalogPath}");
                }
            }
            output.WriteLine($"matched {matched} entry/entries");
        }

        /// <summary>The key forms tried against the catalog's Find.</summary>
        private static IEnumerable<string> ProbeKeys(string query)
        {
            yield return query;
            yield return query.Replace("-", " ");
            yield return $"Controllers/SIMATIC S7-1200/CPU/{query}";
            yield return query.ToUpperInvariant();
        }

        /// <summary>Count devices by explicit enumeration (Linq extensions are shadowed here).</summary>
        private static int CountDevices(Project target)
        {
            var count = 0;
            foreach (var _ in target.Devices)
            {
                count += 1;
            }
            return count;
        }

        /// <summary>Locate the hardware catalog through the engineering-object composition seam.</summary>
        private static object? FindCatalogObject(TextWriter output, IEngineeringObject root)
        {
            foreach (var composition in root.GetCompositionInfos())
            {
                try
                {
                    var value = root.GetComposition(composition.Name);
                    var type = value?.GetType();
                    if (type != null && type.FullName != null && type.FullName.Contains("HardwareCatalog"))
                    {
                        return value;
                    }
                }
                catch
                {
                    // Not every composition resolves on a fresh project; try the next one.
                }
            }
            return null;
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
                // V21 exposes compile through the ICompilable service on the
                // software object (see the Openness V21 project-data manual).
                var compilable = session.Software.GetService<ICompilable>();
                if (compilable == null)
                {
                    return new Wire.RunResponse
                    {
                        RunId = runId,
                        Status = "diverged",
                        Error = "the PLC software exposes no ICompilable service",
                    };
                }
                compileResult = compilable.Compile();
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
                    var inventory = new List<string>();
                    foreach (var device in opened.Devices)
                    {
                        foreach (var item in device.DeviceItems)
                        {
                            inventory.Add($"{device.Name}/{item.GetType().Name}/{item.Name}");
                        }
                    }
                    throw new InfrastructureException(
                        $"no PLC software found in project {JsonSerializer.Serialize(config.ProjectPath)}; "
                        + $"device items: [{string.Join(", ", inventory)}]");
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
                    if (config.Bootstrap == null)
                    {
                        process.Dispose();
                        throw new InfrastructureException(
                            $"project path {JsonSerializer.Serialize(config.ProjectPath)} does not exist "
                            + "(set config bootstrap to create a project with a PLC)");
                    }
                    var created = CreateBootstrapProject(process, config.Bootstrap);
                    portal = process;
                    project = created;
                    config.ProjectPath = Path.Combine(
                        config.Bootstrap.Directory,
                        config.Bootstrap.ProjectName,
                        $"{config.Bootstrap.ProjectName}.ap21");
                    return created;
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

        /// <summary>
        /// Create a folder-based project with the configured PLC device. A CPU
        /// order number also brings the device's PLC software along; the
        /// created project stays open in the session.
        /// </summary>
        private Project CreateBootstrapProject(TiaPortal process, BootstrapConfig bootstrap)
        {
            var directory = new DirectoryInfo(bootstrap.Directory);
            directory.Create();
            var created = process.Projects.Create(directory, bootstrap.ProjectName);
            try
            {
                var catalog = FindCatalogObject(TextWriter.Null, process)
                    ?? FindCatalogObject(TextWriter.Null, created);
                if (catalog == null)
                {
                    throw new InfrastructureException("the project exposes no hardware catalog");
                }
                var typedCatalog = (Siemens.Engineering.HW.HardwareCatalog.HardwareCatalog)catalog;
                var entry = typedCatalog.Find(bootstrap.DeviceOrderNumber)
                    .FirstOrDefault(candidate => candidate.ArticleNumber == bootstrap.DeviceOrderNumber
                        && candidate.Version == bootstrap.DeviceVersion);
                if (entry == null)
                {
                    throw new InfrastructureException(
                        $"the catalog has no entry for order number {bootstrap.DeviceOrderNumber} "
                        + $"version {bootstrap.DeviceVersion}; run --find-device <query> to list candidates");
                }
                var device = created.Devices.CreateWithItem(entry.TypeIdentifier, bootstrap.DeviceName, bootstrap.DeviceName);
                var countAfterCreate = CountDevices(created);
                created.Save();
                var countAfterSave = CountDevices(created);
                Console.Error.WriteLine(
                    $"bootstrap: devices after create={countAfterCreate}, after save={countAfterSave}");
                if (device == null || countAfterCreate == 0)
                {
                    throw new InfrastructureException(
                        $"device creation produced {countAfterCreate} device(s) for entry "
                        + $"{entry.TypeName} {entry.ArticleNumber} {entry.Version} ({entry.TypeIdentifier})");
                }
                return created;
            }
            catch
            {
                created.Close();
                throw;
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
                device = opened.Devices.FirstOrDefault(candidate => FindPlcSoftware(candidate) != null);
            }
            return device == null ? null : FindPlcSoftware(device);
        }

        /// <summary>
        /// V21 hosts software behind the SoftwareContainer service on the
        /// device item that carries it (the CPU); the walk recurses through
        /// child items per the Openness V21 project-data manual.
        /// </summary>
        private static PlcSoftware? FindPlcSoftware(Device device)
        {
            foreach (var item in EnumerateDeviceItems(device.DeviceItems))
            {
                var container = item.GetService<SoftwareContainer>();
                if (container?.Software is PlcSoftware software)
                {
                    return software;
                }
            }
            return null;
        }

        /// <summary>Depth-first device-item enumeration, children included.</summary>
        private static IEnumerable<DeviceItem> EnumerateDeviceItems(DeviceItemComposition items)
        {
            foreach (var item in items)
            {
                yield return item;
                foreach (var child in EnumerateDeviceItems(item.DeviceItems))
                {
                    yield return child;
                }
            }
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
