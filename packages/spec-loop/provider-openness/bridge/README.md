# OpennessBridge — TIA Portal Openness HTTP JSON bridge

English | [中文](README.zh.md)

The bridge process behind `@deepseek-ai/dsh-provider-openness`: a Windows host that keeps one TIA Portal V21 project open and serves the [adapter's HTTP JSON protocol](../README.md#the-wire-protocol) on 127.0.0.1. The adapter either connects to a running bridge (`url` mode) or owns one via `spawn` mode.

## What it does

- `GET /health` — readiness plus the environment tuple (`softwareVersion`, `osKernel`).
- `POST /validate` — the cheap S1 gate: parameter keys and inclusive numeric bounds against the config; no compile, no project writes.
- `POST /run` — the shipped actions. `action: compile` (the default) writes each parameter to its bound global-DB member's start value, compiles the PLC, and reports `{ compileErrors, compileWarnings, compileMessages, compileMs }`. `action: online` writes the same start values, downloads the software to the simulation target, goes online, and reports `{ downloadState, downloadMessages, onlineValues, readMs, downloadMs }`. `action: generate` renders the config SCL template (replacing each `{{param}}` placeholder with the candidate's numeric value), imports/replaces the named block, compiles, and reports the compile fields plus `blockName`. `action: import` renders the config Openness XML template (same `{{param}}` placeholder rule), imports it into the target composition, compiles, and reports the compile fields plus `importedTarget`. `action: export` writes the first engineering object of the target kind to an XML file and reports `{ exportPath, exportMs }`. The measured wall span is reported as `licenseMs` (the license-consuming span the bridge can measure).
- `POST /cancel` — best effort: an in-flight Openness call cannot be preempted, so the bridge drops the result when the cancelled run settles.

Runs are serialized (HTTP 409 when one is in flight); host outages surface as HTTP 503, which the adapter classifies as S3.

## Prerequisites for the real host

- The Windows user running the bridge must be a member of the local group **`Siemens TIA Openness`** (`net localgroup "Siemens TIA Openness" <user> /add`). The membership reaches a process only through a fresh logon: after adding the user, log off and back on before starting the bridge.
- The bridge resolves `Siemens.Engineering.*` at runtime from the installed TIA Portal through the official `Siemens.Collaboration.Net.TiaPortal.Openness.Resolver` packages; Copy Local stays off for the Openness assemblies (TIA's own loader rejects local copies).
- TIA Portal V21 and its Openness option must be installed. Creating a device and compiling needs a **STEP 7 Basic/Professional license** in the Automation License Manager pool (a TIA Portal trial license also satisfies it); without one, `CreateWithItem` and compile fail with `LicenseNotFoundException`.
- The run action's project needs a PLC device: configure `bootstrap` to create one automatically, or point `projectPath` at an existing project that contains one.
- The `online` action downloads to a simulated CPU and reads back online values, so it needs S7-PLCSIM (V21) installed and the classic `PLCSIM` interface available; a physical PLC is not required.

## Build

TIA Portal Openness is a Windows-only, in-process .NET API. Two build profiles exist:

```sh
# Protocol layer + deterministic fake host — no TIA Portal needed. This is
# what the repo gates can build anywhere.
dotnet build OpennessBridge.csproj -c Release

# Full build against the installed TIA Portal V21 Openness API. TIA V21 ships
# the API as split per-domain assemblies under the net48 folder.
dotnet build OpennessBridge.csproj -c Release -p:WithOpenness=true ^
  -p:OpennessApiDir="C:\Program Files\Siemens\Automation\Portal V21\PublicAPI\V21\net48"
```

The default `OpennessApiDir` matches the standard V21 install layout; adjust it to the machine. The Openness host (`OpennessHost.cs`) compiles only in the full build; its API usage compiles against the real V21 reference assemblies, while the runtime write-back, compile, download, online-read, and block-generation paths are smoke-tested on the deployment machine against a project copy.

## Run

```sh
OpennessBridge.exe --config bridge.example.json          # real host, needs TIA + a project
OpennessBridge.exe --fake --config bridge.example.json   # deterministic fake, any Windows machine
OpennessBridge.exe --config bridge.json --list-devices   # print device items (pick the `device` value)
OpennessBridge.exe --config bridge.json --list-tags      # print PLC tags (write the `params` map)
OpennessBridge.exe --config bridge.json --find-device "1214C"  # catalog lookup (type identifiers)
```

On startup the bridge prints exactly one stdout line — `{"event":"listening","url":"http://127.0.0.1:<port>"}` — which the adapter's spawn mode waits for. Config fields: `port` (0 discovers a free port), `projectPath`, `mode` (`WithoutUserInterface` | `WithUserInterface`), `device` (empty selects the first device with PLC software), `action` (`compile` | `online` | `generate` | `import` | `export`, default `compile`), `simulation` (`modeName`, `interfaceName`, `interfaceNumber`, `targetInterface` — the S7-PLCSIM target used by the `online` action; an empty `targetInterface` selects the first available), `generate` (`blockName`, `source` — the SCL template used by the `generate` action), `import` (`target` — `software` | `blocks` | `tagTables`, `source` — Openness XML), `export` (`target`, `directory`), `params` (parameter key → `{ block, member, min, max }` global-DB member bindings; the `generate`/`import`/`export` actions use only `min`/`max`), and the optional `bootstrap` block (`directory`, `projectName`, `deviceOrderNumber`, `deviceName`, `deviceVersion`) that creates a folder-based project with a PLC device when `projectPath` does not exist. Openness programs need a matching TIA Portal installation and a license for the project operations the run action performs.

## Shipped actions

The parameter domain is deployment-defined through the config's `params` map: each parameter key binds to one global data block member, and a run writes the candidate's numeric values into those members' start values (V21's dynamic `StartValue` attribute).

