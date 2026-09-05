# Industrial-automation closed loop

English | [中文](README.zh.md)

Optional Web overlay that mounts the [industrial capability family](../../packages/industrial/README.md) over the shipped composition, so the agent can run an engineering loop with verify-as-gate discipline: `ia_verify` adjudicates every artifact with deterministic validators, `ia_project` drives the conveyor-line DAG, `ia_trace` keeps the requirement matrix and three-level impact analysis, `ia_gate` requests the six mandatory human gates, and `ia_knowledge` searches the standards/templates/cases libraries with citations.

## Run

```sh
dsh web --patch examples/industrial-ia/cordis.yml
```

Sites with a TIA Portal Openness bridge add the real-vendor compile channel on top (edit the `url` in the overlay first):

```sh
dsh web --patch examples/industrial-ia/cordis.yml --patch examples/industrial-ia/cordis.openness.yml
```

The same rows ship as the [`dsh-ia` bundle](../../packages/bundle/ia/README.md) for profiles that prefer bundle composition. To mount them persistently, list `@deepseek-ai/dsh-ia` in the profile's `dsh.profile.bundles` (and make the bundle resolvable from the profile's node_modules, e.g. a junction into the checkout).

## Smoke

After the overlay or bundle is mounted, verify the closed loop end to end without a model call:

```sh
pnpm exec tsx examples/industrial-ia/smoke.mjs
```

The smoke boots the real Loader over the six rows and checks tool registration, a verification pass/fail pair, the mandatory-gate roster, the conveyor-line template, and the request-only gate schema. A second boot mounts the openness compile verifier over a local fake bridge and proves the vendor channel: `tia-compile` registers, adjudicates TIA SCL through the bridge wire protocol, and joins the conveyor-line control-program verifier roster.

## Try it

Ask the agent to verify a Structured Text program:

```
Run ia_verify with kind st-syntax on this program:
PROGRAM Conveyor
VAR
  Start : BOOL;
  Count : INT := 0;
END_VAR
IF Start THEN
  Count := Count + 1;
END_IF
END_PROGRAM
```

Then drive one full stage chain: `ia_project init`, submit the requirements artifact, ask the human to approve the pending `requirement-baseline` gate, and continue stage by stage. The control-program stage refuses artifacts that fail `st-syntax`/`st-lint` — plus `tia-compile` when the openness overlay is mounted — retries within the three-submission inner loop, and escalates with a packaged report when the budget is exhausted. `ia_trace matrix` shows which requirements still lack an implementation and a test. When `tia-compile` is mounted, submit both dialects: `text` carries the harness `PROGRAM` source for the local checks and `vendorSource` carries the TIA SCL block (`FUNCTION`/`FUNCTION_BLOCK`, named after the configured `blockName`) for the real compile.

The keyless Loader composition that boots this overlay's rows is proven by the [tool-ia loader test](../../packages/industrial/tool-ia/tests/loader-composition.spec.ts); no external engineering software is required — the deterministic validators run locally.
