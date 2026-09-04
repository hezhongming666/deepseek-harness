# Openness spec-loop

English | [中文](README.zh.md)

Optional Web overlay that mounts the [TIA Portal Openness spec-loop adapter](../../packages/spec-loop/provider-openness/README.md) and the model-facing `spec_loop` tool, so the agent can run bounded parameter-search loops against a TIA Portal V21 project through the Openness bridge.

## Prerequisites

- A Windows host with TIA Portal V21 and the Openness API installed, plus a project TIA can open. Build and start the bridge as described in the [bridge README](../../packages/spec-loop/provider-openness/bridge/README.md) (use `--fake` for a wiring-only demo without TIA). The real actions need a **STEP 7 Basic/Professional license** in the Automation License Manager pool and a project with a PLC (the bridge's `bootstrap` config creates one automatically).
- The bridge reachable at `OPENNESS_BRIDGE_URL` (default `http://127.0.0.1:4279`).

## Run

```sh
OPENNESS_BRIDGE_URL=http://127.0.0.1:4279 dsh web --patch examples/openness-spec-loop/cordis.yml
```

## Try it

Ask the agent to run one `spec_loop` call with a spec over the bridge's shipped action — candidate parameters write PLC tag start values, the bridge compiles, and the loop minimizes compile errors. For the example config's `coolingTimeMs`/`threshold` bindings:

```json
{
  "id": "compile-clean",
  "objective": { "path": "compileErrors", "direction": "minimize" },
  "assertions": [{ "id": "errors", "path": "compileErrors", "predicate": "lte", "target": 0 }],
  "budgets": { "maxIterations": 8 },
  "repair": { "margin": 1, "maxNoImprovement": 3 },
  "envelope": { "bounds": { "coolingTimeMs": { "min": 0, "max": 60000 }, "threshold": { "min": 0, "max": 100 } } },
  "description": "coolingTimeMs and threshold are PLC tag start values set before the compile."
}
```

One call runs the whole deterministic loop and returns the audit report; the model supplies only the spec and, optionally, a starting candidate. Without a reachable bridge every candidate reports an infrastructure (S3) verdict, so the wiring is observable even before TIA is set up.
