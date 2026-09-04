#if WITH_OPENNESS
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using Siemens.Collaboration.Net;
using Siemens.Engineering;
using Siemens.Engineering.Compiler;
using Siemens.Engineering.Connection;
using Siemens.Engineering.Download;
using Siemens.Engineering.HW;
using Siemens.Engineering.HW.Features;
using Siemens.Engineering.Online;
using Siemens.Engineering.SW;
using Siemens.Engineering.SW.Blocks;
using Siemens.Engineering.SW.Tags;
using DownloadConfigurations = Siemens.Engineering.Download.Configurations;

namespace OpennessBridge
{
    /// <summary>
    /// The TIA Portal Openness host. Opens the configured project once and
    /// keeps the session warm across requests: validate checks parameter keys
    /// and bounds against the config (the cheap S1 gate), run writes each
    /// parameter to its bound global-DB member's start value and then runs the
    /// configured action — <c>compile</c> (compile the PLC, report
    /// error/warning counts) or <c>online</c> (download to the simulation
    /// target, go online, read back online values).
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
        private DeviceItem? cpuDeviceItem;

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
        /// Print one tag's composition surface plus attribute names: the
        /// diagnostic for locating the tag value/start-value editor in V21.
        /// </summary>
        /// <param name="output">The sink receiving the listing.</param>
        /// <param name="tagName">The flat tag name from --list-tags.</param>
        public void ProbeTag(TextWriter output, string tagName)
        {
            var session = EnsureSession();
            foreach (var table in session.Software.TagTableGroup.TagTables)
            {
                var tag = table.Tags.Find(tagName);
                if (tag == null)
                {
                    continue;
                }
                output.WriteLine($"TAG {table.Name}/{tag.Name} type={tag.GetType().FullName} dataType={tag.DataTypeName}");
                output.WriteLine($"attributes: {string.Join(", ", tag.GetAttributeInfos().Select(info => info.Name))}");
                output.WriteLine($"services: {string.Join(", ", ((IEngineeringServiceProvider)tag).GetServiceInfos().Select(info => info.Type.FullName))}");
                output.WriteLine($"TABLE {table.Name} type={table.GetType().FullName}");
                output.WriteLine($"  table attrs: {string.Join(", ", table.GetAttributeInfos().Select(info => info.Name))}");
                output.WriteLine($"  table services: {string.Join(", ", ((IEngineeringServiceProvider)table).GetServiceInfos().Select(info => info.Type.FullName))}");
                output.WriteLine($"SOFTWARE {session.Software.Name} type={session.Software.GetType().FullName}");
                output.WriteLine($"  software services: {string.Join(", ", ((IEngineeringServiceProvider)session.Software).GetServiceInfos().Select(info => info.Type.FullName))}");
                foreach (var swInfo in ((IEngineeringObject)session.Software).GetCompositionInfos())
                {
                    output.WriteLine($"  software composition: {swInfo.Name}");
                }
                foreach (var tableInfo in ((IEngineeringObject)table).GetCompositionInfos())
                {
                    object tableValue;
                    try
                    {
                        tableValue = ((IEngineeringObject)table).GetComposition(tableInfo.Name);
                    }
                    catch (Exception error)
                    {
                        output.WriteLine($"  table {tableInfo.Name}: threw {error.Message}");
                        continue;
                    }
                    output.WriteLine($"  table {tableInfo.Name}: {tableValue?.GetType().FullName ?? "null"}");
                }
                foreach (var info in ((IEngineeringObject)tag).GetCompositionInfos())
                {
                    object value;
                    try
                    {
                        value = ((IEngineeringObject)tag).GetComposition(info.Name);
                    }
                    catch (Exception error)
                    {
                        output.WriteLine($"  {info.Name}: threw {error.Message}");
                        continue;
                    }
                    output.WriteLine($"  {info.Name}: {value?.GetType().FullName ?? "null"}");
                    if (value is IEngineeringObject child)
                    {
                        try
                        {
                            output.WriteLine($"    child attrs: {string.Join(", ", child.GetAttributeInfos().Select(a => a.Name))}");
                        }
                        catch (Exception attrError)
                        {
                            output.WriteLine($"    child attrs threw: {attrError.Message}");
                        }
                    }
                }
                return;
            }
            output.WriteLine($"no tag named {tagName}");
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
            if (config.Action == "generate")
            {
                return RunGenerate(runId, session, parameters, cancelled);
            }
            if (config.Action == "import")
            {
                return RunImport(runId, session, parameters, cancelled);
            }
            if (config.Action == "export")
            {
                return RunExport(runId, session, cancelled);
            }
            var writeError = WriteStartValues(runId, session, parameters);
            if (writeError != null)
            {
                return writeError;
            }
            return config.Action == "online"
                ? RunOnline(runId, session, cancelled)
                : RunCompile(runId, session, cancelled);
        }