- `action: compile` (default) — compiles the PLC and reports error/warning counts. The demo spec for this action asserts `compileErrors lte 0` and minimizes `compileErrors`.
- `action: online` — downloads the software to the S7-PLCSIM target, goes online, and reads back each bound member's current value through V21's dynamic `OnlineValue` attribute. It reports `{ downloadState, downloadMessages, onlineValues, readMs, downloadMs }` and maps download/online failures to a `diverged` status with a clear `error`. V21 has no `SetInterfaceToPlcsim()` helper: the target is resolved through the connection configuration's `PLCSIM` PC interface (number 1 by default), as documented in the Openness manual; `simulation` overrides those names. The download callbacks handle the standard stop / consistent / all-blocks / target / reinitialization and start-module selections and fail closed on any unhandled configuration.
- `action: generate` — renders `generate.source` (SCL text whose `{{param}}` placeholders are replaced by that param's numeric candidate value, invariant culture), imports/replaces the named block, then compiles and reports the compile fields plus `blockName`. The template travels V21's external-source route (`ExternalSourceGroup.ExternalSources.CreateFromFile` then `GenerateBlocksFromSource`), which accepts plain SCL text with no Openness XML wrapper and overwrites an existing block of the same name; the rendered text is written to a per-run temp file that is deleted after import. Unknown placeholders and import/compile failures map to `diverged`. For this action the `params` map supplies only the numeric `min`/`max` domain (`block`/`member` are not required).
- `action: import` — renders `import.source` (Openness-format XML whose `{{param}}` placeholders are replaced by that param's numeric candidate value), imports it into the target composition, then compiles and reports the compile fields plus `importedTarget`. V21 has no `ImportProvider`: import is the per-composition `Import(FileInfo, ImportOptions)` method — `BlockGroup.Blocks` for `blocks`, `TagTableGroup.TagTables` for `tagTables` — with `ImportOptions.Override` (replace existing). The `software` target has no V21 import method and fails with a clear infrastructure error. Unknown placeholders and import/compile failures map to `diverged`. For this action the `params` map supplies only `min`/`max`.
- `action: export` — exports the first engineering object of the target kind to `<directory>\openness-export-<target>-<runId>.xml` and reports `{ exportPath, exportMs }`. V21 has no `ExportProvider` and exports per-object (`PlcBlock.Export` / `PlcTagTable.Export` with `ExportOptions.WithDefaults`), so a group target exports its first object; the `software` target has no V21 export method. The directory is created when missing; export failures map to `diverged`. This is a utility round-trip companion for the `import` action, not a numeric search target.

### V21 import XML format (worked example)

The `import` action consumes the Openness `<Document>` export format; run `action: export` once to capture the exact shape for a project. A minimal tag table with a single `Int` tag (V21 format — attribute spelling is deployment-defined, confirm by exporting):

```xml
<?xml version="1.0" encoding="utf-8"?>
<Document>
  <SW.Tags.PlcTagTable ID="0">
    <AttributeList>
      <Name>Diag</Name>
    </AttributeList>
    <ObjectList>
      <SW.Tags.PlcTag ID="1">
        <AttributeList>
          <Name>counter</Name>
          <DataTypeName>Int</DataTypeName>
          <LogicalAddress>%MW0</LogicalAddress>
          <Comment><MultiLanguageText Lang="en-US">cycle counter</MultiLanguageText></Comment>
        </AttributeList>
      </SW.Tags.PlcTag>
    </ObjectList>
  </SW.Tags.PlcTagTable>
</Document>
```

Blocks and DBs use the same `<Document>` wrapper (`<SW.Blocks.GlobalDB>` in place of `<SW.Tags.PlcTagTable>`). `import.source` placeholders follow the same `{{param}}` rule, so `{{threshold}}` inside the XML is replaced by the candidate's numeric value.

Deployments that need a different action (technology-object sweeps, export settings) extend the C# host; the adapter and the protocol stay unchanged.
