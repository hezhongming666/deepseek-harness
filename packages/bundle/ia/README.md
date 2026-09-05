# @deepseek-ai/dsh-ia

English | [中文](README.zh.md)

The industrial-automation closed loop as an installable profile bundle: one patch layer inserting the deterministic verifier registry, the gate engine (A1), the traceability graph, the knowledge libraries, the conveyor-line orchestrator, and the model-facing tool surface. The package's substance is `cordis.patch.yml`, declared through the `dsh.bundle.patch` manifest field.

## Use

List the bundle in a profile's bundle set, or apply the same rows as an overlay:

```sh
dsh web --patch examples/industrial-ia/cordis.yml
```

## Rows

| id | Package |
|---|---|
| `ia-verifier` | `@deepseek-ai/dsh-ia-verifier` |
| `ia-gates` | `@deepseek-ai/dsh-ia-gates` (level `A1`) |
| `ia-trace` | `@deepseek-ai/dsh-ia-trace` |
| `ia-knowledge` | `@deepseek-ai/dsh-ia-knowledge` (minima 20/30, cap 10) |
| `ia-orchestrator` | `@deepseek-ai/dsh-ia-orchestrator` |
| `tool-ia` | `@deepseek-ai/dsh-tool-ia` |

Deployments raise the automation level to `A2` and register auto-release rules by patching the `ia-gates` row; the always-human gates never change with the level. The real-vendor compile verifier `@deepseek-ai/dsh-ia-verifier-openness` is deliberately not bundled: its bridge `url` is deployment-owned and required, so sites with a TIA Portal Openness bridge mount it through a profile patch or the `examples/industrial-ia/cordis.openness.yml` overlay.

## Model Experience

Indirectly, through dsh-tool-ia, which owns every model-facing surface this bundle mounts.

#### KV Cache effect

Independent. The bundle is a static patch carrier; the mounted packages own their KV-cache behavior as documented in their READMEs.

## Known Limitations and Deferred Work

- **Patch-only carrier** — the bundle ships no runtime glue of its own; every behavior lives in the mounted packages.
- **A1 by default** — raising the level is a deployment edit, never implicit; A2 rule registration remains a service API call.