        /// <summary>
        /// Validate every parameter against the config and write its value to
        /// the bound DB member's start value. Returns the diverged response on
        /// the first failure, or null when every parameter was written.
        /// </summary>
        private Wire.RunResponse? WriteStartValues(
            string runId,
            Session session,
            IReadOnlyDictionary<string, JsonElement> parameters)
        {
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
                var member = FindMember(session.Software, binding.Block, binding.Member);
                if (member == null)
                {
                    return new Wire.RunResponse
                    {
                        RunId = runId,
                        Status = "diverged",
                        Error = $"member {JsonSerializer.Serialize(binding.Block)}.{JsonSerializer.Serialize(binding.Member)} "
                            + $"does not exist in PLC {session.Software.Name}",
                    };
                }
                try
                {
                    // V21 exposes DB member start values as the dynamic
                    // StartValue attribute (see the Openness manual).
                    member.SetAttribute("StartValue", value.ToString(CultureInfo.InvariantCulture));
                }
                catch (Exception error)
                {
                    return new Wire.RunResponse
                    {
                        RunId = runId,
                        Status = "diverged",
                        Error = $"setting member {JsonSerializer.Serialize(binding.Block)}."
                            + $"{JsonSerializer.Serialize(binding.Member)} failed: {error.Message}",
                    };
                }
            }
            return null;
        }

        /// <summary>The shipped compile action: compile the PLC and report error/warning counts.</summary>
        private Wire.RunResponse RunCompile(string runId, Session session, Func<bool> cancelled)
        {
            var (failure, result, compileMs) = CompileSoftware(runId, session, cancelled);
            if (failure != null)
            {
                return failure;
            }
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

        /// <summary>
        /// Compile the PLC software and return the compile result fields plus
        /// the compile wall time, or a diverged/killed response on failure.
        /// Shared by the compile and generate actions.
        /// </summary>
        private (Wire.RunResponse? failure, Dictionary<string, JsonElement>? result, long compileMs) CompileSoftware(
            string runId,
            Session session,
            Func<bool> cancelled)
        {
            var stopwatch = Stopwatch.StartNew();
            CompilerResult compileResult;
            try
            {
                // V21 exposes compile through the ICompilable service on the
                // software object (see the Openness V21 project-data manual).
                var compilable = session.Software.GetService<ICompilable>();
                if (compilable == null)
                {
                    return (
                        new Wire.RunResponse
                        {
                            RunId = runId,
                            Status = "diverged",
                            Error = "the PLC software exposes no ICompilable service",
                        },
                        null,
                        0);
                }
                compileResult = compilable.Compile();
            }
            catch (Exception error)
            {
                return (
                    new Wire.RunResponse
                    {
                        RunId = runId,
                        Status = "diverged",
                        Error = $"compile threw: {error.Message}",
                    },
                    null,
                    0);
            }
            stopwatch.Stop();
            if (cancelled())
            {
                return (
                    new Wire.RunResponse { RunId = runId, Status = "killed", Error = "cancelled during execution" },
                    null,
                    0);
            }
            var compileMs = stopwatch.ElapsedMilliseconds;
            var errors = compileResult.ErrorCount;
            var warnings = compileResult.WarningCount;
            var messages = FlattenCompilerMessages(compileResult);
            if (compileResult.State != CompilerResultState.Success)
            {
                return (
                    new Wire.RunResponse
                    {
                        RunId = runId,
                        Status = "diverged",
                        Error = $"compile ended in state {compileResult.State} with {errors} error(s): "
                            + string.Join(" | ", messages),
                    },
                    null,
                    0);
            }
            var result = new Dictionary<string, JsonElement>
            {
                ["compileErrors"] = JsonDocument.Parse(errors.ToString(CultureInfo.InvariantCulture)).RootElement.Clone(),
                ["compileWarnings"] = JsonDocument.Parse(warnings.ToString(CultureInfo.InvariantCulture)).RootElement.Clone(),
                ["compileMs"] = JsonDocument.Parse(compileMs.ToString(CultureInfo.InvariantCulture)).RootElement.Clone(),
                ["compileMessages"] = JsonSerializer.SerializeToElement(messages),
            };
            return (null, result, compileMs);
        }

        /// <summary>Flatten the compiler result's nested messages into strings.</summary>
        private static List<string> FlattenCompilerMessages(CompilerResult result)
        {
            var messages = new List<string>();
            foreach (var message in result.Messages)
            {
                CollectCompilerMessages(message, messages);
            }
            return messages;
        }

        private static void CollectCompilerMessages(CompilerResultMessage message, List<string> messages)
        {
            messages.Add(string.IsNullOrEmpty(message.Path)
                ? message.Description
                : $"{message.Path}: {message.Description}");
            foreach (var child in message.Messages)
            {
                CollectCompilerMessages(child, messages);
            }
        }

        /// <summary>
        /// The shipped generate action: render the SCL template with the
        /// candidate's numeric values, import/replace the named block through
        /// the external-source route, then compile. Reports the compile fields
        /// plus the generated block name.
        /// </summary>
        private Wire.RunResponse RunGenerate(
            string runId,
            Session session,
            IReadOnlyDictionary<string, JsonElement> parameters,
            Func<bool> cancelled)
        {
            var generate = config.Generate;
            var total = Stopwatch.StartNew();

            string rendered;
            try
            {
                rendered = RenderTemplate(generate.Source, parameters);
            }
            catch (Exception error)
            {
                return new Wire.RunResponse
                {
                    RunId = runId,
                    Status = "diverged",
                    Error = error.Message,
                    Environment = session.Environment,
                };
            }
            if (cancelled())
            {
                return new Wire.RunResponse { RunId = runId, Status = "killed", Error = "cancelled during execution" };
            }

            var tempPath = Path.Combine(
                Path.GetTempPath(),
                $"openness-bridge-{SanitizeFileToken(generate.BlockName)}-{SanitizeFileToken(runId)}.scl");
            try
            {
                File.WriteAllText(tempPath, rendered);
                ImportExternalSource(session, generate.BlockName, tempPath);
            }
            catch (InfrastructureException)
            {
                throw;
            }
            catch (Exception error)
            {
                return new Wire.RunResponse
                {
                    RunId = runId,
                    Status = "diverged",
                    Error = $"generating block {JsonSerializer.Serialize(generate.BlockName)} failed: {error.Message}",
                    Environment = session.Environment,
                };
            }
            finally
            {
                try
                {
                    File.Delete(tempPath);
                }
                catch
                {
                    // Best-effort temp-file cleanup.
                }
            }
            if (cancelled())
            {
                return new Wire.RunResponse { RunId = runId, Status = "killed", Error = "cancelled during execution" };
            }

            var (failure, result, _) = CompileSoftware(runId, session, cancelled);
            if (failure != null)
            {
                return failure;
            }
            result!["blockName"] = JsonSerializer.SerializeToElement(generate.BlockName);
            total.Stop();
            return new Wire.RunResponse
            {
                RunId = runId,
                Status = "success",
                Result = result,
                LicenseMs = total.ElapsedMilliseconds,
                Environment = session.Environment,
            };
        }

        /// <summary>
        /// Replace every <c>{{paramKey}}</c> placeholder with that param's
        /// numeric candidate value (invariant culture). A placeholder whose key
        /// is not a declared param, or whose candidate value is missing or
        /// non-numeric, is a divergence.
        /// </summary>
        private string RenderTemplate(string template, IReadOnlyDictionary<string, JsonElement> parameters)
        {
            return Regex.Replace(template, @"\{\{([^{}]+?)\}\}", match =>
            {
                var key = match.Groups[1].Value.Trim();
                if (!config.Params.ContainsKey(key))
                {
                    throw new InvalidOperationException(
                        $"template placeholder {JsonSerializer.Serialize(key)} is not a declared parameter");
                }
                if (!parameters.TryGetValue(key, out var value)
                    || value.ValueKind != JsonValueKind.Number
                    || !value.TryGetDouble(out var number))
                {
                    throw new InvalidOperationException(
                        $"template placeholder {JsonSerializer.Serialize(key)} has no numeric candidate value");
                }
                return number.ToString(CultureInfo.InvariantCulture);
            });
        }

        /// <summary>
        /// Import the rendered SCL file as an external source and generate the
        /// block(s) from it. V21's external-source route takes plain SCL text
        /// (no Openness XML wrapper) and overwrites existing blocks with the
        /// same name. The external source object is deleted afterwards; the
        /// generated block remains in the block group.
        /// </summary>
        private void ImportExternalSource(Session session, string blockName, string tempPath)
        {
            var sources = session.Software.ExternalSourceGroup.ExternalSources;
            var stale = sources.Find(blockName);
            stale?.Delete();
            var source = sources.CreateFromFile(blockName, tempPath);
            try
            {
                source.GenerateBlocksFromSource();
            }
            finally
            {
                try
                {
                    source.Delete();
                }
                catch
                {
                    // Best-effort cleanup of the external source object.
                }
            }
            if (session.Software.BlockGroup.Blocks.Find(blockName) == null)
            {
                throw new InvalidOperationException(
                    $"block {JsonSerializer.Serialize(blockName)} was not generated from the source");
            }
        }

        /// <summary>Replace path-unsafe characters so a name can seed a temp-file name.</summary>
        private static string SanitizeFileToken(string value)
        {
            var invalid = Path.GetInvalidFileNameChars();
            var chars = new char[value.Length];
            for (var index = 0; index < value.Length; index += 1)
            {
                chars[index] = Array.IndexOf(invalid, value[index]) >= 0 ? '_' : value[index];
            }
            return new string(chars);
        }

        /// <summary>
        /// The shipped import action: render the Openness-format XML template
        /// with the candidate's numeric values, import it into the target
        /// composition, then compile. Reports the compile fields plus the
        /// imported target name.
        /// </summary>
        private Wire.RunResponse RunImport(
            string runId,
            Session session,
            IReadOnlyDictionary<string, JsonElement> parameters,
            Func<bool> cancelled)
        {
            var importConfig = config.Import;
            var total = Stopwatch.StartNew();

            string rendered;
            try
            {
                rendered = RenderTemplate(importConfig.Source, parameters);
            }
            catch (Exception error)
            {
                return new Wire.RunResponse
                {
                    RunId = runId,
                    Status = "diverged",
                    Error = error.Message,
                    Environment = session.Environment,
                };
            }
            if (cancelled())
            {
                return new Wire.RunResponse { RunId = runId, Status = "killed", Error = "cancelled during execution" };
            }

            var tempPath = Path.Combine(
                Path.GetTempPath(),
                $"openness-bridge-import-{SanitizeFileToken(importConfig.Target)}-{SanitizeFileToken(runId)}.xml");
            try
            {
                File.WriteAllText(tempPath, rendered);
                ImportXml(session, importConfig.Target, tempPath);
            }
            catch (InfrastructureException)
            {
                throw;
            }
            catch (Exception error)
            {
                return new Wire.RunResponse
                {
                    RunId = runId,
                    Status = "diverged",
                    Error = $"import into {JsonSerializer.Serialize(importConfig.Target)} failed: {error.Message}",
                    Environment = session.Environment,
                };
            }
            finally
            {
                try
                {
                    File.Delete(tempPath);
                }
                catch
                {
                    // Best-effort temp-file cleanup.
                }
            }
            if (cancelled())
            {
                return new Wire.RunResponse { RunId = runId, Status = "killed", Error = "cancelled during execution" };
            }

            var (failure, result, _) = CompileSoftware(runId, session, cancelled);
            if (failure != null)
            {
                return failure;
            }
            result!["importedTarget"] = JsonSerializer.SerializeToElement(importConfig.Target);
            total.Stop();
            return new Wire.RunResponse
            {
                RunId = runId,
                Status = "success",
                Result = result,
                LicenseMs = total.ElapsedMilliseconds,
                Environment = session.Environment,
            };
        }

        /// <summary>
        /// Import the Openness XML into the target composition. V21 has no
        /// ImportProvider: import is a per-composition method, and whole-software
        /// import does not exist.
        /// </summary>
        private void ImportXml(Session session, string target, string tempPath)
        {
            var file = new FileInfo(tempPath);
            switch (target)
            {
                case "blocks":
                    session.Software.BlockGroup.Blocks.Import(file, ImportOptions.Override);
                    return;
                case "tagTables":
                    session.Software.TagTableGroup.TagTables.Import(file, ImportOptions.Override);
                    return;
                case "software":
                    throw new InfrastructureException(
                        "V21 has no whole-software XML import; use target blocks or tagTables");
                default:
                    throw new InfrastructureException($"unknown import target {JsonSerializer.Serialize(target)}");
            }
        }

        /// <summary>
        /// The shipped export action: export the first engineering object of
        /// the target kind to an XML file (a utility round-trip companion for
        /// the import action, not a numeric search target).
        /// </summary>
        private Wire.RunResponse RunExport(string runId, Session session, Func<bool> cancelled)
        {
            var exportConfig = config.Export;
            var total = Stopwatch.StartNew();
            var filePath = Path.Combine(
                exportConfig.Directory,
                $"openness-export-{SanitizeFileToken(exportConfig.Target)}-{SanitizeFileToken(runId)}.xml");
            if (cancelled())
            {
                return new Wire.RunResponse { RunId = runId, Status = "killed", Error = "cancelled during execution" };
            }
            try
            {
                Directory.CreateDirectory(exportConfig.Directory);
                ExportXml(session, exportConfig.Target, filePath);
            }
            catch (InfrastructureException)
            {
                throw;
            }
            catch (Exception error)
            {
                return new Wire.RunResponse
                {
                    RunId = runId,
                    Status = "diverged",
                    Error = $"export failed: {error.Message}",
                    Environment = session.Environment,
                };
            }
            total.Stop();
            var result = new Dictionary<string, JsonElement>
            {
                ["exportPath"] = JsonSerializer.SerializeToElement(filePath),
                ["exportMs"] = JsonSerializer.SerializeToElement(total.ElapsedMilliseconds),
            };
            return new Wire.RunResponse
            {
                RunId = runId,
                Status = "success",
                Result = result,
                LicenseMs = total.ElapsedMilliseconds,
                Environment = session.Environment,
            };
        }

        /// <summary>
        /// Export the first object of the target kind to XML. V21 has no
        /// ExportProvider and exports per-object (no group or whole-software
        /// export), so a group target exports its first object.
        /// </summary>
        private void ExportXml(Session session, string target, string filePath)
        {
            var file = new FileInfo(filePath);
            switch (target)
            {
                case "blocks":
                {
                    var block = session.Software.BlockGroup.Blocks.FirstOrDefault();
                    if (block == null)
                    {
                        throw new InfrastructureException("no blocks to export");
                    }
                    block.Export(file, ExportOptions.WithDefaults);
                    return;
                }
                case "tagTables":
                {
                    var table = session.Software.TagTableGroup.TagTables.FirstOrDefault();
                    if (table == null)
                    {
                        throw new InfrastructureException("no tag tables to export");
                    }
                    table.Export(file, ExportOptions.WithDefaults);
                    return;
                }
                case "software":
                    throw new InfrastructureException(
                        "V21 has no whole-software XML export; use target blocks or tagTables");
                default:
                    throw new InfrastructureException($"unknown export target {JsonSerializer.Serialize(target)}");
            }
        }

        /// <summary>
        /// The shipped online action: write start values (done by the caller),
        /// download the software to the simulation target, go online, and read
        /// back the current online value of every bound DB member. Download and
        /// online-read failures map to diverged; the reported state/messages
        /// always reflect the download result.
        /// </summary>
        private Wire.RunResponse RunOnline(string runId, Session session, Func<bool> cancelled)
        {
            var total = Stopwatch.StartNew();
            DownloadResult download;
            try
            {
                download = DownloadToSimulation(session);
            }
            catch (InfrastructureException)
            {
                // Host-level (no provider, no PLCSIM interface): surface as
                // HTTP 503 like the existing action, not as a diverged run.
                throw;
            }
            catch (Exception error)
            {
                return new Wire.RunResponse
                {
                    RunId = runId,
                    Status = "diverged",
                    Error = $"download failed: {error.Message}",
                    LicenseMs = total.ElapsedMilliseconds,
                    Environment = session.Environment,
                };
            }
            var downloadMs = total.ElapsedMilliseconds;
            if (cancelled())
            {
                return new Wire.RunResponse { RunId = runId, Status = "killed", Error = "cancelled during execution" };
            }

            if (download.State == DownloadResultState.Error)
            {
                return new Wire.RunResponse
                {
                    RunId = runId,
                    Status = "diverged",
                    Error = $"download ended in state {download.State} with {download.ErrorCount} error(s)",
                    Result = BuildOnlineResult(download, new Dictionary<string, JsonElement>(), downloadMs, 0),
                    LicenseMs = total.ElapsedMilliseconds,
                    Environment = session.Environment,
                };
            }

            var readStopwatch = Stopwatch.StartNew();
            Dictionary<string, JsonElement> onlineValues;
            try
            {
                onlineValues = ReadOnlineValues(session);
            }
            catch (InfrastructureException)
            {
                // Host-level (no OnlineProvider, cannot go online): surface as
                // HTTP 503, not as a diverged run.
                throw;
            }
            catch (Exception error)
            {
                readStopwatch.Stop();
                return new Wire.RunResponse
                {
                    RunId = runId,
                    Status = "diverged",
                    Error = $"online read failed: {error.Message}",
                    Result = BuildOnlineResult(download, new Dictionary<string, JsonElement>(), downloadMs, readStopwatch.ElapsedMilliseconds),
                    LicenseMs = total.ElapsedMilliseconds,
                    Environment = session.Environment,
                };
            }
            readStopwatch.Stop();
            if (cancelled())
            {
                return new Wire.RunResponse { RunId = runId, Status = "killed", Error = "cancelled during execution" };
            }

            return new Wire.RunResponse
            {
                RunId = runId,
                Status = "success",
                Result = BuildOnlineResult(download, onlineValues, downloadMs, readStopwatch.ElapsedMilliseconds),
                LicenseMs = total.ElapsedMilliseconds,
                Environment = session.Environment,
            };
        }

        /// <summary>Assemble the online action's result object.</summary>
        private static Dictionary<string, JsonElement> BuildOnlineResult(
            DownloadResult download,
            Dictionary<string, JsonElement> onlineValues,
            long downloadMs,
            long readMs)
        {
            return new Dictionary<string, JsonElement>
            {
                ["downloadState"] = JsonSerializer.SerializeToElement(download.State.ToString()),
                ["downloadMessages"] = JsonSerializer.SerializeToElement(FlattenDownloadMessages(download)),
                ["onlineValues"] = JsonSerializer.SerializeToElement(onlineValues),
                ["downloadMs"] = JsonSerializer.SerializeToElement(downloadMs),
                ["readMs"] = JsonSerializer.SerializeToElement(readMs),
            };
        }

        /// <summary>
        /// Download the software to the configured simulation target. V21 has
        /// no SetInterfaceToPlcsim() helper: the target is the PLCSIM PC
        /// interface's target interface, resolved from the connection config.
        /// </summary>
        private DownloadResult DownloadToSimulation(Session session)
        {
            var provider = session.Cpu.GetService<DownloadProvider>();
            if (provider == null)
            {
                throw new InfrastructureException(
                    $"CPU device item {session.Cpu.Name} exposes no DownloadProvider service");
            }
            var target = ResolveSimulationTarget(provider.Configuration);
            return provider.Download(target, ConfigurePreDownload, ConfigurePostDownload, DownloadOptions.Software);
        }

        /// <summary>
        /// Resolve the simulation target interface through the connection
        /// configuration. Classic S7-PLCSIM is the PLCSIM PC interface
        /// (number 1); the target interface names the CPU slot, or the first
        /// available when the config leaves it empty.
        /// </summary>
        private ConfigurationTargetInterface ResolveSimulationTarget(ConnectionConfiguration connection)
        {
            var simulation = config.Simulation;
            var mode = connection.Modes.Find(simulation.ModeName);
            if (mode == null)
            {
                throw new InfrastructureException(
                    $"connection has no mode {JsonSerializer.Serialize(simulation.ModeName)}");
            }
            var pcInterface = mode.PcInterfaces.Find(simulation.InterfaceName, simulation.InterfaceNumber);
            if (pcInterface == null)
            {
                throw new InfrastructureException(
                    $"mode {simulation.ModeName} has no PC interface "
                    + $"{simulation.InterfaceName}/{simulation.InterfaceNumber}");
            }
            if (!string.IsNullOrWhiteSpace(simulation.TargetInterface))
            {
                var named = pcInterface.TargetInterfaces.Find(simulation.TargetInterface);
                if (named == null)
                {
                    throw new InfrastructureException(
                        $"PC interface {simulation.InterfaceName} has no target interface "
                        + $"{simulation.TargetInterface}");
                }
                return named;
            }
            var first = pcInterface.TargetInterfaces.FirstOrDefault();
            if (first == null)
            {
                throw new InfrastructureException(
                    $"PC interface {simulation.InterfaceName}/{simulation.InterfaceNumber} has no target interfaces");
            }
            return first;
        }

        /// <summary>
        /// Pre-download callback: select each recognized configuration's safe
        /// value and fail closed on any configuration this bridge has not
        /// reviewed. Classic S7-PLCSIM presents as a CPU target.
        /// </summary>
        private static void ConfigurePreDownload(DownloadConfigurations.DownloadConfiguration configuration)
        {
            switch (configuration)
            {
                case DownloadConfigurations.StopModules stop:
                    stop.CurrentSelection = DownloadConfigurations.StopModulesSelections.StopAll;
                    return;
                case DownloadConfigurations.ConsistentBlocksDownload consistent:
                    consistent.CurrentSelection = DownloadConfigurations.ConsistentBlocksDownloadSelections.ConsistentDownload;
                    return;
                case DownloadConfigurations.AllBlocksDownload all:
                    all.CurrentSelection = DownloadConfigurations.AllBlocksDownloadSelections.DownloadAllBlocks;
                    return;
                case DownloadConfigurations.TargetForSoftware target:
                    // Classic S7-PLCSIM presents itself as a CPU; S7-PLCSIM
                    // Advanced instances would use PlcSimulationAdvanced.
                    target.CurrentSelection = DownloadConfigurations.TargetForSoftwareSelections.CPU;
                    return;
                case DownloadConfigurations.DataBlockReinitialization reinit:
                    reinit.CurrentSelection = DownloadConfigurations.DataBlockReinitializationSelections.NoAction;
                    return;
                default:
                    throw new NotSupportedException(
                        $"download aborted: unhandled pre-download configuration {configuration.GetType().FullName}");
            }
        }

        /// <summary>Post-download callback: restart the module after a successful download.</summary>
        private static void ConfigurePostDownload(DownloadConfigurations.DownloadConfiguration configuration)
        {
            if (configuration is DownloadConfigurations.StartModules start)
            {
                start.CurrentSelection = DownloadConfigurations.StartModulesSelections.StartModule;
                return;
            }
            throw new NotSupportedException(
                $"download aborted: unhandled post-download configuration {configuration.GetType().FullName}");
        }

        /// <summary>
        /// Go online and read the current (online) value of every bound DB
        /// member via V21's dynamic OnlineValue attribute. The connection is
        /// only taken offline when this call established it. Cancellation is
        /// observed by the caller between the download and this read.
        /// </summary>
        private Dictionary<string, JsonElement> ReadOnlineValues(Session session)
        {
            var online = session.Cpu.GetService<OnlineProvider>();
            if (online == null)
            {
                throw new InfrastructureException(
                    $"CPU device item {session.Cpu.Name} exposes no OnlineProvider service");
            }
            if (!online.Configuration.IsConfigured)
            {
                online.Configuration.ApplyConfiguration(ResolveSimulationTarget(online.Configuration));
            }
            var connectedHere = online.State == OnlineState.Offline;
            var state = online.GoOnline();
            if (state != OnlineState.Online)
            {
                throw new InfrastructureException($"PLC ended in online state {state}");
            }
            try
            {
                var values = new Dictionary<string, JsonElement>();
                foreach (var entry in config.Params)
                {
                    var member = FindMember(session.Software, entry.Value.Block, entry.Value.Member);
                    if (member == null)
                    {
                        throw new InvalidOperationException(
                            $"member {entry.Value.Block}.{entry.Value.Member} does not exist in PLC {session.Software.Name}");
                    }
                    object? raw;
                    try
                    {
                        raw = member.GetAttribute("OnlineValue");
                    }
                    catch (Exception error)
                    {
                        throw new InvalidOperationException(
                            $"reading online value of {entry.Value.Block}.{entry.Value.Member} failed: {error.Message}");
                    }
                    values[entry.Key] = OnlineValueElement(raw);
                }
                return values;
            }
            finally
            {
                if (connectedHere)
                {
                    try
                    {
                        online.GoOffline();
                    }
                    catch
                    {
                        // Disposal of the connection is best effort.
                    }
                }
            }
        }

        /// <summary>Flatten the download result's nested messages into strings.</summary>
        private static List<string> FlattenDownloadMessages(DownloadResult result)
        {
            var messages = new List<string>();
            foreach (var message in result.Messages)
            {
                CollectDownloadMessages(message, messages);
            }
            return messages;
        }

        private static void CollectDownloadMessages(DownloadResultMessage message, List<string> messages)
        {
            messages.Add(message.Message);
            foreach (var child in message.Messages)
            {
                CollectDownloadMessages(child, messages);
            }
        }

        /// <summary>
        /// Convert the online value attribute to a JSON element. Numeric values
        /// (the parameter domain) are emitted as JSON numbers; anything else
        /// falls back to its invariant string form.
        /// </summary>
        private static JsonElement OnlineValueElement(object? raw)
        {
            if (raw == null)
            {
                return JsonSerializer.SerializeToElement<string?>(null);
            }
            var text = raw is IFormattable formattable
                ? formattable.ToString(null, CultureInfo.InvariantCulture)
                : raw.ToString();
            if (double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var number)
                && !double.IsNaN(number) && !double.IsInfinity(number))
            {
                return JsonSerializer.SerializeToElement(number);
            }
            return JsonSerializer.SerializeToElement(text ?? string.Empty);
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
                cpuDeviceItem = null;
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
            public Session(Project project, PlcSoftware software, DeviceItem cpu, string opennessVersion, Dictionary<string, string> environment)
            {
                Project = project;
                Software = software;
                Cpu = cpu;
                OpennessVersion = opennessVersion;
                Environment = environment;
            }

            public Project Project { get; }

            public PlcSoftware Software { get; }

            /// <summary>The CPU device item that carries the software; the download and online services live here.</summary>
            public DeviceItem Cpu { get; }

            public string OpennessVersion { get; }

            public Dictionary<string, string> Environment { get; }
        }

        private Session EnsureSession()
        {
            lock (gate)
            {
                var opened = EnsureProject();
                if (plcSoftware == null)
                {
                    var target = FindPlcTarget(opened);
                    if (target == null)
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
                    plcSoftware = target.Software;
                    cpuDeviceItem = target.Cpu;
                }
                return new Session(
                    opened,
                    plcSoftware,
                    cpuDeviceItem
                        ?? throw new InfrastructureException("no CPU device item resolved for the PLC software"),
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

        private PlcTarget? FindPlcTarget(Project opened)
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
                device = opened.Devices.FirstOrDefault(candidate => FindPlcTarget(candidate) != null);
            }
            return device == null ? null : FindPlcTarget(device);
        }

        /// <summary>
        /// V21 hosts software behind the SoftwareContainer service on the
        /// device item that carries it (the CPU); the walk recurses through
        /// child items per the Openness V21 project-data manual. The returned
        /// pair also carries the CPU item because V21 exposes the download and
        /// online providers on that item, not on the software object.
        /// </summary>
        private static PlcTarget? FindPlcTarget(Device device)
        {
            foreach (var item in EnumerateDeviceItems(device.DeviceItems))
            {
                var container = item.GetService<SoftwareContainer>();
                if (container?.Software is PlcSoftware software)
                {
                    return new PlcTarget(software, item);
                }
            }
            return null;
        }

        private sealed class PlcTarget
        {
            public PlcTarget(PlcSoftware software, DeviceItem cpu)
            {
                Software = software;
                Cpu = cpu;
            }

            public PlcSoftware Software { get; }

            public DeviceItem Cpu { get; }
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

        /// <summary>
        /// Find one global data block's interface member by name.
        /// </summary>
        private static Siemens.Engineering.SW.Blocks.Interface.Member? FindMember(
            PlcSoftware software,
            string blockName,
            string memberName)
        {
            foreach (var block in software.BlockGroup.Blocks)
            {
                if (block.Name != blockName)
                {
                    continue;
                }
                var dataBlock = block as DataBlock;
                return dataBlock?.Interface.Members.Find(memberName);
            }
            return null;
        }
    }
}
#endif
