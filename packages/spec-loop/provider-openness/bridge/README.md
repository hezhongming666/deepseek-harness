# OpennessBridge — TIA Portal Openness HTTP JSON bridge

English | [中文](README.zh.md)

The bridge process behind `@deepseek-ai/dsh-provider-openness`: a Windows host that keeps one TIA Portal V21 project open and serves the [adapter's HTTP JSON protocol](../README.md#the-wire-protocol) on 127.0.0.1. The adapter either connects to a running bridge (`url` mode) or owns one via `spawn` mode.

## What it does

- `GET /health` — readiness plus the environment tuple (`softwareVersion`, `osKernel`).
- `POST /validate` — the cheap S1 gate: parameter keys and inclusive numeric bounds against the config; no compile, no project writes.
- `POST /run` — the shipped action: write each parameter to its bound tag's start value, compile the PLC, and report `{ compileErrors, compileWarnings, compileMs }`. Compile wall time is also reported as `licenseMs` (the license-consuming span the bridge can measure).
- `POST /cancel` — best effort: an in-flight Openness call cannot be preempted, so the bridge drops the result when the cancelled run settles.

Runs are serialized (HTTP 409 when one is in flight); host outages surface as HTTP 503, which the adapter classifies as S3.

## Prerequisites for the real host

- The Windows user running the bridge must be a member of the local group **`Siemens TIA Openness`** (`net localgroup "Siemens TIA Openness" <user> /add`). The membership reaches a process only through a fresh logon: after adding the user, log off and back on before starting the bridge.
- The bridge resolves `Siemens.Engineering.*` at runtime from the installed TIA Portal through the official `Siemens.Collaboration.Net.TiaPortal.Openness.Resolver` packages; Copy Local stays off for the Openness assemblies (TIA's own loader rejects local copies).
- TIA Portal V21 and its Openness option must be installed, with a license covering the project operations the run action performs.

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

The default `OpennessApiDir` matches the standard V21 install layout; adjust it to the machine. The Openness host (`OpennessHost.cs`) compiles only in the full build; its API usage compiles against the real V21 reference assemblies, while the runtime write-back and compile paths are smoke-tested on the deployment machine against a project copy.

## Run

```sh
OpennessBridge.exe --config bridge.example.json          # real host, needs TIA + a project
OpennessBridge.exe --fake --config bridge.example.json   # deterministic fake, any Windows machine
OpennessBridge.exe --config bridge.json --list-devices   # print device items (pick the `device` value)
OpennessBridge.exe --config bridge.json --list-tags      # print PLC tags (write the `params` map)
```

On startup the bridge prints exactly one stdout line — `{"event":"listening","url":"http://127.0.0.1:<port>"}` — which the adapter's spawn mode waits for. Config fields: `port` (0 discovers a free port), `projectPath`, `mode` (`WithoutUserInterface` | `WithUserInterface`), `device` (empty selects the first device with PLC software), `params` (parameter key → `{ tag, min, max }` tag bindings). Openness programs need a matching TIA Portal installation and a license for the project operations the run action performs.

## Shipped action

The parameter domain is deployment-defined through the config's `params` map: each parameter key binds to one PLC tag path, and a run writes the candidate's numeric values into those tags' start values before compiling. The demo spec for this action asserts `compileErrors lte 0` and minimizes `compileErrors`. Deployments that need a different action (technology-object sweeps, export settings) extend the C# host; the adapter and the protocol stay unchanged.
